import { toHex } from '../hash'
import { isKnownEntryKind, isReadableSessionVersion } from '../records/unknownValues'
import { replay, ReplayError, type ReplayEntry, type ReplaySlot } from '../timeline'
import type { ChainCut, EntryRow, SessionRow } from './cut'

// The settled history model's rules over a cut (Part 1 §1.6.11.6): the chain order of sessions
// and its guard, the chronology, "later than the cut", the carry test, and the undo stack's cut
// and renumbering. Pure functions: the builder (build.ts) applies them.

/** Why a chain can't be written: each is a refusal, never a filtered file. */
export type ModelRefusal =
    /** A session or entry kind this build doesn't know (§1.6.11.6): "Needs a newer version". */
    | 'needsNewer'
    /** Two sessions share a `startedAt` and their parent links don't order them. */
    | 'order'

export class ModelError extends Error {
    override name = 'ModelError'
    constructor(readonly reason: ModelRefusal) {
        super(reason)
    }
}

/** A row of the chain with its session's start, for the cut. */
export type ChainRow = { entry: EntryRow; startedAt: number }

/** Whether this build can write the chain (§1.6.11.6): every session's `v` and entry kinds known. */
export const checkReadable = (cut: ChainCut) => {
    if (cut.unreadable) throw new ModelError('needsNewer')
    for (const session of cut.sessions) {
        if (!isReadableSessionVersion(session.v)) throw new ModelError('needsNewer')
        for (const entry of cut.entries.get(session.id) ?? [])
            if (!isKnownEntryKind(entry.kind)) throw new ModelError('needsNewer')
    }
}

/**
 * The chain's sessions in chain order, by `startedAt` (§1.6.11.6). The guard: sessions sharing a
 * `startedAt` (data from before the rule, or a bug) are ordered by their parent links; when the
 * links don't order them, the write fails rather than guess.
 */
export const orderSessions = (sessions: readonly SessionRow[]): SessionRow[] => {
    const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt)
    const out: SessionRow[] = []
    for (let at = 0; at < sorted.length;) {
        let end = at + 1
        while (end < sorted.length && sorted[end]?.startedAt === sorted[at]?.startedAt) end++
        const group = sorted.slice(at, end)
        if (group.length > 1) {
            // A parent comes before its child; anything else in the group is ambiguous.
            const ordered: SessionRow[] = []
            const left = new Set(group)
            while (left.size) {
                const roots = [...left].filter(
                    (session) =>
                        !session.parent ||
                        ![...left].some((other) => other.id === session.parent?.id),
                )
                if (roots.length !== 1) throw new ModelError('order')
                const [next] = roots as [SessionRow]
                ordered.push(next)
                left.delete(next)
            }
            out.push(...ordered)
        } else out.push(...group)
        at = end
    }
    return out
}

/**
 * The chain's rows in chain order: its sessions by `startedAt`, each by `seq`. With `upto`, only
 * the sessions up to that one (Save to File… of an earlier session, §1.6.11.6).
 */
export const chainRows = (cut: ChainCut, upto?: string): ChainRow[] => {
    const rows: ChainRow[] = []
    for (const session of orderSessions(cut.sessions)) {
        for (const entry of cut.entries.get(session.id) ?? [])
            rows.push({ entry, startedAt: session.startedAt })
        if (session.id === upto) break
    }
    return rows
}

export type Cut = { sessionId: string; seq: number; startedAt: number }

/**
 * "Later than the cut" (§1.6.11.6): a row whose session started after the cut's session, or in
 * that session with a higher `seq`. It needs nothing but the binding, so it holds when the cut's
 * session, or any other, has since been deleted.
 */
export const isLater = (row: ChainRow, cut: Cut) =>
    row.startedAt > cut.startedAt ||
    (row.entry.sessionId === cut.sessionId && row.entry.seq > cut.seq)

/**
 * The carry test (§1.6.11.6, D25): a write that isn't an append carries its base's
 * `completeFrom` only when the chain's rows up to the cut still number `entry.count`, and the rows
 * among them that are flagged (stored `kept: false`, or marked by this build) and whose state no
 * unflagged row up to the cut has still number `entry.notKept`. Both sets only grow, and at the
 * bind the first contains the rows the file lacked, so equal counts mean equal sets.
 */
export const carries = (
    rows: readonly ChainRow[],
    entry: { sessionId: string; seq: number; startedAt: number; count: number; notKept: number },
    flagged: (row: ChainRow) => boolean,
) => {
    const upto = rows.filter((row) => !isLater(row, entry))
    const kept = new Set(
        upto.filter((row) => !flagged(row)).map((row) => toHex(row.entry.snapshot)),
    )
    let lacking = 0
    for (const row of upto)
        if (flagged(row) && !kept.has(toHex(row.entry.snapshot))) lacking++
    return upto.length === entry.count && lacking === entry.notKept
}

/** The undo stack a write holds: its slots and absolute `base` and `index` (§1.6.11.5). */
export type WriteStack = { base: number; slots: ReplaySlot[]; index: number }

/**
 * The stack cut at slots whose snapshot the file doesn't hold (§1.3.9): the longest run of held
 * slots around the index. The head itself is always held.
 */
export const cutStack = (stack: WriteStack, held: (slot: ReplaySlot) => boolean): WriteStack => {
    const at = stack.index - stack.base
    let first = at
    let end = at + 1
    const heldAt = (i: number) => {
        const slot = stack.slots[i]
        return !!slot && held(slot)
    }
    while (first > 0 && heldAt(first - 1)) first--
    while (end < stack.slots.length && heldAt(end)) end++
    return { base: stack.base + first, slots: stack.slots.slice(first, end), index: stack.index }
}

/**
 * How far the session's slot numbers are from the file's (§1.6.11.5): absolute numbers in a file
 * count from replay of its own first entry, so a chronology that starts later than the session's
 * numbering (sessions removed before it) is renumbered. Replay of the written chronology gives
 * the file's index; undefined when replay can't follow it.
 */
export const renumbering = (
    chronology: readonly ReplayEntry[],
    sessionIndex: number,
): number | undefined => {
    try {
        const { index } = replay(chronology)
        return sessionIndex - index
    } catch (error) {
        if (error instanceof ReplayError) return undefined
        throw error
    }
}
