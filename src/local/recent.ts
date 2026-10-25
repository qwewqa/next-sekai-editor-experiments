import { chainStartOf } from './chainFields'
import { equalBytes } from './hash'
import type { KvTx } from './kv/types'
import { namePartsOf, type NameParts } from './names'
import { headOf } from './open/earlier'
import { sessionReadability } from './records/unknownValues'
import { storedRead, type ReadWorker, type StoredRead } from './storedRead'

// Recent Sessions' list: one row per chain, newest first, read in the storage
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
    /**
     * The head session: what Restore Session opens. `startedAt` dates an untitled name: the chain's
     * first start, so a later visit does not rename it.
     */
    head: { sessionId: string; lastSeq: number; startedAt: number }
    /** What the displayed name is chosen from, with the summary's BGM name. */
    nameParts: NameParts
    file?: RecentFile
    /** The head's state differs from the file event's; false without a file. */
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

/** One session of the chain this build can't read makes the chain unreadable. */
const readabilityOf = (sessions: readonly Row[], head: Row | undefined) => {
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

/** A listed chain with its stored record and its sessions, in key order. */
export type RecentRead = { recent: RecentChain; record: Row; sessions: Row[] }

/**
 * Every listed chain, newest first, with its record and sessions. The chains are one cursor and
 * the sessions one read; only the heads' stack blocks are read per chain, all at once.
 */
export const readRecentChains = async (tx: KvTx): Promise<RecentRead[]> => {
    const records = (await tx.entries('chains', { index: 'updatedAt', direction: 'prev' }))
        .map(({ value }) => value)
        .filter(
            (value): value is Row =>
                isRow(value) && value.deleting === undefined && typeof value.chainId === 'string',
        )
    const byId = new Map<unknown, Row>()
    const byChain = new Map<string, Row[]>()
    for (const row of await tx.getAll('sessions')) {
        if (!isRow(row)) continue
        byId.set(row.id, row)
        if (typeof row.chainId !== 'string') continue
        const list = byChain.get(row.chainId)
        if (list) list.push(row)
        else byChain.set(row.chainId, [row])
    }
    const heads = records.map((record) =>
        typeof record.head === 'string' && record.head ? byId.get(record.head) : undefined,
    )
    const roots = await Promise.all(
        heads.map((head) => (head ? headOf(tx, head) : Promise.resolve(undefined))),
    )
    return records.map((value, i) => {
        const chainId = value.chainId as string
        const head = heads[i]
        const sessions = byChain.get(chainId) ?? []
        const sessionId = typeof value.head === 'string' ? value.head : ''
        const updatedAt = count(value.updatedAt) ?? 0
        const file = fileOf(value.file)
        const root = roots[i]
        const hash = isRow(value.file) ? value.file.hash : undefined
        const changed =
            !!file && (!(hash instanceof Uint8Array) || !root || !equalBytes(root, hash))
        const summary = isRow(value.summary) ? value.summary : undefined
        const noteCount = count(summary?.noteCount)
        const recent: RecentChain = {
            chainId,
            updatedAt,
            head: {
                sessionId,
                lastSeq: count(head?.lastSeq) ?? 0,
                startedAt: count(chainStartOf(value, head?.startedAt)) ?? updatedAt,
            },
            nameParts: namePartsOf(value),
            ...(file ? { file } : {}),
            changed,
            ...(noteCount === undefined ? {} : { noteCount }),
            readable: readabilityOf(sessions, head),
        }
        return { recent, record: value, sessions }
    })
}

/** Every listed chain, newest first. */
export const readRecent = async (tx: KvTx): Promise<RecentChain[]> =>
    (await readRecentChains(tx)).map(({ recent }) => recent)

/** The list, or its failure. The caller shows a failed read as such, never as "No changes yet". */
export const listRecent = (worker: ReadWorker): Promise<StoredRead<RecentChain[]>> =>
    storedRead(worker, 'listRecent', undefined)
