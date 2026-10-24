import { Lru } from '../changes/cache'
import {
    diffChanges,
    summarizeChanges,
    touchesBeats,
    type ChangeSet,
    type ChangeTotals,
} from '../changes/diff'
import { isRecordList, readCandidates, type PartSource, type RootParts } from '../changes/read'
import { inflateStrict } from '../chunkVerify'
import { hashKey } from '../db'
import { fromHex16, isHash16Hex, toHex } from '../hash'
import type { KvTx } from '../kv/types'
import type { RecordValue } from '../records/canonical'
import { isChunkRowIntact, unpackHashes, type ChunkRow, type NodesRow } from '../records/rows'
import { kindNames, type KindName } from '../records/schema'
import type { WorkerContext } from './handlers'
import type { CallScope } from './rpc'
import { readTimeline, type TimelineEntry } from './timelineHandlers'

// The change view's reads: what an entry changed against the entry
// before it, and Edits Here's scan for the entries that changed a range of beats. Parts are
// keyed by their hash and pairs by their roots, so the caches never go stale; a failed read is
// never cached, as it may be a part not stored yet.

type Rec = readonly RecordValue[]

/** An entry's place on the chain, and its snapshot's root. */
export type ChainEntry = { sessionId: string; seq: number; snapshot: string }

/** A match: the entry, where it lies along the scan, and the entry it was compared with. */
export type EditMatch = TimelineEntry & { pos: number; previous: ChainEntry }

/** Where a scan goes on: the next page, the entry still waiting for its older neighbour. */
export type FindEditsCursor = {
    sessionId: string
    before: number
    carry?: TimelineEntry
    /** The carried entry's place along the scan, newest first from 0. */
    pos: number
}

export type FindEditsRequest = {
    /** Where the chain starts, as `readTimeline`'s first page. */
    sessionId: string
    before?: number
    /** The beats an entry must touch. */
    from: number
    to: number
    cursor?: FindEditsCursor
    /** Stops before this entry: what an earlier scan already checked. */
    until?: { sessionId: string; seq: number }
    /** How long to go on before answering. */
    budgetMs?: number
}

export type FindEditsPage = {
    /** Newest first. */
    matches: EditMatch[]
    /** Absent at the start of the chain, or at `until`. */
    cursor?: FindEditsCursor
    /** Entries whose state, or the one before, could not be read. */
    unreadable: number
    /** The newest entry checked, on a scan's first call. */
    top?: ChainEntry
    /** Where `until` lay along this scan. */
    reached?: number
}

/** Pairs read per transaction, so a flush waits a few milliseconds at most. */
const SLICE = 50
const BUDGET_MS = 60

const roots = new Lru<string, RootParts>(4000)
const nodes = new Lru<string, { depth: 0 | 1; children: string[] }>(4000)
const chunks = new Lru<string, Rec[]>(2000)
const summaries = new Lru<string, number[]>(20000)

const decoder = new TextDecoder()

/** The parts, read in `tx` and kept by hash; undefined for a part missing or damaged. */
const sourceIn = (tx: KvTx): PartSource => ({
    root: async (hex) => {
        const known = roots.get(hex)
        if (known) return known
        if (!isHash16Hex(hex)) return
        const row = (await tx.get('nodes', hashKey(fromHex16(hex)))) as NodesRow | undefined
        if (row?.t !== 'root' || !(row.refs instanceof Uint8Array) || !Array.isArray(row.kinds))
            return
        try {
            const [header, ...rest] = unpackHashes(row.refs).map(toHex)
            if (header === undefined || rest.length < row.kinds.length) return
            const kinds = new Map<KindName, string>()
            for (const [i, name] of row.kinds.entries()) {
                if (!kindNames.includes(name as KindName)) return
                kinds.set(name as KindName, rest[i] ?? '')
            }
            const parts = { header, kinds }
            roots.set(hex, parts)
            return parts
        } catch {
            return
        }
    },
    node: async (hex) => {
        const known = nodes.get(hex)
        if (known) return known
        if (!isHash16Hex(hex)) return
        const row = (await tx.get('nodes', hashKey(fromHex16(hex)))) as NodesRow | undefined
        if (row?.t !== 'node' || !(row.refs instanceof Uint8Array)) return
        try {
            const parts = { depth: row.depth, children: unpackHashes(row.refs).map(toHex) }
            nodes.set(hex, parts)
            return parts
        } catch {
            return
        }
    },
    chunk: async (hex) => {
        const known = chunks.get(hex)
        if (known) return known
        if (!isHash16Hex(hex)) return
        const key = fromHex16(hex)
        const row = (await tx.get('chunks', hashKey(key))) as Partial<ChunkRow> | undefined
        if (!(row?.bytes instanceof Uint8Array) || typeof row.crc32 !== 'number') return
        if (!isChunkRowIntact(key, { bytes: row.bytes, crc32: row.crc32 })) return
        try {
            const records: unknown = JSON.parse(decoder.decode(inflateStrict(row.bytes)))
            if (!isRecordList(records)) return
            chunks.set(hex, records)
            return records
        } catch {
            return
        }
    },
})

/** The beats a pair changed; undefined when it could not be read. */
const summaryIn = async (tx: KvTx, before: string, after: string) => {
    if (before === after) return []
    const key = `${before}:${after}`
    const known = summaries.get(key)
    if (known) return known
    try {
        const input = await readCandidates(sourceIn(tx), before, after)
        if (!input) return
        const { beats } = summarizeChanges(input)
        summaries.set(key, beats)
        return beats
    } catch {
        return
    }
}

const chainEntry = (entry: TimelineEntry): ChainEntry => ({
    sessionId: entry.sessionId,
    seq: entry.seq,
    snapshot: entry.snapshot,
})

const isEntry = (entry: TimelineEntry, at?: { sessionId: string; seq: number }) =>
    !!at && entry.sessionId === at.sessionId && entry.seq === at.seq

/** What one slice found, merged into the page once its read resolved. */
type SliceFound = Omit<FindEditsPage, 'cursor'> & { next?: FindEditsCursor }

/**
 * One slice of the scan, in one transaction. It writes only its own result: the read can run
 * again after a lost connection, so a slice is merged into the page once, when the read resolves.
 */
const scanSlice = async (
    tx: KvTx,
    request: FindEditsRequest,
    cursor: FindEditsCursor,
): Promise<SliceFound> => {
    const read = await readTimeline(tx, {
        sessionId: cursor.sessionId,
        before: cursor.before,
        limit: SLICE,
    })
    const list = cursor.carry ? [cursor.carry, ...read.entries] : read.entries
    const found: SliceFound = {
        matches: [],
        unreadable: 0,
        ...(list[0] ? { top: chainEntry(list[0]) } : {}),
    }
    for (let i = 0; i + 1 < list.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const entry = list[i]!
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const older = list[i + 1]!
        if (isEntry(entry, request.until)) {
            found.reached = cursor.pos + i
            return found
        }
        if (!entry.snapshot || !older.snapshot) {
            found.unreadable++
            continue
        }
        const beats = await summaryIn(tx, older.snapshot, entry.snapshot)
        if (!beats) found.unreadable++
        else if (touchesBeats(beats, request.from, request.to))
            found.matches.push({ ...entry, pos: cursor.pos + i, previous: chainEntry(older) })
    }
    const last = list.at(-1)
    if (last && isEntry(last, request.until)) {
        found.reached = cursor.pos + list.length - 1
        return found
    }
    // The chain's first entry has nothing before it.
    if (!read.next || !last) return found
    found.next = {
        sessionId: read.next.sessionId,
        before: read.next.before,
        carry: last,
        pos: cursor.pos + list.length - 1,
    }
    return found
}

export const changeHandlers = (context: WorkerContext) => ({
    /** What `after` changed against `before`, both roots as hex; undefined when unknown. */
    readChanges: async (
        { before, after, totals }: { before: string; after: string; totals?: ChangeTotals },
        scope?: CallScope,
    ): Promise<ChangeSet | undefined> => {
        const input = await context.core.read(
            ['nodes', 'chunks'],
            (tx) => readCandidates(sourceIn(tx), before, after),
            scope,
        )
        if (!input) return
        try {
            return diffChanges(input, totals)
        } catch {
            return
        }
    },

    /**
     * Edits Here's scan: the entries whose change touches `[from, to]`, newest first,
     * in slices of one transaction each, until the budget is spent.
     */
    findEdits: async (request: FindEditsRequest, scope?: CallScope): Promise<FindEditsPage> => {
        const page: FindEditsPage = { matches: [], unreadable: 0 }
        let cursor: FindEditsCursor | undefined = request.cursor ?? {
            sessionId: request.sessionId,
            before: request.before ?? Infinity,
            pos: 0,
        }
        const start = performance.now()
        const budget = request.budgetMs ?? BUDGET_MS
        while (cursor) {
            const at: FindEditsCursor = cursor
            const found = await context.core.read(
                ['sessions', 'entries', 'chains', 'nodes', 'chunks'],
                (tx) => scanSlice(tx, request, at),
                scope,
            )
            page.matches.push(...found.matches)
            page.unreadable += found.unreadable
            page.top ??= found.top
            if (found.reached !== undefined) page.reached = found.reached
            cursor = found.next
            if (performance.now() - start >= budget) break
        }
        return cursor ? { ...page, cursor } : page
    },
})

export type ChangeHandlers = ReturnType<typeof changeHandlers>

/** Empties the caches, for tests. */
export const clearChangeCaches = () => {
    roots.clear()
    nodes.clear()
    chunks.clear()
    summaries.clear()
}
