import type { Flusher } from './flush'
import type { JournalWriter } from './journal/writer'
import type { StorageStatus } from './worker/core'

// "Not durably stored" (Part 1 §1.6.7): the one predicate every session switch and the leave
// prompt use. Safety never depends on an unverified write (Part 0 §0.10.5, invariant 15): an
// ordinary pending flush counts as stored only because the journal of its entries verified.

export type DurabilityInputs = {
    /** What storing can do in this tab; undefined until the worker answers. */
    status: StorageStatus | undefined
    flusher: Flusher | undefined
    journal: JournalWriter | undefined
}

/** Why the open session isn't durably stored, or undefined when it is. */
export const notDurableReason = ({ status, flusher, journal }: DurabilityInputs) => {
    // Storage unavailable: no IndexedDB, a blocked private mode, an insecure origin, a failed
    // open, or a newer database this build only reads.
    if (status?.mode !== 'stored') return 'unavailable'
    // Paused: a failed flush, quota, a timed-out maintenance wait, an upgrade, a worker that
    // couldn't restart.
    if (status.reason) return 'paused'
    const session = flusher?.session
    if (!flusher || !session) return 'unavailable'
    // An edit made before the first flush finished.
    if (!session.stored) return 'notWritten'
    if (!flusher.unflushed(session)) return
    // The last flush failed, and so did any strict flush since.
    if (flusher.failed) return 'flushFailed'
    // Unflushed entries the journal doesn't cover: it couldn't be written, or didn't verify.
    if (!journal?.verified(session.id, flusher.newestSeq(session))) return 'journal'
}

export const isDurablyStoredWith = (inputs: DurabilityInputs) => !notDurableReason(inputs)
