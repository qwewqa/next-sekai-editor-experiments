import { shallowRef } from 'vue'
import type { DisplayName } from '../names'

// What this load found (Part 1 §1.4.3's table), as data: the UI turns each into its load notice
// with its action, most important first. Kept for the page's life, so Settings › Local Data ›
// Recovery can list "At this load:". Light (Vue only).

/** A name as shown: the displayed name, or the date fallback with the session's start. */
export type ShownName = { name: DisplayName; at: number }

export type LoadEvent =
    /** A new visit continued the most recent session: "Continued "{0}" from {1}." [Open History]. */
    | { kind: 'continued'; name: ShownName; from: number }
    /** The canary: "Work from earlier visits is missing. The browser cleared this site’s storage." */
    | { kind: 'storageCleared' }
    /** "A change to "{0}" could not be applied, so it was kept as a separate session." [Restore Session]. */
    | { kind: 'journalKept'; name: ShownName; sessionId: string }
    /** A journal of an earlier visit recovered as a session: "Recovered unsaved work…" [Restore Session]. */
    | { kind: 'unsavedRecovered'; sessionId: string }
    /** Such work, storage still unavailable: "Unsaved work from an earlier visit is in Local Data." [Local Data]. */
    | { kind: 'unsavedInLocalData' }
    /** "The old auto save could not be restored." [Local Data]. */
    | { kind: 'migrationFailed' }
    /** "Continued "{0}" from auto save." (no "Continued…" line then). */
    | { kind: 'migrated'; name: ShownName; sessionId: string }
    /** "Recovered your last change to "{0}"." */
    | { kind: 'journalRecovered'; name: ShownName; sessionId: string }
    /** "A recovered change needs a newer version of the editor." */
    | { kind: 'journalLater' }
    /** The most recent session is open elsewhere: ""{0}" is open in another tab or window." [Restore as a Copy]. */
    | { kind: 'openElsewhere'; name: ShownName; sessionId: string }
    /** The reload's session was deleted in the gap: "This session was deleted in another tab or window." */
    | { kind: 'deletedElsewhere' }
    /** A separate copy at load: "{0} is open in another tab or window, so this is a separate copy." */
    | { kind: 'separateCopy'; of: { name: string; bound: boolean } }
    /** The session continued or recovered at load has a head whose BGM isn't held. */
    | { kind: 'bgmNotLoaded' }

/** This load's events, in the order found; the UI orders them by the table. */
export const loadEvents = shallowRef<readonly LoadEvent[]>([])

const listeners = new Set<(event: LoadEvent) => void>()

export const addLoadEvent = (event: LoadEvent) => {
    loadEvents.value = [...loadEvents.value, event]
    for (const listener of [...listeners]) listener(event)
}

/** Runs for each event from now on. */
export const onLoadEvent = (listener: (event: LoadEvent) => void) => {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}
