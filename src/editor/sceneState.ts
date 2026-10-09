import { computed } from 'vue'
import { state } from '../history'
import { cullAllEntities, hitAllEntities, hitEntities } from '../history/store'
import { isToolModalOpen } from '../modals'
import { getPreviewState } from '../preview/edit'
import type { EntityType } from '../state/entities'
import type { BpmIntegral } from '../state/integrals/bpms'
import { view } from './view'

const isSameTempo = (a: BpmIntegral[], b: BpmIntegral[]) =>
    a === b ||
    (a.length === b.length &&
        a.every((bpm, i) => bpm.x === b[i]?.x && bpm.y === b[i].y && bpm.s === b[i].s))

export const sceneState = computed(() => {
    if (isToolModalOpen.value) return getPreviewState(state.value)
    if (view.layout !== 'composed' || !state.value.isDynamicStages) return state.value
    // Pointers map through the committed tempo, so a retimed preview would slide away from them.
    const preview = getPreviewState(state.value)
    return isSameTempo(preview.bpms, state.value.bpms) ? preview : state.value
})
export const sceneBpms = computed(() => sceneState.value.bpms)
export const isScenePreview = computed(() => sceneState.value !== state.value)

export const cullAllSceneEntities = (minKey: number, maxKey: number) =>
    cullAllEntities(minKey, maxKey, sceneState.value.store)

export const hitSceneEntities = <T extends EntityType>(
    type: T,
    laneMin: number,
    laneMax: number,
    timeMin: number,
    timeMax: number,
    minimumNoteWidth = 0,
) => hitEntities(type, laneMin, laneMax, timeMin, timeMax, minimumNoteWidth, sceneState.value)

export const hitAllSceneEntities = (
    laneMin: number,
    laneMax: number,
    timeMin: number,
    timeMax: number,
    minimumNoteWidth = 0,
) => hitAllEntities(laneMin, laneMax, timeMin, timeMax, minimumNoteWidth, sceneState.value)
