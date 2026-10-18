import { setVerticalScale } from '../../editor/navigation'
import { view } from '../../editor/view'
import { openState, openStoredState } from '../../history'
import type { State } from '../../state'
import type { Shown } from './open'

// The editor side of opening a session (Part 1 §1.4.2): what `open.ts` decides, shown. Apart, so
// the decisions run in the Node tests without the editor's modules.

/** The view as the session last left it (§1.6.11.2's `view`). */
const restoreView = (stored: unknown, state: State) => {
    if (typeof stored !== 'object' || stored === null) return
    const { scroll, zoom, group, stage } = stored as Record<string, unknown>
    if (typeof scroll === 'number' && Number.isFinite(scroll)) view.time = Math.max(0, scroll)
    if (typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0) setVerticalScale(zoom)
    if (typeof group === 'number' && state.groups.has(group as never)) view.groupId = group as never
    if (typeof stage === 'number' && state.stages.has(stage as never)) view.stageId = stage as never
}

/** Shows an opened session: its stack with the head loaded, then its view. */
export const showSession = ({ descriptor, slots, at, state, view: stored }: Shown) => {
    openStoredState(descriptor, slots, at, state)
    restoreView(stored, state)
}

/** Shows a state as a new session, as Local Data's Open does. */
export const showState = (state: State, names: { name?: string; sourceName?: string }) => {
    openState(state, names)
}
