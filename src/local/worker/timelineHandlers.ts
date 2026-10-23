import { dayKey, resolveZone, type Zone } from '../../calendar/calendar'
import { joinPieces, piecesOf, type PieceEntry, type TimelinePiece } from '../../calendar/pieces'
import {
    captureEntryDescription,
    captureStep,
    stripUnknownEntryKeys,
    type EntryDescription,
} from '../../history/operations'
import { fromHex16, toHex } from '../hash'
import { KeyRange, type KvTx } from '../kv/types'
import { hashKey, unpackHashes, type NodesRow } from '../records/rows'
import { isKnownEntryKind, originRuleOf } from '../records/unknownValues'
import type { WorkerContext } from './handlers'
import type { CallScope } from './rpc'

// The storage worker's read for the History panel's Timeline (Part 1 §1.4.10.5, §1.3.7): a
// session's entries newest first, a page at a time, continuing into the session it continued
// at the entry it continued from. Old entries load as the panel scrolls; after a jump, newer ones
// load along the path the index gave. The index lists the chain's pieces, runs of a session's
// entries on one local day, for Go To.

/** A stored entry row as the Timeline reads it. */
export type TimelineEntry = EntryDescription & {
    sessionId: string
    seq: number
    time: number
    /** The snapshot's root, as hex. */
    snapshot: string
    /** Absent when the row does not say: an unknown count is never a zero. */
    noteCount?: number
    dirty: boolean
    kept: boolean
    /**
     * A `kept: false` entry whose snapshot reaches a part found bad (the chain's `badChunks`): it
     * reads damaged, not not kept (§1.4.10.5). Absent otherwise.
     */
    damaged?: true
    /**
     * A row this build cannot decode, kept in the run so the chain is not shortened: `newer` when a
     * newer build wrote it (a kind or a key this build does not know), `damaged` when it is
     * malformed. It carries a placeholder description and is unavailable (§1.6.11.8).
     */
    unreadable?: 'newer' | 'damaged'
    /** A `continue` entry: the time of the parent's entry it continues, for its divider. */
    from?: number
    revisionId?: string
    device?: { id: string; label: string }
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
    /**
     * With the start of the chain (no `next`): its oldest stored session continues a session that is
     * no longer stored (its chain was deleted, or a parent was removed), so earlier steps are gone.
     */
    earlierMissing?: true
    /** With `after`: where the next newer page starts and how many stored entries are newer. */
    newer?: { sessionId: string; after: number; count: number }
}

export type { TimelinePiece }

export type TimelineIndexRequest = {
    sessionId: string
    /** As `readTimeline`'s first page: below this `seq` of `sessionId`. */
    before?: number
    /** Only entries of these kinds, such as saves and exports while filtering. */
    kinds?: readonly string[]
    /** The time zone the days are in: the History clock's (an unknown name is UTC). */
    zone: string
}

export type TimelineIndex = {
    /** Newest first. */
    pieces: TimelinePiece[]
    /** Newest first. */
    path: PathStep[]
    /** The newest stored `seq` of `topSession` that the pieces cover; absent when they cover none. */
    top?: number
    /** The request's `sessionId`. */
    topSession: string
    /** Some session of the path has an import pending (any tab's): rows may still land below `top`. */
    importing: boolean
}

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

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
    let unreadable: TimelineEntry['unreadable']
    try {
        description = captureEntryDescription(row)
    } catch {
        // An unknown kind or a key no carrier knows is a newer build's; anything else is damage.
        unreadable =
            !isKnownEntryKind(row.kind) || stripUnknownEntryKeys(row).unknown.length
                ? 'newer'
                : 'damaged'
        description = { kind: 'edit', step: captureStep({ kind: 'edit', operation: null }) }
    }
    return {
        sessionId: row.sessionId,
        seq: row.seq,
        time: row.time,
        ...description,
        snapshot: snapshot instanceof Uint8Array ? toHex(snapshot) : '',
        ...(typeof row.noteCount === 'number' ? { noteCount: row.noteCount } : {}),
        dirty: row.dirty === true,
        kept: row.kept !== false,
        ...(typeof row.revisionId === 'string' ? { revisionId: row.revisionId } : {}),
        ...(isRow(row.device) &&
        typeof row.device.id === 'string' &&
        typeof row.device.label === 'string'
            ? { device: { id: row.device.id, label: row.device.label } }
            : {}),
        ...(typeof row.appVersion === 'string' ? { appVersion: row.appVersion } : {}),
        ...(unreadable ? { unreadable } : {}),
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
    let earlierMissing = false
    // Every parent link is followed, however long the chain; a cycle in damaged rows ends it.
    const seen = new Set<string>()
    while (!seen.has(id)) {
        seen.add(id)
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
        // A parent with no row is gone with its entries: the Timeline ends here and says so.
        if (!isRow(await tx.get('sessions', parent.id))) {
            earlierMissing = true
            break
        }
        id = parent.id
        upto = parent.uptoSeq + 1
        if (entries.length >= limit) {
            next = { sessionId: id, before: upto }
            break
        }
    }
    await fillFrom(tx, entries)
    return { entries, ...(next ? { next } : earlierMissing ? { earlierMissing: true as const } : {}) }
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
    // Every parent link is followed, however long the chain; a cycle in damaged rows ends it.
    const seen = new Set([sessionId])
    for (;;) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const parent = await parentOf(tx, path.at(-1)!.sessionId)
        if (!parent || seen.has(parent.id)) break
        seen.add(parent.id)
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

/** Whether a root reaches one of the hashes, through the stored rows' direct `refs`. */
const reaches = async (
    tx: KvTx,
    root: string,
    bad: ReadonlySet<string>,
    memo: Map<string, boolean>,
) => {
    const known = memo.get(root)
    if (known !== undefined) return known
    // A cycle in damaged rows ends here as not reaching.
    memo.set(root, false)
    const row = (await tx.get('nodes', hashKey(fromHex16(root)))) as NodesRow | undefined
    let found = false
    if (row?.t === 'root' || row?.t === 'node') {
        const refs = unpackHashes(row.refs).map(toHex)
        // A root's refs are the header, the kind nodes, then media, which hold no records.
        const below =
            row.t === 'root' ? refs.slice(1, 1 + row.kinds.length) : row.depth === 1 ? refs : []
        found = refs.some((hex) => bad.has(hex))
        for (const hex of below) if (!found && (await reaches(tx, hex, bad, memo))) found = true
    }
    memo.set(root, found)
    return found
}

/**
 * Marks the `kept: false` entries that read damaged: their roots reach a hash in the chain's
 * `badChunks`, which the open's unlink and a Save's marks write (§1.4.10.5, §1.6.11.2).
 */
const markDamagedRows = async (tx: KvTx, sessionId: string, entries: readonly TimelineEntry[]) => {
    const dropped = entries.filter((entry) => !entry.kept && entry.snapshot)
    if (!dropped.length) return
    const session = await tx.get('sessions', sessionId)
    const chainId = isRow(session) ? session.chainId : undefined
    if (typeof chainId !== 'string') return
    const chain = await tx.get('chains', chainId)
    if (!isRow(chain) || !(chain.badChunks instanceof Uint8Array) || !chain.badChunks.length) return
    let bad: Set<string>
    try {
        bad = new Set(unpackHashes(chain.badChunks).map(toHex))
    } catch {
        return
    }
    const memo = new Map<string, boolean>()
    for (const entry of dropped)
        if (await reaches(tx, entry.snapshot, bad, memo)) entry.damaged = true
}

/** A page of the Timeline: older than `before`, or newer than `after` along the path. */
export const readTimeline = async (tx: KvTx, request: TimelineRequest) => {
    const page =
        request.after === undefined ? await readOlder(tx, request) : await readNewer(tx, request)
    await markDamagedRows(tx, request.sessionId, page.entries)
    return page
}

// --- The index Go To lists (Part 1 §1.4.10.5, §1.6.8.7).

/**
 * How the Timeline draws a stored row, for the kinds that decide a piece. A row whose raw kind is a
 * divider's, or is one a filter keeps, is decoded as the Timeline decodes it, so an unreadable one
 * is the `edit` step it is drawn as. Any other row is counted by its typed fields: it is neither a
 * divider nor in a filter, whether it decodes or not.
 */
const drawnKind = (row: Row, kinds?: readonly string[]): string => {
    const raw = row.kind as string
    if (raw === 'continue' || kinds?.includes(raw) || kinds?.includes('edit'))
        return entryOf(row)?.kind ?? raw
    return raw
}

/** A stored row as a piece entry, or nothing when the Timeline would skip it. */
const pieceEntryOf = (value: unknown, kinds?: readonly string[]): PieceEntry | undefined => {
    if (
        !isRow(value) ||
        typeof value.sessionId !== 'string' ||
        typeof value.seq !== 'number' ||
        typeof value.time !== 'number' ||
        typeof value.kind !== 'string'
    )
        return
    return {
        sessionId: value.sessionId,
        seq: value.seq,
        time: value.time,
        kind: drawnKind(value, kinds),
    }
}

/**
 * The pieces of a session's rows in `[from, to)` (the bounds open or closed as given), read in
 * full, and the highest `seq` among the rows that are entries.
 */
const piecesInRange = async (
    tx: KvTx,
    id: string,
    range: { from: number; to: number; fromOpen?: boolean },
    zone: Zone,
    kinds?: readonly string[],
) => {
    const rows = await tx.getAll(
        'entries',
        KeyRange.bound([id, range.from], [id, range.to], range.fromOpen ?? false, true),
    )
    const newestFirst: PieceEntry[] = []
    let top = -Infinity
    for (let i = rows.length - 1; i >= 0; i--) {
        const entry = pieceEntryOf(rows[i], kinds)
        if (!entry) continue
        newestFirst.push(entry)
        top = Math.max(top, entry.seq)
    }
    return { pieces: piecesOf(newestFirst, zone, kinds), top }
}

/**
 * One session's pieces, newest first, by binary search: two keyed reads and a search on `seq` by
 * day per piece, robust to gaps. Exact only for a session that holds just its own rows (P0 to P3),
 * where `time` never decreases along `seq` and a `continue` row is only the lowest.
 */
const searchPieces = async (
    tx: KvTx,
    { sessionId: id, upto }: PathStep,
    zone: Zone,
): Promise<TimelinePiece[]> => {
    const range = (from: number, to: number) => KeyRange.bound([id, from], [id, to], false, true)
    const first = async (from: number, to: number, direction: 'next' | 'prev') =>
        (await tx.entries('entries', { query: range(from, to), direction, limit: 1 }))[0]
    const dayOf = (row: { value: unknown }) => dayKey(timeOf(row.value), zone)
    const pieces: TimelinePiece[] = []
    let oldest = await first(-Infinity, upto, 'next')
    // The divider is the lowest row only (P2), and is no step.
    if (oldest && isRow(oldest.value) && drawnKind(oldest.value) === 'continue')
        oldest = await first(seqOf(oldest.primaryKey) + 1, upto, 'next')
    let top = await first(-Infinity, upto, 'prev')
    if (!oldest || !top) return pieces
    const low = seqOf(oldest.primaryKey)
    while (top) {
        const topSeq = seqOf(top.primaryKey)
        const day = dayOf(top)
        // The day's oldest entry: a binary search on `seq` by day, through the keys there are.
        let bottom = top
        if (dayOf(oldest) >= day) bottom = oldest
        else {
            let lo = low
            let hi = topSeq
            while (hi - lo > 1) {
                const mid = Math.floor((lo + hi) / 2)
                const found = await first(mid, hi, 'next')
                if (!found) hi = mid
                else if (dayOf(found) >= day) {
                    bottom = found
                    hi = mid
                } else lo = seqOf(found.primaryKey)
            }
        }
        const bottomSeq = seqOf(bottom.primaryKey)
        const newest = timeOf(top.value)
        const earliest = timeOf(bottom.value)
        pieces.push({
            sessionId: id,
            newestSeq: topSeq,
            oldestSeq: bottomSeq,
            newest,
            oldest: earliest,
            earliest: Math.min(earliest, newest),
            latest: Math.max(earliest, newest),
            count: await tx.count('entries', range(bottomSeq, topSeq + 1)),
            day,
        })
        top = bottomSeq > low ? await first(-Infinity, bottomSeq, 'prev') : undefined
    }
    return pieces
}

type MemoEntry = {
    pieces: TimelinePiece[]
    /** The exclusive `seq` bound the pieces were read below. */
    upto: number
    /** The highest `seq` read. */
    top: number
    lastSeq: number
    entryCount: number
}

/**
 * The pieces of the sessions that are read in full, kept per `(sessionId, zone, kinds)`. Used
 * again while the session's `lastSeq` and `entryCount` are as they were, and extended by only the
 * rows above the highest one read when the counters show only those were added: every write that adds or removes a session's rows
 * moves `lastSeq` or `entryCount`, and sessions are deleted whole. Pieces depend
 * only on `seq`, `time`, the drawn kind and whether the row decodes, never on `kept`, so a flip of it leaves the answer as it was. Least
 * recently used first; lost with the worker.
 */
export type IndexMemo = Map<string, MemoEntry>
export const createIndexMemo = (): IndexMemo => new Map()
const MEMO_LIMIT = 32

/** One session's pieces, newest first, by reading its rows (through the memo). */
const readPieces = async (
    tx: KvTx,
    memo: IndexMemo,
    { sessionId: id, upto }: PathStep,
    session: unknown,
    zone: Zone,
    kinds?: readonly string[],
): Promise<TimelinePiece[]> => {
    const lastSeq =
        isRow(session) && typeof session.lastSeq === 'number' ? session.lastSeq : undefined
    const entryCount =
        isRow(session) && typeof session.entryCount === 'number' ? session.entryCount : undefined
    // A row that does not say what it holds cannot be told from a changed one: read in full.
    if (lastSeq === undefined || entryCount === undefined)
        return (await piecesInRange(tx, id, { from: -Infinity, to: upto }, zone, kinds)).pieces
    const key = JSON.stringify([id, zone, kinds ?? null])
    const known = memo.get(key)
    if (known) {
        memo.delete(key)
        memo.set(key, known)
        if (known.upto === upto && known.lastSeq === lastSeq && known.entryCount === entryCount)
            return known.pieces
    }
    let read: { pieces: TimelinePiece[]; top: number }
    if (
        known &&
        upto >= known.upto &&
        // Only rows above the highest one read were added: the count above it grew by exactly what
        // the session row says. (The rows between a smaller bound and `upto` would show as extra.)
        entryCount - known.entryCount ===
            (await tx.count(
                'entries',
                KeyRange.bound([id, known.top], [id, Infinity], true, false),
            ))
    ) {
        const added = await piecesInRange(
            tx,
            id,
            { from: known.top, to: upto, fromOpen: true },
            zone,
            kinds,
        )
        read = {
            pieces: joinPieces(added.pieces, known.pieces),
            top: Math.max(known.top, added.top),
        }
    } else read = await piecesInRange(tx, id, { from: -Infinity, to: upto }, zone, kinds)
    memo.set(key, { ...read, upto, lastSeq, entryCount })
    for (const oldest of memo.keys()) {
        if (memo.size <= MEMO_LIMIT) break
        memo.delete(oldest)
    }
    return read.pieces
}

/**
 * The chain's pieces, newest first, the path they lie on, and the newest entry they cover (Go To,
 * §1.4.10.5). A session that holds only its own rows (ORIGIN_RULE `own`, no import pending) is
 * searched when no kinds filter is given; every other session is read in full through the memo.
 */
export const readTimelineIndex = async (
    tx: KvTx,
    { sessionId, before, kinds, zone }: TimelineIndexRequest,
    memo: IndexMemo = createIndexMemo(),
): Promise<TimelineIndex> => {
    const calendarZone = resolveZone(zone)
    const path = await pathOf(tx, sessionId, before)
    const pieces: TimelinePiece[] = []
    let importing = false
    for (const step of path) {
        const session = await tx.get('sessions', step.sessionId)
        const pending = isRow(session) && session.importPending === true
        if (pending) importing = true
        // The path's sessions are distinct, so no piece joins the next session's.
        const own = originRuleOf(isRow(session) ? session.origin : undefined) === 'own'
        const found =
            own && !kinds && !pending
                ? await searchPieces(tx, step, calendarZone)
                : await readPieces(tx, memo, step, session, calendarZone, kinds)
        for (const piece of found) pieces.push(piece)
    }
    const newest = pieces[0]
    return {
        pieces,
        path,
        ...(newest?.sessionId === sessionId ? { top: newest.newestSeq } : {}),
        topSession: sessionId,
        importing,
    }
}

export const timelineHandlers = (context: WorkerContext) => {
    // Per worker, so the memo never answers for another database.
    const memo = createIndexMemo()
    return {
        /** A page of the Timeline (§1.4.10.5): older than `before`, or newer than `after`. */
        readTimeline: (request: TimelineRequest, scope?: CallScope) =>
            context.core.read(
                ['sessions', 'entries', 'chains', 'nodes'],
                (tx) => readTimeline(tx, request),
                scope,
            ),
        /** The chain's pieces, runs of a session's entries on one day, for Go To. */
        readTimelineIndex: (request: TimelineIndexRequest, scope?: CallScope) =>
            context.core.read(
                ['sessions', 'entries'],
                (tx) => readTimelineIndex(tx, request, memo),
                scope,
            ),
    }
}

export type TimelineHandlers = ReturnType<typeof timelineHandlers>
