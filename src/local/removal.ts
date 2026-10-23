import { readMeta, writeMeta } from './db'
import { HANDLES } from './handleRows'
import { KeyRange, type KvTx } from './kv/types'
import { nextTime, stampNow } from './time'

// Removing stored sessions and chains, and Delete's mark (deletion design §3.3, §3.4). The page
// locks every session of a chain first (R3); these transactions re-read what it locked and refuse
// when anything differs. Rows go by key range, so a session of a newer version needs no decoding.

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** A chain's head session id; a damaged chain has none, and removal is then expected against none. */
const headIdOf = (chain: Row) => (typeof chain.head === 'string' ? chain.head : undefined)

/** The stores a removal writes. */
export const REMOVE_STORES = ['chains', 'sessions', 'entries', 'stackBlocks', HANDLES, 'meta']

/** A Delete mark (`chain.deleting`): its `at`, or `other` for a mark of a shape this build doesn't know. */
export const markOf = (chain: Row): number | 'other' | undefined => {
    const { deleting } = chain
    if (deleting === undefined) return
    return isRow(deleting) && typeof deleting.at === 'number' ? deleting.at : 'other'
}

/** A chain's sessions, oldest first. */
export const sessionsOf = async (tx: KvTx, chainId: string) =>
    (await tx.index('sessions', 'chainId').getAll(chainId))
        .filter(isRow)
        .sort((a, b) => Number(a.startedAt) - Number(b.startedAt))

export const ids = (rows: Row[]) => rows.map((row) => String(row.id))

const sameSet = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && new Set([...a, ...b]).size === a.length && new Set(a).size === a.length

export type RemoveRequest = {
    chainId: string
    /** The chain's sessions as the page read and locked them, oldest first. */
    locked: string[]
    /** The chain as read: removal is refused when it changed since. A damaged chain has no `head`. */
    expect: { head?: string; updatedAt: number; deleting?: number }
    /** `delete` removes only a chain carrying this mark; `deleteSessions` only an unmarked one. */
    reason: 'delete' | 'deleteSessions'
}

export type RemoveResult =
    | { kind: 'removed'; sessions: number }
    /** `nse-maint` is held or wanted: retry later. */
    | { kind: 'busy' }
    /** The chain, its sessions or its mark differ from what was locked. */
    | { kind: 'changed' }

/**
 * The removal transaction (R4): a whole chain, its sessions with their entries and stack blocks,
 * its record and its handles. Only a user's Delete or Delete Sessions… calls it, so a session of
 * a newer version goes too, by key range, unread (R7).
 */
export const removeTx = async (tx: KvTx, request: RemoveRequest): Promise<RemoveResult> => {
    const { chainId, locked, expect, reason } = request
    const changed = { kind: 'changed' } as const
    const chain = await tx.get('chains', chainId)
    if (!isRow(chain) || headIdOf(chain) !== expect.head || chain.updatedAt !== expect.updatedAt)
        return changed
    const mark = markOf(chain)
    if (mark !== expect.deleting || (reason === 'delete') !== (mark !== undefined)) return changed
    const rows = await sessionsOf(tx, chainId)
    if (!sameSet(ids(rows), locked)) return changed
    for (const id of ids(rows)) {
        const range = KeyRange.bound([id, -Infinity], [id, Infinity])
        await tx.delete('entries', range)
        await tx.delete('stackBlocks', range)
        await tx.delete('sessions', id)
    }
    await tx.delete(HANDLES, KeyRange.bound([chainId, ''], [chainId, '￿']))
    await tx.delete('chains', chainId)
    await writeMeta(tx, 'deletionsPending', true)
    return { kind: 'removed', sessions: rows.length }
}

/** What Delete reads of a chain before it locks it. */
export type DeleteTarget =
    { kind: 'gone' } | { kind: 'chain'; head?: string; updatedAt: number; sessions: string[] }

/**
 * A chain to Delete: gone when there is no record or it is marked already. A damaged chain (no head
 * id, or a head session that is missing) is a target all the same: the user's Delete always works.
 */
export const readDeleteTarget = async (tx: KvTx, chainId: string): Promise<DeleteTarget> => {
    const chain = await tx.get('chains', chainId)
    if (!isRow(chain) || markOf(chain) !== undefined) return { kind: 'gone' }
    const head = headIdOf(chain)
    return {
        kind: 'chain',
        ...(head === undefined ? {} : { head }),
        updatedAt: Number(chain.updatedAt),
        sessions: ids(await sessionsOf(tx, chainId)),
    }
}

export type MarkRequest = { chainId: string; sessions: string[]; head?: string; wall: number }

export type MarkResult = { kind: 'marked'; at: number } | { kind: 'changed' } | { kind: 'gone' }

/** Delete's mark (§3.4): only on the chain the page locked, unmarked and unchanged since. */
export const markTx = async (tx: KvTx, request: MarkRequest): Promise<MarkResult> => {
    const chain = await tx.get('chains', request.chainId)
    if (!isRow(chain) || markOf(chain) !== undefined) return { kind: 'gone' }
    if (headIdOf(chain) !== request.head) return { kind: 'changed' }
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
    head?: string
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
        if (!isRow(chain)) continue
        const at = markOf(chain)
        if (typeof at !== 'number' || now - at < minAgeMs) continue
        const chainId = String(chain.chainId)
        const head = headIdOf(chain)
        out.push({
            chainId,
            at,
            ...(head === undefined ? {} : { head }),
            updatedAt: Number(chain.updatedAt),
            sessions: ids(await sessionsOf(tx, chainId)),
        })
    }
    return out
}
