import { readMeta, writeMeta } from './db'
import { HANDLES } from './handleRows'
import { KeyRange, type KvTx } from './kv/types'
import { isReadableSessionVersion } from './records/unknownValues'
import { nextTime, stampNow } from './time'

// Removing stored sessions and chains, and Delete's mark (deletion design §3.3, §3.4). The page
// locks every session of a chain first (R3); these transactions re-read what it locked and refuse
// when anything differs. Rows go by key range, so a session of a newer version needs no decoding.

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** The stores a removal writes. */
export const REMOVE_STORES = ['chains', 'sessions', 'entries', 'stackBlocks', HANDLES, 'meta']

/** A Delete mark (`chain.deleting`): its `at`, or `other` for a mark of a shape this build doesn't know. */
export const markOf = (chain: Row): number | 'other' | undefined => {
    const { deleting } = chain
    if (deleting === undefined) return
    return isRow(deleting) && typeof deleting.at === 'number' ? deleting.at : 'other'
}

/** A chain's sessions, oldest first. */
const sessionsOf = async (tx: KvTx, chainId: string) =>
    (await tx.index('sessions', 'chainId').getAll(chainId))
        .filter(isRow)
        .sort((a, b) => Number(a.startedAt) - Number(b.startedAt))

const ids = (rows: Row[]) => rows.map((row) => String(row.id))

const sameSet = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && new Set([...a, ...b]).size === a.length && new Set(a).size === a.length

export type RemoveRequest = {
    chainId: string
    /** The chain's sessions as the page read and locked them, oldest first. */
    locked: string[]
    /** Which of them to remove: all of them (`whole`), or the oldest `count`. */
    remove: { whole: true } | { whole: false; count: number }
    /** The chain as read: removal is refused when it changed since. */
    expect: { head: string; updatedAt: number; deleting?: number }
    /** `delete` removes only a chain carrying this mark; the others only an unmarked one. */
    reason: 'delete' | 'deleteSessions' | 'cleanup'
}

export type RemoveResult =
    | { kind: 'removed'; sessions: number }
    /** `nse-maint` is held or wanted: retry later. */
    | { kind: 'busy' }
    /** The chain, its sessions or its mark differ from what was locked. */
    | { kind: 'changed' }
    /** A session this build can't read, for a removal that is not a user's whole Delete. */
    | { kind: 'later' }

/**
 * The removal transaction (R4): whole sessions, with their entries and stack blocks, oldest first;
 * the chain's record and handles only with its last session. Newer data goes only by a user's
 * whole-chain Delete or Delete Sessions… (R7).
 */
export const removeTx = async (tx: KvTx, request: RemoveRequest): Promise<RemoveResult> => {
    const { chainId, locked, remove, expect, reason } = request
    const changed = { kind: 'changed' } as const
    const chain = await tx.get('chains', chainId)
    if (!isRow(chain) || chain.head !== expect.head || chain.updatedAt !== expect.updatedAt)
        return changed
    const mark = markOf(chain)
    if (mark !== expect.deleting || (reason === 'delete') !== (mark !== undefined)) return changed
    const rows = await sessionsOf(tx, chainId)
    if (!sameSet(ids(rows), locked)) return changed
    let removed = rows
    if (!remove.whole) {
        const { count } = remove
        if (!Number.isSafeInteger(count) || count < 1 || count >= rows.length) return changed
        const byId = new Map(rows.map((row) => [String(row.id), row]))
        removed = locked.slice(0, count).flatMap((id): Row[] => {
            const row = byId.get(id)
            return row ? [row] : []
        })
        const kept = rows.filter((row) => !removed.includes(row))
        // Only the oldest go: every removed session started before every kept one.
        const latest = Math.max(...removed.map((row) => Number(row.startedAt)))
        if (
            removed.some((row) => String(row.id) === chain.head) ||
            !kept.every((row) => Number(row.startedAt) > latest)
        )
            return changed
    }
    if (
        (!remove.whole || reason === 'cleanup') &&
        rows.some((row) => !isReadableSessionVersion(row.v))
    )
        return { kind: 'later' }
    for (const id of ids(removed)) {
        const range = KeyRange.bound([id, -Infinity], [id, Infinity])
        await tx.delete('entries', range)
        await tx.delete('stackBlocks', range)
        await tx.delete('sessions', id)
    }
    if (remove.whole) {
        await tx.delete(HANDLES, KeyRange.bound([chainId, ''], [chainId, '￿']))
        await tx.delete('chains', chainId)
    }
    await writeMeta(tx, 'deletionsPending', true)
    if (reason === 'cleanup') await writeMeta(tx, 'removedForSpace', true)
    return { kind: 'removed', sessions: removed.length }
}

/** What Delete reads of a chain before it locks it. */
export type DeleteTarget =
    { kind: 'gone' } | { kind: 'chain'; head: string; updatedAt: number; sessions: string[] }

/** A chain to Delete: gone when there is no record or it is marked already. */
export const readDeleteTarget = async (tx: KvTx, chainId: string): Promise<DeleteTarget> => {
    const chain = await tx.get('chains', chainId)
    if (!isRow(chain) || markOf(chain) !== undefined || typeof chain.head !== 'string')
        return { kind: 'gone' }
    return {
        kind: 'chain',
        head: chain.head,
        updatedAt: Number(chain.updatedAt),
        sessions: ids(await sessionsOf(tx, chainId)),
    }
}

export type MarkRequest = { chainId: string; sessions: string[]; head: string; wall: number }

export type MarkResult = { kind: 'marked'; at: number } | { kind: 'changed' } | { kind: 'gone' }

/** Delete's mark (§3.4): only on the chain the page locked, unmarked and unchanged since. */
export const markTx = async (tx: KvTx, request: MarkRequest): Promise<MarkResult> => {
    const chain = await tx.get('chains', request.chainId)
    if (!isRow(chain) || markOf(chain) !== undefined) return { kind: 'gone' }
    if (chain.head !== request.head) return { kind: 'changed' }
    if (!sameSet(ids(await sessionsOf(tx, request.chainId)), request.sessions))
        return { kind: 'changed' }
    const at = await stampNow(tx, request.wall)
    await tx.put('chains', { ...chain, deleting: { at } })
    return { kind: 'marked', at }
}

export type Mark = { chainId: string; at: number }

/** Undo (R9): clears a mark only while it is the one its Delete wrote. */
export const undoTx = async (tx: KvTx, marks: readonly Mark[]) => {
    const restored: string[] = []
    const lost: string[] = []
    for (const { chainId, at } of marks) {
        const chain = await tx.get('chains', chainId)
        if (!isRow(chain) || markOf(chain) !== at) {
            lost.push(chainId)
            continue
        }
        const { deleting: _deleting, ...rest } = chain
        await tx.put('chains', rest)
        restored.push(chainId)
    }
    return { restored, lost }
}

export type Marked = {
    chainId: string
    at: number
    head: string
    updatedAt: number
    sessions: string[]
}

/** The marked chains whose mark is at least `minAgeMs` old, by wall time past `maxSeenTime`. */
export const readMarked = async (
    tx: KvTx,
    { minAgeMs, wall }: { minAgeMs: number; wall: number },
): Promise<Marked[]> => {
    const now = nextTime((await readMeta(tx, 'maxSeenTime')) ?? 0, wall)
    const out: Marked[] = []
    for (const chain of await tx.getAll('chains')) {
        if (!isRow(chain) || typeof chain.head !== 'string') continue
        const at = markOf(chain)
        if (typeof at !== 'number' || now - at < minAgeMs) continue
        const chainId = String(chain.chainId)
        out.push({
            chainId,
            at,
            head: chain.head,
            updatedAt: Number(chain.updatedAt),
            sessions: ids(await sessionsOf(tx, chainId)),
        })
    }
    return out
}
