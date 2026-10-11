import { computed } from 'vue'
import { state } from '../history'
import { cullAllEntities, hitAllEntities, hitEntities } from '../history/store'
import { isToolModalOpen } from '../modals'
import { getPreviewState, previewEdit } from '../preview/edit'
import type { State } from '../state'
import { hasSameChartData } from '../state/data'
import type { Entity, EntityType } from '../state/entities'
import type { SlideId } from '../state/entities/slides'
import { isInteriorTick, type NoteEntity } from '../state/entities/slides/note'
import { isSameTempo, type GridBpm } from '../state/integrals/bpms'
import { beatToKey } from '../state/store/grid'
import { dragBpms, gridOf } from './beatGrid'
import { view } from './view'

export const sceneState = computed(() => {
    // A dialog's own preview, such as a scaling's, may retime; a Properties draft in one may not.
    if (isToolModalOpen.value && !previewEdit.value?.isDraft) return getPreviewState(state.value)
    // Composed shows every edit's preview; Basic a pending Properties draft's.
    if ((view.layout !== 'composed' || !state.value.isDynamicStages) && !previewEdit.value?.isDraft)
        return state.value
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
        if (notes?.some(isInteriorTick)) slideIds.add(ghost.slideId)
    }
    if (!slideIds.size) return
    const preview = edit.resolve()
    if (!isSameTempo(preview.bpms, source.bpms)) return
    const moved = new Set(preview.selectedEntities)
    for (const id of slideIds) {
        const before = source.store.slides.note.get(id) ?? []
        const kept = new Set(before)
        const interior = new Set(before.filter(isInteriorTick))
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

/** The bars drawn: during a scaling drag, those at its press. */
export const drawnBpms = computed<GridBpm[]>(() => dragBpms.value ?? sceneBpms.value)
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

type Counterparts = { toSource: Map<Entity, Entity>; toScene: Map<Entity, Entity> }
const counterparts = new WeakMap<State, WeakMap<State, Counterparts>>()

// Pairs a preview's replaced entities with committed ones: by selection place, else slide order.
const counterpartsOf = (source: State, preview: State) => {
    let bySource = counterparts.get(preview)
    const cached = bySource?.get(source)
    if (cached) return cached
    const toSource = new Map<Entity, Entity>()
    const toScene = new Map<Entity, Entity>()
    const pair = (shown: Entity, committed: Entity) => {
        if (shown === committed || shown.type !== committed.type || toSource.has(shown)) return
        toSource.set(shown, committed)
        toScene.set(committed, shown)
    }
    if (preview.selectedEntities.length === source.selectedEntities.length)
        for (const [i, entity] of preview.selectedEntities.entries())
            pair(entity, source.selectedEntities[i] ?? entity)
    const slideIds = new Set(
        preview.selectedEntities.flatMap((entity) =>
            entity.type === 'note' ? [entity.slideId] : [],
        ),
    )
    for (const id of slideIds) {
        const before = source.store.slides.note.get(id) ?? []
        const after = preview.store.slides.note.get(id) ?? []
        const kept = new Set(before)
        const shown = new Set(after)
        const added = after.filter((note) => !kept.has(note) && !toSource.has(note))
        const removed = before.filter((note) => !shown.has(note) && !toScene.has(note))
        if (added.length === removed.length)
            for (const [i, note] of added.entries()) pair(note, removed[i] ?? note)
    }
    const result = { toSource, toScene }
    if (!bySource) counterparts.set(preview, (bySource = new WeakMap()))
    bySource.set(source, result)
    return result
}

export const sceneCounterparts = computed(() =>
    sceneState.value === state.value ? undefined : counterpartsOf(state.value, sceneState.value),
)

/** The committed entity a previewed state's entity shows, if any; the scene's by default. */
export const toCommittedEntity = <T extends Entity>(entity: T, preview = sceneState.value) => {
    const source = state.value
    if (preview === source) return entity
    const committed = counterpartsOf(source, preview).toSource.get(entity)
    if (committed) return committed as T
    const grid = source.store.grid[entity.type] as Map<number, Set<Entity>>
    return grid.get(beatToKey(entity.beat))?.has(entity) ? entity : undefined
}

/** The entity a previewed state shows for a committed one; the scene's by default. */
export const toSceneEntity = <T extends Entity>(entity: T, preview = sceneState.value) =>
    preview === state.value
        ? entity
        : ((counterpartsOf(state.value, preview).toScene.get(entity) as T | undefined) ?? entity)

/** An entity as a pending Properties draft shows it, as the click that commits the draft will read it. */
export const withDraft = <T extends Entity>(entity: T) =>
    previewEdit.value?.isDraft ? toSceneEntity(entity) : entity
