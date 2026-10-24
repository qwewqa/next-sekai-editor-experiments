import { toHex } from '../hash'
import { sessionReadability } from '../records/unknownValues'
import {
    replay,
    ReplayError,
    type ReplayedStack,
    type ReplayEntry,
    type ReplaySlot,
} from '../timeline'
import type { ChainCut, EntryRow, SessionRow } from './cut'

// The settled history model's rules over a cut: the chain order of sessions
// and its guard, the chronology, "later than the cut", the carry test, and the undo stack's cut
// and renumbering. Pure functions: the builder (build.ts) applies them.

/** Why a chain can't be written: each is a refusal, never a filtered file. */
export type ModelRefusal =
    /** A session or entry kind this build doesn't know: "Needs a newer version". */
    | 'needsNewer'
    /** An older or malformed session generation: not newer, and not read either, so "damaged". */
    | 'unreadableHead'
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

/** Whether this build can write the chain: every session's `v` and entry kinds known. */
export const checkReadable = (cut: ChainCut) => {
    if (cut.unreadable) throw new ModelError('needsNewer')
    for (const session of cut.sessions) {
        const entryKinds = (cut.entries.get(session.id) ?? []).map((entry) => entry.kind)
        const readability = sessionReadability({ row: session, entryKinds })
        if (readability === 'newer') throw new ModelError('needsNewer')
        if (readability === 'unsupported') throw new ModelError('unreadableHead')
    }
}

/**
 * The chain's sessions in chain order, by `startedAt`. The guard: sessions sharing a
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
 * the sessions up to that one (Save to File… of an earlier session).
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
 * "Later than the cut": a row whose session started after the cut's session, or in
 * that session with a higher `seq`. It needs nothing but the binding, so it holds when the cut's
 * session, or any other, has since been deleted.
 */
export const isLater = (row: ChainRow, cut: Cut) =>
    row.startedAt > cut.startedAt ||
    (row.entry.sessionId === cut.sessionId && row.entry.seq > cut.seq)

/**
 * Whether the file a binding records holds a history: its cut counts at least one
 * entry. A Save without History stores no cut; an open of a file without history stores one of
 * count 0. A file with history always holds an entry (its last write's `save`), so "no cut" and
 * "count 0" both mean no history, and nothing there for a write to carry or keep.
 */
export const bindingHasHistory = (file: { entry?: { count: number } } | undefined) =>
    !!file?.entry && file.entry.count > 0

/** A binding's cut as the carry test reads it. */
export type CountedCut = Cut & { count: number; notKept: number; inexact?: true }

/**
 * Whether the chain holds the cut's own row: `held` (kind `save`, `revisionId` the base's, at the
 * cut's session and `seq`); `replaced` (another row is there); `absent` (the cut's session is
 * stored without a row there); `sessionGone` (the session itself is gone).
 */
export const ownRow = (
    rows: readonly ChainRow[],
    cut: Cut,
    base: { revisionId: string },
    sessionStored: (sessionId: string) => boolean,
): 'held' | 'absent' | 'replaced' | 'sessionGone' => {
    const at = rows.find(
        (row) => row.entry.sessionId === cut.sessionId && row.entry.seq === cut.seq,
    )
    if (at)
        return at.entry.kind === 'save' && at.entry.revisionId === base.revisionId
            ? 'held'
            : 'replaced'
    return sessionStored(cut.sessionId) ? 'absent' : 'sessionGone'
}

/** What the carry test finds: `missing` is known loss, `unproven` is not. */
export type CarryStatus = 'carries' | 'missing' | 'unproven'

/**
 * The carry test: a write that isn't an
 * append carries its base's `completeFrom` only when the cut isn't `inexact`, the chain holds the
 * cut's own row (`ownRow`), its rows up to the cut still number `cut.count`, and the rows among
 * them that are flagged (stored `kept: false`, or marked by this build) and whose state no
 * unflagged row up to the cut has still number `cut.notKept`. Both sets only grow, and at the
 * bind the first contains the rows the file lacked, so equal counts mean equal sets. A cut only
 * ever under-claims.
 *
 * When it doesn't carry, steps are known missing (`missing`) only when the cut isn't `inexact` and
 * the chain holds fewer of the file's rows than `count` (a missing own row counted as present), or
 * holds the own row and exactly `count` rows and, given `lacks`, the write lacks the states of
 * more of them than `notKept`. Anything else is `unproven`: a flag alone is never a known loss.
 */
export const carryStatus = (
    rows: readonly ChainRow[],
    cut: CountedCut,
    base: { revisionId: string },
    sessionStored: (sessionId: string) => boolean,
    flagged: (row: ChainRow) => boolean,
    /** The build only: whether the write lacks this row's state (not in the plan's roots). */
    lacks?: (row: ChainRow) => boolean,
): CarryStatus => {
    const upto = rows.filter((row) => !isLater(row, cut))
    const own = ownRow(upto, cut, base, sessionStored)
    // An open of a file without history counts no row: nothing for the own row to be.
    const ownHeld = cut.count === 0 || own === 'held'
    const kept = new Set(
        upto.filter((row) => !flagged(row)).map((row) => toHex(row.entry.snapshot)),
    )
    let lacking = 0
    for (const row of upto) if (flagged(row) && !kept.has(toHex(row.entry.snapshot))) lacking++
    if (!cut.inexact && ownHeld && upto.length === cut.count && lacking === cut.notKept)
        return 'carries'
    if (cut.inexact) return 'unproven'
    const held = upto.length + (own === 'absent' || own === 'sessionGone' ? 1 : 0)
    if (held < cut.count) return 'missing'
    if (held > cut.count) return 'unproven'
    if (lacks && own === 'held' && upto.filter(lacks).length > cut.notKept) return 'missing'
    return 'unproven'
}

/** `carryStatus(…) === 'carries'`. */
export const carries = (
    rows: readonly ChainRow[],
    cut: CountedCut,
    base: { revisionId: string },
    sessionStored: (sessionId: string) => boolean,
    flagged: (row: ChainRow) => boolean,
) => carryStatus(rows, cut, base, sessionStored, flagged) === 'carries'

/** The undo stack a write holds: its slots and absolute `base` and `index`. */
export type WriteStack = { base: number; slots: ReplaySlot[]; index: number }

/**
 * The stack cut at slots whose snapshot the file doesn't hold: the longest run of held
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
 * How far the session's slot numbers are from the file's: absolute numbers in a file
 * count from replay of its own first entry, so a chronology that starts later than the session's
 * numbering (sessions removed before it) is renumbered. Replay of the written chronology gives
 * the file's index and stack; undefined when replay can't follow it.
 */
export const renumbering = (
    chronology: readonly ReplayEntry[],
    sessionIndex: number,
): { offset: number; replayed: ReplayedStack } | undefined => {
    try {
        const replayed = replay(chronology)
        return { offset: sessionIndex - replayed.index, replayed }
    } catch (error) {
        if (error instanceof ReplayError) return undefined
        throw error
    }
}
