import type { Chart } from '../chart'
import { addToGroups, type Groups } from '../chart/groups'
import { addDefaultStageToStages, type Stages } from '../chart/stages'
import { closeElevationEditor, isElevationSideBySide } from '../editor/elevation/state'
import { switchToolTo } from '../editor/tools'
import { createState, type State, type StateExtras } from '../state'
import { cleanupWaveform } from '../waveform'
import { createHistoryOperation } from './createHistoryOperation'
import { captureStep } from './operations'
import { notifyResetState } from './resetHooks'
import { createSessionDescriptor, session, type SessionDescriptor } from './session'
import { resetStates, restoreStates, type RestoredSlot } from './stack'

export { markExported, markSaved } from './markers'
export {
    canUndo,
    earlierSteps,
    headStep,
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
    step: captureStep({
        kind: 'init',
        operation: createHistoryOperation({ id: 'nse.origin', data: { origin: 'new' } }),
    }),
    state: createState(createDefaultChart(), 0),
})

/**
 * Starts over with a chart, or the default one, in a session (§1.3.5): the
 * descriptor's missing ids are fresh.
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
            step: captureStep({
                kind: 'init',
                operation: createHistoryOperation({
                    id: 'nse.origin',
                    data: { origin: chart ? 'import' : 'new' },
                }),
            }),
            state: createState(chart ?? createDefaultChart(), offset ?? 0, extras),
        },
        chart ? 'import' : 'new',
    )
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
    earlier = false,
    installed?: () => boolean,
) => {
    if (!isElevationSideBySide.value) closeElevationEditor()
    session.value = descriptor
    restoreStates(slots, at, head, earlier)
    if (installed && !installed()) return
    cleanupWaveform()
    switchToolTo('select')
    notifyResetState()
}

/**
 * Starts a new session with a whole state brought in (a journal opened from Local Data, §1.6.7):
 * stored at once, as an import is.
 */
export const openState = (state: State, descriptor?: Partial<SessionDescriptor>) => {
    openPreparedState(state, descriptor, true, 'recovery')
}

/** Installs one prepared file-import state with the ordinary clean import semantics. */
export const resetImportedState = (state: State, descriptor?: Partial<SessionDescriptor>) => {
    openPreparedState(state, descriptor, false, 'import')
}

const openPreparedState = (
    state: State,
    descriptor: Partial<SessionDescriptor> | undefined,
    isDirty: boolean,
    origin: 'import' | 'recovery',
) => {
    if (!isElevationSideBySide.value) closeElevationEditor()
    session.value = createSessionDescriptor(descriptor)
    resetStates(
        {
            isDirty,
            step: captureStep({
                kind: 'init',
                operation: createHistoryOperation({
                    id: 'nse.origin',
                    data: { origin },
                }),
            }),
            state,
        },
        'import',
    )
    cleanupWaveform()
    switchToolTo('select')
    notifyResetState()
}
