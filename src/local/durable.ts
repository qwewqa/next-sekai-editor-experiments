import type { Flusher } from './flush'
import type { JournalWriter } from './journal/writer'
import type { StorageStatus } from './worker/core'

// "Not durably stored": the one predicate every session switch and the leave
// prompt use. Safety never depends on an unverified write: an
// ordinary pending flush counts as stored only because the journal of its entries verified.

export type DurabilityInputs = {
    /** What storing can do in this tab; undefined until the worker answers. */
    status: StorageStatus | undefined
    flusher: Flusher | undefined
    journal: JournalWriter | undefined
    /** The media whose bytes the head holds (`heldMediaOf`), as hex. */
    media?: readonly string[]
}

/** Why the open session isn't durably stored, or undefined when it is. */
export const notDurableReason = ({ status, flusher, journal, media = [] }: DurabilityInputs) => {
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
    // A picked file is always stored, and the journal doesn't carry media:
    // the head's media the store refused or didn't read back is in this tab's memory only.
    if (media.some((hash) => status.mediaPending?.includes(hash))) return 'mediaPending'
    if (!flusher.unflushed(session)) return
    // The last flush failed, and so did any strict flush since.
    if (flusher.failed) return 'flushFailed'
    // Unflushed entries the journal doesn't cover: it couldn't be written, or didn't verify.
    if (!journal?.verified(session.id, flusher.newestSeq(session))) return 'journal'
}

export const isDurablyStoredWith = (inputs: DurabilityInputs) => !notDurableReason(inputs)
