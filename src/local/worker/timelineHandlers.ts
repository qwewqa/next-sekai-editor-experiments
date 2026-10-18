import { toHex } from '../hash'
import { KeyRange, type KvTx } from '../kv/types'
import type { WorkerContext } from './handlers'
import type { CallScope } from './rpc'

// The storage worker's read for the History panel's Timeline (Part 1 §1.4.10.5, §1.3.7): a
// session's entries newest first, a page at a time, continuing into the session it continued
// at the entry it continued from. Old entries load as the panel scrolls.

/** A stored entry row as the Timeline reads it. */
export type TimelineEntry = {
    sessionId: string
    seq: number
    time: number
    kind: string
    label: string
    /** The snapshot's root, as hex. */
    snapshot: string
    noteCount: number
    dirty: boolean
    kept: boolean
    /** A `continue` entry: the time of the parent's entry it continues, for its divider. */
    from?: number
    revisionId?: string
    device?: unknown
}

export type TimelineRequest = {
    sessionId: string
    /** Entries before this `seq` of `sessionId`; the newest when absent. */
    before?: number
    limit: number
}

export type TimelinePage = {
    entries: TimelineEntry[]
    /** Where the next page starts; absent at the start of the chain. */
    next?: { sessionId: string; before: number }
}

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** Parent links followed at most. */
const MAX_DEPTH = 256

const entryOf = (row: Row): TimelineEntry | undefined => {
    if (
        typeof row.sessionId !== 'string' ||
        typeof row.seq !== 'number' ||
        typeof row.time !== 'number' ||
        typeof row.kind !== 'string'
    )
        return
    const snapshot = row.snapshot
    return {
        sessionId: row.sessionId,
        seq: row.seq,
        time: row.time,
        kind: row.kind,
        label: typeof row.label === 'string' ? row.label : '',
        snapshot: snapshot instanceof Uint8Array ? toHex(snapshot) : '',
        noteCount: typeof row.noteCount === 'number' ? row.noteCount : 0,
        dirty: row.dirty === true,
        kept: row.kept !== false,
        ...(typeof row.revisionId === 'string' ? { revisionId: row.revisionId } : {}),
        ...(row.device === undefined ? {} : { device: row.device }),
    }
}

/** Each `continue` entry's time of the entry it continues, for its divider. */
const fillFrom = async (tx: KvTx, entries: readonly TimelineEntry[]) => {
    for (const entry of entries) {
        if (entry.kind !== 'continue') continue
        const session = await tx.get('sessions', entry.sessionId)
        const parent = isRow(session) && isRow(session.parent) ? session.parent : undefined
        if (typeof parent?.id !== 'string' || typeof parent.uptoSeq !== 'number') continue
        const from = await tx.get('entries', [parent.id, parent.uptoSeq])
        if (isRow(from) && typeof from.time === 'number') entry.from = from.time
    }
}

/** A page of entries newest first, following parent links past a session's first entry. */
export const readTimeline = async (
    tx: KvTx,
    { sessionId, before = Infinity, limit }: TimelineRequest,
): Promise<TimelinePage> => {
    const entries: TimelineEntry[] = []
    let id = sessionId
    // Exclusive: the entries below this `seq`.
    let upto = before
    let next: TimelinePage['next']
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const wanted = limit - entries.length
        const rows = await tx.entries('entries', {
            query: KeyRange.bound([id, -Infinity], [id, upto], false, true),
            direction: 'prev',
            limit: wanted,
        })
        for (const { value } of rows) {
            const entry = isRow(value) ? entryOf(value) : undefined
            if (entry) entries.push(entry)
        }
        // From the last row read, not entry: a malformed row still moves the cursor in this session.
        const last = rows.at(-1)?.primaryKey as [string, number] | undefined
        if (rows.length >= wanted && last) {
            next = { sessionId: id, before: last[1] }
            break
        }
        // The session's first entry is read: on into the session it continued, from where it did.
        const session = await tx.get('sessions', id)
        const parent = isRow(session) && isRow(session.parent) ? session.parent : undefined
        if (typeof parent?.id !== 'string' || typeof parent.uptoSeq !== 'number') break
        id = parent.id
        upto = parent.uptoSeq + 1
        if (entries.length >= limit) {
            next = { sessionId: id, before: upto }
            break
        }
    }
    await fillFrom(tx, entries)
    return next ? { entries, next } : { entries }
}

export const timelineHandlers = (context: WorkerContext) => ({
    /** A page of the Timeline (§1.4.10.5). */
    readTimeline: (request: TimelineRequest, scope?: CallScope) =>
        context.core.read(['sessions', 'entries'], (tx) => readTimeline(tx, request), scope),
})

export type TimelineHandlers = ReturnType<typeof timelineHandlers>
