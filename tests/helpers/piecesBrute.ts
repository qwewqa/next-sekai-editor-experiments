import { dayKey, type Zone } from '../../src/calendar/calendar'
import type { PieceEntry, TimelinePiece } from '../../src/calendar/pieces'

// The definition of a piece (spec-C invariant 7), written the plain way for tests to compare against:
// for each non-divider entry kept by the filter, newest first, it starts a new piece unless the
// piece before it has the same session and the same local day. No shared code with `piecesOf`.

export const brutePieces = (
    newestFirst: readonly PieceEntry[],
    zone: Zone,
    kinds?: readonly string[],
): TimelinePiece[] => {
    const kept = newestFirst.filter(
        (entry) => entry.kind !== 'continue' && (kinds === undefined || kinds.includes(entry.kind)),
    )
    const groups: PieceEntry[][] = []
    for (const entry of kept) {
        const group = groups.at(-1)
        const first = group?.[0]
        if (
            group &&
            first &&
            first.sessionId === entry.sessionId &&
            dayKey(first.time, zone) === dayKey(entry.time, zone)
        )
            group.push(entry)
        else groups.push([entry])
    }
    return groups.map((group) => {
        const first = group[0]!
        const last = group[group.length - 1]!
        const times = group.map((entry) => entry.time)
        return {
            sessionId: first.sessionId,
            newestSeq: first.seq,
            oldestSeq: last.seq,
            newest: first.time,
            oldest: last.time,
            earliest: Math.min(...times),
            latest: Math.max(...times),
            count: group.length,
            day: dayKey(first.time, zone),
        }
    })
}
