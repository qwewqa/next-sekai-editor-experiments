import { computed } from 'vue'
import { state } from '../history'
import { cullAllEntities, hitAllEntities, hitEntities } from '../history/store'
import { isToolModalOpen } from '../modals'
import { getPreviewState, previewEdit } from '../preview/edit'
import { hasSameChartData } from '../state/data'
import type { Entity, EntityType } from '../state/entities'
import type { SlideId } from '../state/entities/slides'
import type { NoteEntity } from '../state/entities/slides/note'
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

/**
 * Slides an edit's preview changes beyond its ghosts, drawn from the preview where the scene isn't:
 * an unmoved tick that becomes the slide's end.
 */
export const previewSlides = computed(() => {
    const ghosts = view.entities.creating
    const edit = previewEdit.value
    if (isScenePreview.value || !ghosts.length || !edit) return
    const source = state.value
    if (!hasSameChartData(source, edit.source)) return
    // Only slides with a tick can gain one as an end; the rest skip building the preview.
    const slideIds = new Set<SlideId>()
    for (const ghost of ghosts) {
        if (ghost.type !== 'note' || slideIds.has(ghost.slideId)) continue
        const notes = source.store.slides.note.get(ghost.slideId)
        if (notes?.some((note, i) => note.isAttached && i > 0 && i < notes.length - 1))
            slideIds.add(ghost.slideId)
    }
    if (!slideIds.size) return
    const preview = edit.resolve()
    if (!isSameTempo(preview.bpms, source.bpms)) return
    const moved = new Set(preview.selectedEntities)
    for (const id of slideIds) {
        const notes = preview.store.slides.note.get(id) ?? []
        const before = source.store.slides.note.get(id) ?? []
        // An end that was a tick: ends keep their entity unless moved or replaced.
        const isNewTickEnd = (note: NoteEntity | undefined, end: NoteEntity | undefined) =>
            !!note?.isAttached && note !== end && !moved.has(note)
        if (!isNewTickEnd(notes[0], before[0]) && !isNewTickEnd(notes.at(-1), before.at(-1)))
            slideIds.delete(id)
    }
    if (!slideIds.size) return
    const entities = [...slideIds].flatMap((id): Entity[] => [
        ...(preview.store.slides.note.get(id) ?? []),
        ...(preview.store.slides.connector.get(id) ?? []),
    ])
    return {
        state: preview,
        entities: new Set(entities),
        /** Whether an entity, from either state, belongs to a previewed slide. */
        includes: (entity: Entity) =>
            entity.type === 'note'
                ? slideIds.has(entity.slideId)
                : entity.type === 'connector' && slideIds.has(entity.head.slideId),
    }
})

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
