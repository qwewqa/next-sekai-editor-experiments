import type { FlushDeps, Flusher } from '../flush'

// The holes the flusher makes (design A §7, R2-2 and R3-7): a `seq` below a session's `lastSeq`
// with no row is allowed (I-3) when a Save reserved it and its end did not add a `save` row there.
// The ledger learns them from every `reserveSave`, from every `endSave` (let go or kept), and from
// the marker a resume reads (`reservedSeq`): a resume numbers past the marker, so every `seq` it
// jumps over, from the stored `lastSeq` to the marker, is a hole (entries a dying tab never stored
// are among them). A `seq` whose end added the entry is never excused, so a `save` row a defect
// lost is still reported. An example: a Save reserves 3 and the tab reloads before any end; the
// resumed session stores 4, and 3 is a hole.

type Watched = {
    deps: FlushDeps
    current?: unknown
    sessions: readonly unknown[]
}

type Resuming = { id: string; lastSeq?: number; seq?: number }

export class HoleLedger {
    private readonly learned = new Map<string, Set<number>>()
    private readonly added = new Map<string, Set<number>>()

    /** Whether `seq` of the session is a hole the flusher made. */
    has = (sessionId: string, seq: number) => !!this.learned.get(sessionId)?.has(seq)

    learn(sessionId: string, seq: number) {
        if (this.added.get(sessionId)?.has(seq)) return
        let set = this.learned.get(sessionId)
        if (!set) this.learned.set(sessionId, (set = new Set()))
        set.add(seq)
    }

    /** An end added the Save's entry at `seq`: not a hole, and never excused after. */
    add(sessionId: string, seq: number) {
        let set = this.added.get(sessionId)
        if (!set) this.added.set(sessionId, (set = new Set()))
        set.add(seq)
        this.learned.get(sessionId)?.delete(seq)
    }

    /** Learns from a flusher's reservations, ends and marker reads, for as long as it lives. */
    watch(flusher: Flusher) {
        const target = flusher as unknown as Watched
        const reserveSave = flusher.reserveSave.bind(flusher)
        flusher.reserveSave = () => {
            const reservation = reserveSave()
            if (reservation) this.learn(reservation.session.id, reservation.seq)
            return reservation
        }
        const endSave = flusher.endSave.bind(flusher)
        flusher.endSave = (reservation, entry, ...rest) => {
            const { session, seq } = reservation
            // The flusher adds the entry only to its current session, as `endSave` decides.
            const adds =
                entry !== undefined &&
                target.current === session &&
                target.sessions.includes(session)
            if (adds) this.add(session.id, seq)
            else this.learn(session.id, seq)
            return endSave(reservation, entry, ...rest)
        }
        // A resume numbers past the marker of a Save that began in a page whose end this ledger may
        // not have seen: the `seq`s it jumps over are learned as the holes they are.
        for (const name of ['resumeSession', 'resumeJournalled'] as const) {
            const original = flusher[name] as unknown as (start: Resuming) => {
                id: string
                nextSeq: number
            }
            ;(flusher as unknown as Record<string, unknown>)[name] = (start: Resuming) => {
                const session = original.call(flusher, start)
                for (let seq = (start.lastSeq ?? start.seq ?? 0) + 1; seq < session.nextSeq; seq++)
                    this.learn(session.id, seq)
                return session
            }
        }
        // The marker itself, read by a resume or a journal-only reload, is learned too.
        let reservedSeq = target.deps.reservedSeq
        Object.defineProperty(target.deps, 'reservedSeq', {
            configurable: true,
            enumerable: true,
            get: () =>
                reservedSeq &&
                ((sessionId: string) => {
                    const seq = reservedSeq?.(sessionId)
                    if (seq !== undefined) this.learn(sessionId, seq)
                    return seq
                }),
            set: (next: FlushDeps['reservedSeq']) => {
                reservedSeq = next
            },
        })
    }
}
