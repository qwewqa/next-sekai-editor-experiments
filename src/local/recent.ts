import { equalBytes } from './hash'
import type { KvTx } from './kv/types'
import { namePartsOf, type NameParts } from './names'
import { headOf } from './open/earlier'
import { sessionReadability } from './records/unknownValues'
import { storedRead, type ReadWorker, type StoredRead } from './storedRead'

// Recent Sessions' list (Part 1 §1.4.10.6): one row per chain, newest first, read in the storage
// worker in one transaction. A chain without a readable head is listed as `damaged`, never hidden;
// a chain marked for Delete is not listed. The page reads it through `storedRead`, so a failed
// read is a failure, never an empty list.

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** Whether this build reads the chain: `newer` and `damaged` rows are shown but never opened. */
export type RecentReadable = 'yes' | 'newer' | 'damaged'

/** A chain's bound file as the label shows it; `event` is as stored, an unknown value a download. */
export type RecentFile = { name: string; event?: string; at?: number; confirmed?: boolean }

export type RecentChain = {
    chainId: string
    /** The chain's last write, milliseconds. */
    updatedAt: number
    /** The head session: what Restore Session opens. `startedAt` dates an untitled name. */
    head: { sessionId: string; lastSeq: number; startedAt: number }
    /** What the displayed name is chosen from (§1.3.5), with the summary's BGM name. */
    nameParts: NameParts
    file?: RecentFile
    /** The head's state differs from the file event's (§1.3.4); false without a file. */
    changed: boolean
    /** The head's note count; absent when unknown, never 0. */
    noteCount?: number
    readable: RecentReadable
}

const count = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const fileOf = (value: unknown): RecentFile | undefined => {
    if (!isRow(value) || typeof value.name !== 'string' || !value.name) return
    const at = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : undefined
    return {
        name: value.name,
        ...(typeof value.event === 'string' ? { event: value.event } : {}),
        ...(at === undefined ? {} : { at }),
        ...(value.confirmed === true ? { confirmed: true } : {}),
    }
}

/** One session of the chain this build can't read makes the chain unreadable (§1.6.11.8). */
const readabilityOf = async (tx: KvTx, chainId: string, head: Row | undefined) => {
    const sessions = await tx.index('sessions', 'chainId').getAll(chainId)
    let readable: RecentReadable = head ? 'yes' : 'damaged'
    for (const row of [head, ...sessions]) {
        if (!isRow(row)) {
            readable = 'damaged'
            continue
        }
        const read = sessionReadability({ row })
        if (read === 'newer') return 'newer'
        if (read === 'unsupported') readable = 'damaged'
    }
    return readable
}

/** Every listed chain, newest first. */
export const readRecent = async (tx: KvTx): Promise<RecentChain[]> => {
    const out: RecentChain[] = []
    const chains = await tx.entries('chains', { index: 'updatedAt', direction: 'prev' })
    for (const { value } of chains) {
        if (!isRow(value) || value.deleting !== undefined || typeof value.chainId !== 'string')
            continue
        const sessionId = typeof value.head === 'string' ? value.head : ''
        // A removed head (a tombstone) has nothing to restore or show.
        if (sessionId && (await tx.getKey('tombstones', sessionId)) !== undefined) continue
        const session = sessionId ? await tx.get('sessions', sessionId) : undefined
        const head = isRow(session) ? session : undefined
        const updatedAt = count(value.updatedAt) ?? 0
        const file = fileOf(value.file)
        const root = head ? await headOf(tx, head) : undefined
        const hash = isRow(value.file) ? value.file.hash : undefined
        const changed =
            !!file && (!(hash instanceof Uint8Array) || !root || !equalBytes(root, hash))
        const summary = isRow(value.summary) ? value.summary : undefined
        const noteCount = count(summary?.noteCount)
        out.push({
            chainId: value.chainId,
            updatedAt,
            head: {
                sessionId,
                lastSeq: count(head?.lastSeq) ?? 0,
                startedAt: count(head?.startedAt) ?? updatedAt,
            },
            nameParts: namePartsOf(value),
            ...(file ? { file } : {}),
            changed,
            ...(noteCount === undefined ? {} : { noteCount }),
            readable: await readabilityOf(tx, value.chainId, head),
        })
    }
    return out
}

/** The list, or its failure. The caller shows a failed read as such, never as "No changes yet". */
export const listRecent = (worker: ReadWorker): Promise<StoredRead<RecentChain[]>> =>
    storedRead(worker, 'listRecent', undefined)
