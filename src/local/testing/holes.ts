import type { FlushDeps, Flusher } from '../flush'

// The holes the flusher makes (spec A, R2-2 and R3-7): a `seq` below a session's `lastSeq`
// with no row is allowed (I-3) when a Save reserved it and its end did not add a `save` row there.
// The ledger learns them from every `reserveSave`, from every `endSave` that did not put a `save`
// entry in `pending` at its `seq` (decided as the end returns), and from the marker a resume reads
// (`reservedSeq`): a resume numbers past the marker, so every `seq` it jumps over, from the stored
// `lastSeq` to the marker, is a hole (entries a dying tab never stored are among them). It never excuses a `seq` that some commit created a row at and no power
// loss undid, nor one whose end added the entry, nor the entry a journal-only resume numbers
// itself, so a row a defect lost is still reported. An example: a Save reserves 3 and the tab
// reloads before any end; the resumed session stores 4, and 3 is a hole.

type Watched = {
    deps: FlushDeps
}

type Resuming = { id: string; lastSeq?: number; seq?: number }

const keyOf = (sessionId: string, seq: number) => `${sessionId}#${seq}`

export class HoleLedger {
    private readonly learned = new Set<string>()
    private readonly added = new Set<string>()
    private readonly made = new Set<string>()

    /** Whether `seq` of the session is a hole the flusher made. */
    has = (sessionId: string, seq: number) => {
        const key = keyOf(sessionId, seq)
        return this.learned.has(key) && !this.made.has(key) && !this.added.has(key)
    }

    learn(sessionId: string, seq: number) {
        this.learned.add(keyOf(sessionId, seq))
    }

    /** An end added the Save's entry at `seq`: not a hole, and never excused. */
    add(sessionId: string, seq: number) {
        this.added.add(keyOf(sessionId, seq))
    }

    /** A commit created a row at `seq`: whatever happens to it, a power loss alone may remove it. */
    created(sessionId: string, seq: number) {
        this.made.add(keyOf(sessionId, seq))
    }

    /** A power loss undid the commit that created the row at `seq`. */
    undone(sessionId: string, seq: number) {
        this.made.delete(keyOf(sessionId, seq))
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
        flusher.endSave = (reservation, ...rest) => {
            const { session, seq } = reservation
            // Decided as the end returns: it adds its entry before it returns its promise, so the
            // `seq` is no hole while the end's flush runs, nor after a kill. Any other result
            // (kept, let go, not current, or an end that did nothing) leaves it one.
            const ended = endSave(reservation, ...rest)
            if (session.pending.some((each) => each.seq === seq && each.kind === 'save'))
                this.add(session.id, seq)
            else this.learn(session.id, seq)
            return ended
        }
        // A resume numbers past the marker of a Save that began in a page whose end this ledger may
        // not have seen: the `seq`s it jumps over, after the stored `lastSeq` (a journal-only
        // resume: after the journal's) up to the marker, are holes. The entry a journal-only
        // resume numbers itself comes after the marker and is no hole.
        for (const name of ['resumeSession', 'resumeJournalled'] as const) {
            const original = flusher[name] as unknown as (start: Resuming) => unknown
            ;(flusher as unknown as Record<string, unknown>)[name] = (start: Resuming) => {
                const marker = target.deps.reservedSeq?.(start.id) ?? 0
                for (let seq = (start.lastSeq ?? start.seq ?? 0) + 1; seq <= marker; seq++)
                    this.learn(start.id, seq)
                return original.call(flusher, start)
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
