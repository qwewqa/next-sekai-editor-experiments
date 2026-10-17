import type { Chart } from '../chart'
import { addToGroups, type Groups } from '../chart/groups'
import { addDefaultStageToStages, type Stages } from '../chart/stages'
import { closeElevationEditor, isElevationSideBySide } from '../editor/elevation/state'
import { switchToolTo } from '../editor/tools'
import { i18n } from '../i18n'
import { showModal } from '../modals'
import ConfirmModal from '../modals/ConfirmModal.vue'
import { platform } from '../platform'
import { createState } from '../state'
import { cleanupWaveform } from '../waveform'
import { resetAutoSave } from './autoSave/index.ts'
import { notifyResetState } from './resetHooks'
import { isDirty, resetStates } from './stack'

export {
    canUndo,
    isDirty,
    isPeeking,
    liveState,
    peek,
    pushState,
    redoState,
    replaceState,
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

platform.onCloseRequested(() => !isDirty.value)

export const checkState = async () => {
    if (!isDirty.value) return true

    return await showModal(ConfirmModal, {
        title: () => i18n.value.history.changes.title,
        message: () => i18n.value.history.changes.message,
    })
}

export const resetState = (
    isDirty: boolean,
    chart?: Chart,
    offset?: number,
    filename?: string,
    handle?: FileSystemFileHandle,
) => {
    if (!isElevationSideBySide.value) closeElevationEditor()
    resetStates({
        isDirty,
        name: () => i18n.value.history.initialize,
        state: createState(chart ?? createDefaultChart(), offset ?? 0, filename),
    })
    setLevelDataHandle(handle)

    resetAutoSave()
    cleanupWaveform()

    switchToolTo('select')

    notifyResetState()
}

export const setLevelDataHandle = (handle: FileSystemFileHandle | undefined) => {
    levelDataHandle = handle
}
