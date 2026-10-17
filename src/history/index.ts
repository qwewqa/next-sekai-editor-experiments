import type { Chart } from '../chart'
import { addToGroups, type Groups } from '../chart/groups'
import { addDefaultStageToStages, type Stages } from '../chart/stages'
import { closeElevationEditor, isElevationSideBySide } from '../editor/elevation/state'
import { switchToolTo } from '../editor/tools'
import { i18n } from '../i18n'
import { showModal } from '../modals'
import ConfirmModal from '../modals/ConfirmModal.vue'
import { platform } from '../platform'
import { createState, type StateExtras } from '../state'
import { interpolate } from '../utils/interpolate'
import { cleanupWaveform } from '../waveform'
import { resetAutoSave } from './autoSave/index.ts'
import { notifyResetState } from './resetHooks'
import { createSessionDescriptor, session, type SessionDescriptor } from './session'
import { isDirty, markFileEvent, resetStates } from './stack'

export {
    canUndo,
    isDirty,
    isPeeking,
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

/** Records an export of the live state as an `export` entry, "Exported {0}" (§1.3.8). */
export const markExported = (fileName: string) => {
    markFileEvent(
        'export',
        interpolate(() => i18n.value.entry.exported, fileName),
    )
}

export const checkState = async () => {
    if (!isDirty.value) return true

    return await showModal(ConfirmModal, {
        title: () => i18n.value.history.changes.title,
        message: () => i18n.value.history.changes.message,
    })
}

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

    resetAutoSave()
    cleanupWaveform()

    switchToolTo('select')

    notifyResetState()
}

export const setLevelDataHandle = (handle: FileSystemFileHandle | undefined) => {
    levelDataHandle = handle
}
