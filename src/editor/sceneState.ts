import { computed } from 'vue'
import { state } from '../history'
import { cullAllEntities, hitAllEntities, hitEntities } from '../history/store'
import { isToolModalOpen } from '../modals'
import { getPreviewState, previewEdit } from '../preview/edit'
import { hasSameChartData } from '../state/data'
import type { Entity, EntityType } from '../state/entities'
import type { SlideId } from '../state/entities/slides'
import type { NoteEntity } from '../state/entities/slides/note'
import type { BpmIntegral, GridBpm } from '../state/integrals/bpms'
import { gridOf, liftedDrawnBpms } from './beatGrid'
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
 * those whose unmoved ticks move along their connector or become an end.
 */
export const previewSlides = computed(() => {
    const ghosts = view.entities.creating
    const edit = previewEdit.value
    // Only drags: a pending Properties edit under a hover ghost isn't drawn.
    if (isScenePreview.value || !ghosts.length || !edit?.isDrag) return
    const source = state.value
    if (!hasSameChartData(source, edit.source)) return
    // Only slides with a tick can move one; the rest skip building the preview.
    const slideIds = new Set<SlideId>()
    const checked = new Set<SlideId>()
    for (const ghost of ghosts) {
        if (ghost.type !== 'note' || checked.has(ghost.slideId)) continue
        checked.add(ghost.slideId)
        const notes = source.store.slides.note.get(ghost.slideId)
        if (notes?.some((note, i) => note.isAttached && i > 0 && i < notes.length - 1))
            slideIds.add(ghost.slideId)
    }
    if (!slideIds.size) return
    const preview = edit.resolve()
    if (!isSameTempo(preview.bpms, source.bpms)) return
    const moved = new Set(preview.selectedEntities)
    for (const id of slideIds) {
        const before = source.store.slides.note.get(id) ?? []
        const kept = new Set(before)
        const interior = new Set(before.slice(1, -1).filter((note) => note.isAttached))
        const notes = preview.store.slides.note.get(id) ?? []
        // A tick keeps its entity while its place holds; one that changes is replaced.
        const moves = (note: NoteEntity, index: number) =>
            note.isAttached &&
            !moved.has(note) &&
            (interior.has(note) ? index === 0 || index === notes.length - 1 : !kept.has(note))
        if (!notes.some(moves)) slideIds.delete(id)
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

/** The bars drawn: during a BPM change move, without the moved changes once they move. */
export const drawnBpms = computed<GridBpm[]>(() => liftedDrawnBpms.value ?? sceneBpms.value)
export const drawnGrid = computed(() => gridOf(drawnBpms.value))

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
