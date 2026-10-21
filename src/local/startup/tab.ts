import { platform } from '../../platform'
import type { LockService } from '../../platform/types'
import { storageKey } from '../../storage'
import { sessionLock } from '../locks'
import type { CopyOf } from '../names'
import { tryLease, type LockLease } from '../sessions'

// What a tab remembers across its own reloads (Part 1 §1.4.2): the open session, in
// sessionStorage, which survives reloads of that tab only (and a Duplicate Tab copies it), and the
// marker written on `pagehide` and `freeze`, which only shortens the wait for a late flush. The
// rule itself is the session lock: free, it's a reload; held by another tab, a Duplicate Tab.

/** The open session as the tab remembers it. */
export type TabRecord = {
    sessionId: string
    /**
     * How it began, for a reload that finds no row: a blank start reloads by the new-visit rule,
     * a New as blank, and an unstored continuation continues its parent again.
     */
    start: 'blank' | 'new' | 'stored' | 'continuation'
    /** An unstored continuation's parent. */
    parent?: string
    /** A separate copy: the file or session it was made from (the status label's). */
    copyOf?: CopyOf
}

const TAB_KEY = storageKey('tab')
/** `nse.unloaded`: the session whose page went away on `pagehide` or `freeze`. */
const MARKER_KEY = storageKey('unloaded')

const session = () => {
    try {
        return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
    } catch {
        return undefined
    }
}

const isRecord = (value: unknown): value is TabRecord =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TabRecord).sessionId === 'string' &&
    ['blank', 'new', 'stored', 'continuation'].includes((value as TabRecord).start)

/** The session this tab had open before this load, if any. */
export const readTabRecord = (): TabRecord | undefined => {
    try {
        const text = session()?.getItem(TAB_KEY)
        const value = text ? (JSON.parse(text) as unknown) : undefined
        return isRecord(value) ? value : undefined
    } catch {
        return
    }
}

export const writeTabRecord = (record: TabRecord) => {
    try {
        session()?.setItem(TAB_KEY, JSON.stringify(record))
    } catch {
        // Without sessionStorage a reload is a new visit.
    }
}

/** The session whose page went away, as the marker says; read once at load. */
export const readMarker = (): string | undefined => {
    try {
        return session()?.getItem(MARKER_KEY) ?? undefined
    } catch {
        return
    }
}

const clearMarker = () => {
    try {
        session()?.removeItem(MARKER_KEY)
    } catch {
        // Nothing to clear.
    }
}

let watching = false

/**
 * Writes the marker when the page hides (`pagehide`, or hidden) and on `freeze`, and clears it
 * when it shows again, so a page restored from the back-forward cache, or a resumed one, leaves
 * none for a later Duplicate Tab. A marker left by a hidden tab only makes a Duplicate Tab wait.
 */
export const watchMarker = (current: () => string | undefined) => {
    clearMarker()
    if (watching || typeof window === 'undefined') return
    watching = true
    // A page restored from the back-forward cache, or resumed after a freeze (§1.4.2).
    window.addEventListener('pageshow', clearMarker)
    document.addEventListener('resume', clearMarker)
    platform.onLifecycle((event) => {
        if (event === 'show') {
            clearMarker()
            return
        }
        const id = current()
        if (!id) return
        try {
            session()?.setItem(MARKER_KEY, id)
        } catch {
            // Without the marker the reload takes the lock without waiting.
        }
    })
}

/** The wait for a late flush from the page that went away (§1.6.6: about 2 s). */
export const MARKER_WAIT_MS = 2000

/**
 * Takes a session's lock exclusively, as a reload does: at once when free, or with `waitMs`, a
 * blocking request capped at that long. Undefined when another tab holds it (or held it past
 * the wait): a Duplicate Tab.
 */
export const claimSessionLock = async (
    locks: LockService,
    sessionId: string,
    waitMs = 0,
): Promise<LockLease | undefined> => {
    const controller = new AbortController()
    const timer =
        waitMs > 0
            ? setTimeout(() => {
                  controller.abort()
              }, waitMs)
            : undefined
    const options = waitMs > 0 ? { signal: controller.signal } : { ifAvailable: true }
    return tryLease(locks, sessionLock(sessionId), options).finally(() => {
        clearTimeout(timer)
    })
}
