import type { Zone } from './calendar'
import { joinPieces, piecesOf, type PieceEntry, type TimelinePiece } from './pieces'

// Go To's pieces for a list the worker's index may not cover (spec-C invariant 11): the index's
// pieces, with the open session's listed entries above the newest one the index covers joined on
// top. Pure, so Node tests load it.

/** What an index read covers: its pieces, the newest stored entry they reach, and the zone. */
export type IndexCover = {
    pieces: readonly TimelinePiece[]
    top?: number
    topSession?: string
    zone: Zone
}

/**
 * The pieces of `listed` (any order, dividers allowed, entries may repeat) over `index`. Only the
 * open session's entries the index does not cover are added, each `seq` once, so an entry both
 * stored and waiting is counted once. `kinds` is the Timeline's Saves filter.
 */
export const composeGoTo = (
    listed: readonly PieceEntry[],
    index: IndexCover,
    open: string,
    kinds?: readonly string[],
): TimelinePiece[] => {
    const covered = index.topSession === open ? index.top : undefined
    const above = new Map<number, PieceEntry>()
    for (const entry of listed)
        if (entry.sessionId === open && (covered === undefined || entry.seq > covered))
            above.set(entry.seq, entry)
    const newestFirst = [...above.values()].sort((a, b) => b.seq - a.seq)
    return joinPieces(piecesOf(newestFirst, index.zone, kinds), index.pieces)
}
