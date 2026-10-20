import { captureEntryDescription, type EntryDescription } from '../../history/operations'
import { toHex } from '../hash'
import { KeyRange, type KvTx } from '../kv/types'
import type { WorkerContext } from './handlers'
import type { CallScope } from './rpc'

// The storage worker's read for the History panel's Timeline (Part 1 §1.4.10.5, §1.3.7): a
// session's entries newest first, a page at a time, continuing into the session it continued
// at the entry it continued from. Old entries load as the panel scrolls; after a jump, newer ones
// load along the path the index gave. The index lists the chain's pieces, a session's entries on
// one day each, for Go To.

/** A stored entry row as the Timeline reads it. */
export type TimelineEntry = EntryDescription & {
    sessionId: string
    seq: number
    time: number
    /** The snapshot's root, as hex. */
    snapshot: string
    noteCount: number
    dirty: boolean
    kept: boolean
    /** A `continue` entry: the time of the parent's entry it continues, for its divider. */
    from?: number
    revisionId?: string
    device?: unknown
    appVersion?: string
}

export type TimelineRequest = {
    sessionId: string
    /** Entries before this `seq` of `sessionId`; the newest when absent. */
    before?: number
    /** Entries after this `seq` of `sessionId` instead: read oldest first along `path`. */
    after?: number
    /** With `after`: the chain's sessions, newest first, as the index gave them. */
    path?: readonly PathStep[]
    limit: number
}

/** A session of the chain the Timeline follows, with the entries of it in the chain: below `upto`. */
export type PathStep = { sessionId: string; upto: number }

export type TimelinePage = {
    /** Newest first, with `after` too. */
    entries: TimelineEntry[]
    /** Where the next page starts; absent at the start of the chain. */
    next?: { sessionId: string; before: number }
    /** With `after`: where the next newer page starts and how many stored entries are newer. */
    newer?: { sessionId: string; after: number; count: number }
}

/** A session's entries on one local day, along the chain (Go To, §1.4.10.5). */
export type TimelinePiece = {
    sessionId: string
    newestSeq: number
    oldestSeq: number
    /** The newest and oldest entries' times, in ms. */
    newest: number
    oldest: number
    count: number
}

export type TimelineIndexRequest = {
    sessionId: string
    /** As `readTimeline`'s first page: below this `seq` of `sessionId`. */
    before?: number
    /** Only entries of these kinds, such as saves and exports while filtering. */
    kinds?: readonly string[]
}

export type TimelineIndex = {
    /** Newest first. */
    pieces: TimelinePiece[]
    /** Newest first. */
    path: PathStep[]
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
    let description: EntryDescription
    try {
        description = captureEntryDescription(row)
    } catch {
        return
    }
    return {
        sessionId: row.sessionId,
        seq: row.seq,
        time: row.time,
        ...description,
        snapshot: snapshot instanceof Uint8Array ? toHex(snapshot) : '',
        noteCount: typeof row.noteCount === 'number' ? row.noteCount : 0,
        dirty: row.dirty === true,
        kept: row.kept !== false,
        ...(typeof row.revisionId === 'string' ? { revisionId: row.revisionId } : {}),
        ...(row.device === undefined ? {} : { device: row.device }),
        ...(typeof row.appVersion === 'string' ? { appVersion: row.appVersion } : {}),
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
const readOlder = async (
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

/** The session a session continued, and the entry it continued from. */
const parentOf = async (tx: KvTx, id: string) => {
    const session = await tx.get('sessions', id)
    const parent = isRow(session) && isRow(session.parent) ? session.parent : undefined
    if (typeof parent?.id !== 'string' || typeof parent.uptoSeq !== 'number') return
    return { id: parent.id, upto: parent.uptoSeq + 1 }
}

/** The sessions the Timeline follows from its start, newest first: the parent links it walks. */
const pathOf = async (tx: KvTx, sessionId: string, before = Infinity) => {
    const path: PathStep[] = [{ sessionId, upto: before }]
    for (let depth = 1; depth < MAX_DEPTH; depth++) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const parent = await parentOf(tx, path.at(-1)!.sessionId)
        if (!parent) break
        path.push({ sessionId: parent.id, upto: parent.upto })
    }
    return path
}

const seqOf = (key: unknown) => (key as [string, number])[1]

const timeOf = (value: unknown) =>
    isRow(value) && typeof value.time === 'number' ? value.time : -Infinity

/** A page of entries newer than `after`, read oldest first along the path, returned newest first. */
const readNewer = async (
    tx: KvTx,
    { sessionId, after = -Infinity, path = [], limit }: TimelineRequest,
): Promise<TimelinePage> => {
    const entries: TimelineEntry[] = []
    const start = path.findIndex((step) => step.sessionId === sessionId)
    if (start === -1) return { entries }
    // The newest entry read, by key: a malformed row still moves the cursor.
    let top = { at: start, seq: after }
    for (let at = start; at >= 0 && entries.length < limit; at--) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const step = path[at]!
        const from = at === start ? after : -Infinity
        const rows = await tx.entries('entries', {
            query: KeyRange.bound(
                [step.sessionId, from],
                [step.sessionId, step.upto],
                at === start,
                true,
            ),
            limit: limit - entries.length,
        })
        for (const { value, primaryKey } of rows) {
            const entry = isRow(value) ? entryOf(value) : undefined
            if (entry) entries.push(entry)
            top = { at, seq: seqOf(primaryKey) }
        }
    }
    // The stored entries still above it, session by session.
    let count = 0
    for (let at = top.at; at >= 0; at--) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const step = path[at]!
        const from = at === top.at ? top.seq : -Infinity
        count += await tx.count(
            'entries',
            KeyRange.bound([step.sessionId, from], [step.sessionId, step.upto], true, true),
        )
    }
    entries.reverse()
    await fillFrom(tx, entries)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const newer = { sessionId: path[top.at]!.sessionId, after: top.seq, count }
    return count > 0 ? { entries, newer } : { entries }
}

/** A page of the Timeline: older than `before`, or newer than `after` along the path. */
export const readTimeline = (tx: KvTx, request: TimelineRequest) =>
    request.after === undefined ? readOlder(tx, request) : readNewer(tx, request)

/** The start of a time's local day: the worker keeps the page's time zone. */
const dayOf = (time: number) => new Date(time).setHours(0, 0, 0, 0)

/** One session's pieces, newest first: its entries split at local midnights. */
const piecesOf = async (tx: KvTx, { sessionId: id, upto }: PathStep): Promise<TimelinePiece[]> => {
    const range = (from: number, to: number) => KeyRange.bound([id, from], [id, to], false, true)
    const first = async (from: number, to: number, direction: 'next' | 'prev') =>
        (await tx.entries('entries', { query: range(from, to), direction, limit: 1 }))[0]
    const pieces: TimelinePiece[] = []
    const oldest = await first(-Infinity, upto, 'next')
    let top = await first(-Infinity, upto, 'prev')
    if (!oldest || !top) return pieces
    const low = seqOf(oldest.primaryKey)
    while (top) {
        const topSeq = seqOf(top.primaryKey)
        const day = dayOf(timeOf(top.value))
        // The day's oldest entry: a binary search on `seq` by time, through the keys there are.
        let bottom = top
        if (timeOf(oldest.value) >= day) bottom = oldest
        else {
            let lo = low
            let hi = topSeq
            while (hi - lo > 1) {
                const mid = Math.floor((lo + hi) / 2)
                const found = await first(mid, hi, 'next')
                if (!found) hi = mid
                else if (timeOf(found.value) >= day) {
                    bottom = found
                    hi = mid
                } else lo = seqOf(found.primaryKey)
            }
        }
        const bottomSeq = seqOf(bottom.primaryKey)
        const piece = {
            sessionId: id,
            newestSeq: topSeq,
            oldestSeq: bottomSeq,
            newest: timeOf(top.value),
            oldest: timeOf(bottom.value),
            count: await tx.count('entries', range(bottomSeq, topSeq + 1)),
        }
        // A clock set back can split a day: one piece still.
        const previous = pieces.at(-1)
        if (previous && dayOf(previous.oldest) === dayOf(piece.newest)) {
            previous.oldestSeq = piece.oldestSeq
            previous.oldest = piece.oldest
            previous.count += piece.count
        } else pieces.push(piece)
        top = bottomSeq > low ? await first(-Infinity, bottomSeq, 'prev') : undefined
    }
    return pieces
}

/** One session's pieces of only some kinds: every entry read, as no index holds the kind. */
const piecesOfKinds = async (
    tx: KvTx,
    { sessionId: id, upto }: PathStep,
    kinds: readonly string[],
): Promise<TimelinePiece[]> => {
    const rows = await tx.getAll(
        'entries',
        KeyRange.bound([id, -Infinity], [id, upto], false, true),
    )
    const pieces: TimelinePiece[] = []
    for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]
        if (!isRow(row) || typeof row.seq !== 'number' || typeof row.time !== 'number') continue
        if (typeof row.kind !== 'string' || !kinds.includes(row.kind)) continue
        const previous = pieces.at(-1)
        if (previous && dayOf(previous.oldest) === dayOf(row.time)) {
            previous.oldestSeq = row.seq
            previous.oldest = row.time
            previous.count++
        } else
            pieces.push({
                sessionId: id,
                newestSeq: row.seq,
                oldestSeq: row.seq,
                newest: row.time,
                oldest: row.time,
                count: 1,
            })
    }
    return pieces
}

/** The chain's pieces, newest first, and the path they lie on (Go To, §1.4.10.5). */
export const readTimelineIndex = async (
    tx: KvTx,
    { sessionId, before, kinds }: TimelineIndexRequest,
): Promise<TimelineIndex> => {
    const path = await pathOf(tx, sessionId, before)
    const pieces: TimelinePiece[] = []
    for (const step of path)
        pieces.push(...(kinds ? await piecesOfKinds(tx, step, kinds) : await piecesOf(tx, step)))
    return { pieces, path }
}

export const timelineHandlers = (context: WorkerContext) => ({
    /** A page of the Timeline (§1.4.10.5): older than `before`, or newer than `after`. */
    readTimeline: (request: TimelineRequest, scope?: CallScope) =>
        context.core.read(['sessions', 'entries'], (tx) => readTimeline(tx, request), scope),
    /** The chain's pieces, a session's entries on one day each, for Go To. */
    readTimelineIndex: (request: TimelineIndexRequest, scope?: CallScope) =>
        context.core.read(['sessions', 'entries'], (tx) => readTimelineIndex(tx, request), scope),
})

export type TimelineHandlers = ReturnType<typeof timelineHandlers>
