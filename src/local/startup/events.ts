import { shallowRef } from 'vue'
import type { CopyOf, DisplayName } from '../names'
import type { StorageStatus } from '../worker/core'

// What this load found, as data: the UI turns each into its load notice
// with its action, most important first. Kept for the page's life, so Settings › Local Data ›
// Recovery can list "At this load". Light (Vue only).

/**
 * A name as shown: the displayed name, or the date fallback with the session's start (absent when
 * the session's row does not say: the date fallback then shows no date).
 */
export type ShownName = { name: DisplayName; at?: number }

export type LoadEvent =
    /** A new visit continued the most recent session: "Continued "{0}" from {1}." [Open History]. */
    | { kind: 'continued'; name: ShownName; from?: number }
    /** The canary: "Work from earlier visits is missing. The browser cleared this site’s storage." */
    | { kind: 'storageCleared' }
    /** "A recovered change to "{0}" was kept as a separate session." [Restore Session]. */
    | { kind: 'journalKept'; name: ShownName; sessionId: string }
    /** A journal of an earlier visit recovered as a session: "Recovered unsaved work…" [Restore Session]. */
    | { kind: 'unsavedRecovered'; sessionId: string }
    /** Such work, storage still unavailable: "Unsaved work from an earlier visit is in Local Data." [Local Data]. */
    | { kind: 'unsavedInLocalData' }
    /**
     * "The old auto save could not be restored." [Local Data]: its transaction failed, or with
     * `unreadable`, this build can't read all of it, so it stays in Local Data.
     * The notice is one string either way; `unreadable` tells the two apart for the
     * specs and for a later reader of the load events.
     */
    | { kind: 'migrationFailed'; unreadable?: true }
    /**
     * The auto save migrated: "Continued "{0}" from the old auto save." (no "Continued…" line
     * then) when it's the session that opened; otherwise it's kept as a session of its own.
     */
    | { kind: 'migrated'; name: ShownName; sessionId: string; opened: boolean }
    /** The migrated auto save was made for an older engine revision: today's warning. */
    | { kind: 'migratedRevision'; sessionId: string }
    /** "Recovered your last change to "{0}"." */
    | { kind: 'journalRecovered'; name: ShownName; sessionId: string }
    /** "A recovered change needs a newer version of the editor." */
    | { kind: 'journalLater' }
    /** After GC and cleanup, usage is still above the cleanup threshold: "Browser storage is almost full." [Local Data]. */
    | { kind: 'storageNearlyFull' }
    /** A journal couldn't be applied or kept at this load (storage full or busy): it stays for the next. */
    | { kind: 'journalFailed' }
    /** Earlier visits' journals kept while storage is unavailable fill much of their budget. */
    | { kind: 'journalsFull' }
    /**
     * A session this build can't open: the reload's own (`reload`), or the most recent one a new
     * visit passed over for an older one (`newest`); `later` needs a newer version.
     */
    | { kind: 'notOpened'; which: 'reload' | 'newest'; why: 'later' | 'damaged' }
    /**
     * The most recent session is open elsewhere, so the tab starts blank: ""{0}" was not restored
     * here because it is open in another tab or window." [Restore as a Copy].
     */
    | { kind: 'openElsewhere'; name: ShownName; sessionId: string }
    /** The reload's session was deleted in the gap: "This session was deleted in another tab or window." */
    | { kind: 'deletedElsewhere' }
    /** A separate copy at load: "{0} is open in another tab or window, so this is a separate copy." */
    | { kind: 'separateCopy'; of: CopyOf }
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

/**
 * The session this tab left last by New, an open or a restore, while it can be reopened.
 * Here, not in `api.ts`, so the commands that show Reopen stay light.
 */
export const previousSession = shallowRef<{ sessionId: string; name: ShownName } | undefined>()

/**
 * What storing can do in this tab; undefined until the worker answers. Here, not in `start.ts`,
 * so Settings › Local Data can follow it without loading the storage modules.
 */
export const storageStatus = shallowRef<StorageStatus | undefined>()

/** How many sessions Recent Sessions listed at its last read; undefined until it reads. */
export const recentSessionCount = shallowRef<number>()
