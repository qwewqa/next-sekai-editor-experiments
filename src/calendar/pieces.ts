import { dayKey, type DayKey, type Zone } from './calendar'

// The one definition of a Go To piece (Part 1 §1.4.10.5, §1.6.8.7), used by the page and the
// storage worker: a piece is a maximal run of adjacent entries of a list, dividers left out, that
// share a session and a local day. Pure, so Node tests load it.

/** What a piece needs of an entry: where it is, when it was made, and the kind the Timeline draws. */
export type PieceEntry = { sessionId: string; seq: number; time: number; kind: string }

/** A run of a session's adjacent entries on one local day (Go To, §1.4.10.5). */
export type TimelinePiece = {
    sessionId: string
    /** The newest and oldest entries by `seq`. */
    newestSeq: number
    oldestSeq: number
    /** Their times, in ms. */
    newest: number
    oldest: number
    /** The earliest and latest time in the run: they differ only where times run out of order. */
    earliest: number
    latest: number
    /** Entries in the run, dividers not counted. */
    count: number
    /** The local day of the run, in the zone it was made for. */
    day: DayKey
}

/** An entry the Timeline draws as a divider, not a step: "Continued from". */
export const isDivider = (kind: string) => kind === 'continue'

/**
 * The pieces of a list of entries, newest first. `kinds` keeps only entries of those kinds (the
 * Timeline's Saves and Exports filter); dividers are always left out.
 */
export const piecesOf = (
    newestFirst: Iterable<PieceEntry>,
    zone: Zone,
    kinds?: readonly string[],
): TimelinePiece[] => {
    const pieces: TimelinePiece[] = []
    let last: TimelinePiece | undefined
    for (const entry of newestFirst) {
        if (isDivider(entry.kind) || (kinds && !kinds.includes(entry.kind))) continue
        const day = dayKey(entry.time, zone)
        if (last?.sessionId === entry.sessionId && last.day === day) {
            last.oldestSeq = entry.seq
            last.oldest = entry.time
            last.earliest = Math.min(last.earliest, entry.time)
            last.latest = Math.max(last.latest, entry.time)
            last.count++
        } else {
            last = {
                sessionId: entry.sessionId,
                newestSeq: entry.seq,
                oldestSeq: entry.seq,
                newest: entry.time,
                oldest: entry.time,
                earliest: entry.time,
                latest: entry.time,
                count: 1,
                day,
            }
            pieces.push(last)
        }
    }
    return pieces
}

/**
 * The pieces of a newer list followed by an older one: the oldest of the first and the newest of the
 * second are one run when they share a session and a day. `piecesOf(a ++ b)` is
 * `joinPieces(piecesOf(a), piecesOf(b))`. Neither argument is changed.
 */
export const joinPieces = (
    newer: readonly TimelinePiece[],
    older: readonly TimelinePiece[],
): TimelinePiece[] => {
    const tail = newer.at(-1)
    const head = older[0]
    if (!tail || !head) return [...newer, ...older]
    if (tail.sessionId !== head.sessionId || tail.day !== head.day) return [...newer, ...older]
    return [
        ...newer.slice(0, -1),
        {
            ...tail,
            oldestSeq: head.oldestSeq,
            oldest: head.oldest,
            earliest: Math.min(tail.earliest, head.earliest),
            latest: Math.max(tail.latest, head.latest),
            count: tail.count + head.count,
        },
        ...older.slice(1),
    ]
}

/** A Go To day: adjacent pieces on one local day, as the Timeline's headers run (I-4). */
export type GoToDay = { day: DayKey; pieces: TimelinePiece[]; count: number }

/** Groups adjacent pieces of one day, in order. A day whose rows come back lower is listed again. */
export const daysOf = (pieces: readonly TimelinePiece[]): GoToDay[] => {
    const days: GoToDay[] = []
    for (const piece of pieces) {
        const last = days.at(-1)
        if (last?.day === piece.day) {
            last.pieces.push(piece)
            last.count += piece.count
        } else days.push({ day: piece.day, pieces: [piece], count: piece.count })
    }
    return days
}
