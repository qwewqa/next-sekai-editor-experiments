import type { Chart } from '../chart'
import { addToGroups, type Groups } from '../chart/groups'
import { addDefaultStageToStages, type Stages } from '../chart/stages'
import { closeElevationEditor, isElevationSideBySide } from '../editor/elevation/state'
import { switchToolTo } from '../editor/tools'
import { i18n } from '../i18n'
import { platform } from '../platform'
import { createState, type State, type StateExtras } from '../state'
import { cleanupWaveform } from '../waveform'
import { setFileEventMessages } from './markers'
import { notifyResetState } from './resetHooks'
import { createSessionDescriptor, session, type SessionDescriptor } from './session'
import { isDirty, resetStates, restoreStates, type RestoredSlot } from './stack'

export { markExported, markSaved } from './markers'
export {
    canUndo,
    isDirty,
    isPeeking,
    isPristine,
    liveState,
    peek,
    pushState,
    redoState,
    replaceState,
    restoreStates,
    setSlotLoader,
    slotLoading,
    state,
    undoState,
} from './stack'

const createDefaultChart = (): Chart => {
    const groups: Groups = new Map()
    addToGroups(groups)

    const stages: Stages = new Map()
    addDefaultStageToStages(stages)

    return {
        initialLife: 1000,
        isDynamicStages: false,
        bpms: [
            {
                beat: 0,
                bpm: 60,
                meter: 4,
            },
        ],
        groups,
        stages,
        cameraEvents: [],
        stageMaskEvents: [],
        stagePivotEvents: [],
        stageStyleEvents: [],
        stageTransformEvents: [],
        timeScales: [],
        slides: [],
    }
}

resetStates({
    isDirty: false,
    name: () => i18n.value.history.initialize,
    state: createState(createDefaultChart(), 0),
})

export let levelDataHandle: FileSystemFileHandle | undefined

/**
 * Named stub until Step 6's close prompts: today's leave prompt, on the current slot's `isDirty`,
 * which a slot keeps while its state is unloaded (§1.11.3).
 */
export const isDirtyCompat = () => !isDirty.value

platform.onCloseRequested(isDirtyCompat)

setFileEventMessages(() => i18n.value)

/**
 * Starts over with a chart, or the default one, in a session (§1.3.5): the
 * descriptor's missing ids are fresh. The level-data handle is cleared; an
 * open sets it again afterwards.
 */
export const resetState = (
    isDirty: boolean,
    chart?: Chart,
    offset?: number,
    descriptor?: Partial<SessionDescriptor>,
    extras?: StateExtras,
) => {
    if (!isElevationSideBySide.value) closeElevationEditor()
    session.value = createSessionDescriptor(descriptor)
    resetStates(
        {
            isDirty,
            name: () => i18n.value.history.initialize,
            state: createState(chart ?? createDefaultChart(), offset ?? 0, extras),
        },
        chart ? 'import' : 'new',
    )
    setLevelDataHandle(undefined)

    cleanupWaveform()

    switchToolTo('select')

    notifyResetState()
}

/**
 * Opens a stored session's stack (§1.3.8: a reload, a new visit, Reopen): its slots lazy, the
 * head given loaded, in the session the descriptor names. Nothing is emitted: the storage side
 * starts the session itself.
 */
export const openStoredState = (
    descriptor: SessionDescriptor,
    slots: readonly RestoredSlot[],
    at: number,
    head: State,
) => {
    if (!isElevationSideBySide.value) closeElevationEditor()
    session.value = descriptor
    restoreStates(slots, at, head)
    setLevelDataHandle(undefined)
    cleanupWaveform()
    switchToolTo('select')
    notifyResetState()
}

/**
 * Starts a new session with a whole state brought in (a journal opened from Local Data, §1.6.7):
 * stored at once, as an import is.
 */
export const openState = (state: State, descriptor?: Partial<SessionDescriptor>) => {
    if (!isElevationSideBySide.value) closeElevationEditor()
    session.value = createSessionDescriptor(descriptor)
    resetStates({ isDirty: true, name: () => i18n.value.entry.recovered, state }, 'import')
    setLevelDataHandle(undefined)
    cleanupWaveform()
    switchToolTo('select')
    notifyResetState()
}

export const setLevelDataHandle = (handle: FileSystemFileHandle | undefined) => {
    levelDataHandle = handle
}
