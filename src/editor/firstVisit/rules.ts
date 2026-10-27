import type { StartupPhase } from '../../startup/gate'
import { LOAD_ORDER } from '../loadOrder'

// When the first-visit dialog shows: the rules, apart from the page they read, so they can be tested
// alone.

/** The localStorage key of the revision of the dialog last shown in this browser. */
export const FIRST_VISIT_KEY = 'firstVisitShown'

/** Raised to show the dialog once more, as after a material change to the privacy notice. */
export const FIRST_VISIT_REVISION = 1

/**
 * The load notices that may stay on the start-up card under the dialog: Continued, said at every
 * returning load, and the in-app browser line, said at every load in such a browser. Any other
 * defers the dialog to a later load, or closes it when it comes while the dialog is open.
 */
const ALLOWED_UNDER: ReadonlySet<number> = new Set([LOAD_ORDER.continued, LOAD_ORDER.inAppBrowser])

/** Whether these load notices, by their `LOAD_ORDER`, keep the dialog away. */
export const blocking = (orders: readonly number[]) =>
    orders.some((order) => !ALLOWED_UNDER.has(order))

/** The revision a stored mark records; anything but a whole number reads as none. */
export const storedRevision = (stored: unknown) =>
    typeof stored === 'number' && Number.isInteger(stored) ? stored : 0

/** What is known at module evaluation, before the page loads anything. */
export type DueFacts = {
    /** The build has a privacy page or somewhere to send usage statistics. */
    offered: boolean
    safeMode: boolean
    /** The stored mark, as read. */
    stored: unknown
}

/** Whether this load may show the dialog: the build offers it, outside safe mode, and it was not shown. */
export const isDue = ({ offered, safeMode, stored }: DueFacts) =>
    offered && !safeMode && storedRevision(stored) < FIRST_VISIT_REVISION

/** What is known when the startup gate lifts, and again when a hidden page becomes visible. */
export type OpenFacts = DueFacts & {
    phase: StartupPhase
    /** A load notice other than the allowed ones is on the start-up card. */
    blocking: boolean
    /** Another dialog that holds the editor is open. */
    modalOpen: boolean
    visible: boolean
    /** Writes the mark and reads it back: false when storage cannot keep it. */
    keep: () => boolean
}

/**
 * Whether to show the dialog now, wait for the page to become visible, or skip it at this load. The
 * mark is written last, as it opens, so a reload with it open counts as shown, and a browser that
 * cannot keep the mark never shows it at every load.
 */
export const firstVisitDue = (facts: OpenFacts): 'show' | 'waitVisible' | 'skip' => {
    if (!isDue(facts) || facts.phase !== 'done' || facts.blocking || facts.modalOpen) return 'skip'
    if (!facts.visible) return 'waitVisible'
    return facts.keep() ? 'show' : 'skip'
}
