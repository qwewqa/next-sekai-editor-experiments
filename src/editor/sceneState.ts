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
import { beatToKey } from '../state/store/grid'
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
    if (isScenePreview.value || !ghosts.length || !edit) return
    const source = state.value
    if (!hasSameChartData(source, edit.source)) return
    // Only slides with a tick can move one; the rest skip building the preview.
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

/**
 * A previewed scene's replaced entities and the committed ones they show: an
 * edit's objects keep their place in the selection, and a slide's other notes,
 * such as attached ticks, their order. What can't be paired is left out.
 */
export const sceneCounterparts = computed(() => {
    const scene = sceneState.value
    const source = state.value
    if (scene === source) return
    const toSource = new Map<Entity, Entity>()
    const toScene = new Map<Entity, Entity>()
    const pair = (shown: Entity, committed: Entity) => {
        if (shown === committed || shown.type !== committed.type || toSource.has(shown)) return
        toSource.set(shown, committed)
        toScene.set(committed, shown)
    }
    if (scene.selectedEntities.length === source.selectedEntities.length)
        for (const [i, entity] of scene.selectedEntities.entries())
            pair(entity, source.selectedEntities[i] ?? entity)
    const slideIds = new Set(
        scene.selectedEntities.flatMap((entity) =>
            entity.type === 'note' ? [entity.slideId] : [],
        ),
    )
    for (const id of slideIds) {
        const before = source.store.slides.note.get(id) ?? []
        const after = scene.store.slides.note.get(id) ?? []
        const kept = new Set(before)
        const shown = new Set(after)
        const added = after.filter((note) => !kept.has(note) && !toSource.has(note))
        const removed = before.filter((note) => !shown.has(note) && !toScene.has(note))
        if (added.length === removed.length)
            for (const [i, note] of added.entries()) pair(note, removed[i] ?? note)
    }
    return { toSource, toScene }
})

/** The committed entity a scene entity shows, if any. */
export const toCommittedEntity = <T extends Entity>(entity: T) => {
    const counterparts = sceneCounterparts.value
    if (!counterparts) return entity
    const committed = counterparts.toSource.get(entity)
    if (committed) return committed as T
    const grid = state.value.store.grid[entity.type] as Map<number, Set<Entity>>
    return grid.get(beatToKey(entity.beat))?.has(entity) ? entity : undefined
}

/** The entity the scene shows for a committed one. */
export const toSceneEntity = <T extends Entity>(entity: T) =>
    (sceneCounterparts.value?.toScene.get(entity) as T | undefined) ?? entity
