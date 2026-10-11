import type { StageId } from '../../chart/stages'
import { state } from '../../history'
import { selectedEntities } from '../../history/selectedEntities'
import { hitAllEntities, hitEntities, store } from '../../history/store'
import type { State } from '../../state'
import type { Entity, EntityOfType, EntityType } from '../../state/entities'
import { editChanges } from '../../state/operations/properties/plan'
import { alignComputed, clamp, shiftComputed } from '../../utils/math'
import type { ComposedLayout } from '../composed'
import { getComposedGridOffset, getComposedLayout, getComposedOffset } from '../composedView'
import type { CanvasCursor } from '../controls/cursor'
import type { Modifiers } from '../controls/gestures/pointer'
import { orderHits } from '../hitModel'
import { editorNavigation } from '../navigation'
import { clearNotification } from '../notification'
import { sceneState, toCommittedEntity } from '../sceneState'
import { isEntityInScope, scopeLookup } from '../scope'
import { snappedOffset } from '../snapping'
import { alignLane, ups, view, viewBox, xToLane, yToTime, type Selection } from '../view'

export { isNoteResizeStart, isRangeResizeStart, isSelectResize } from './edges'

export const placementCursors: Record<'add' | 'edit' | 'move', CanvasCursor> = {
    add: 'crosshair',
    edit: 'ew-resize',
    move: 'move',
}

export const offset = (
    startLane: number,
    lane: number,
    anchor = startLane,
    origin = 0,
    moved?: number,
) => snappedOffset(startLane, lane, anchor - origin, view.laneDivision, view.laneSnapping, moved)

/** An add-drag's pressed edge at the current beat; in Composed it keeps its displayed lane. */
export const addDragAnchor = (
    press: { lane: number; beat: number; stageId: StageId },
    beat: number,
    stageId: StageId,
) => {
    if (!getComposedLayout() || (beat === press.beat && stageId === press.stageId))
        return press.lane
    const displayed = press.lane + getComposedOffset(press.stageId, press.beat)
    const origin = getComposedGridOffset(stageId, beat)
    return alignLane(displayed - getComposedOffset(stageId, beat) - origin) + origin
}

// A lane moved by the drag's offset, without float noise; unmoved, it stays exact.
// Moved is the pointer's displayed lane movement, when lane also carries a stage shift.
export const moveLane = (
    value: number,
    startLane: number,
    lane: number,
    anchor?: number,
    origin = 0,
    moved = lane - startLane,
) => shiftComputed(value, offset(startLane, lane, anchor, origin, moved))

/** Commits a drop; one that changes nothing adds no undo step, and its notice goes. */
export const commitDrop = <E extends Entity, O extends object>(
    commit: (entity: E, object: O) => void,
    entity: E,
    object: O,
) => {
    if (editChanges(store.value, entity, object)) {
        commit(entity, object)
        return
    }
    view.entities = { hovered: [], creating: [] }
    clearNotification()
}

export const getLaneAnchor = (entity: Entity) => {
    switch (entity.type) {
        case 'note':
            return entity.left
        case 'connector':
            return entity.head.left
        case 'cameraEventJoint':
            return entity.cameraLeft
        case 'stageMaskEventJoint':
            return entity.maskLeft
        case 'stagePivotEventJoint':
            return entity.pivotLane
        case 'stageTransformEventJoint':
            return entity.xTranslation
        case 'timeScale':
        case 'stageStyleEventJoint':
            return entity.editorLane
        case 'bpm':
        case 'cameraEventConnection':
        case 'stageMaskEventConnection':
        case 'stagePivotEventConnection':
        case 'stageStyleEventConnection':
        case 'stageTransformEventConnection':
            return undefined
    }
}

/** A dragged edge's snapped shift; a multi-selection resize moves every edge by the grabbed one's. */
export const resizeShift = (edge: number, lane: number, origin = 0) =>
    offset(edge, lane, edge, origin)

export const resize = (
    anchor: number,
    lane: number,
    min = 0,
    max = Number.POSITIVE_INFINITY,
    startEdge = anchor,
    original?: readonly [left: number, size: number],
    origin = 0,
    shift = resizeShift(startEdge, lane, origin),
) => {
    // An edge dragged back to its start keeps the values exactly.
    if (original && shift === 0) return original
    const edge = startEdge + shift
    const size = clamp(alignComputed(Math.abs(edge - anchor)), min, max)

    // The fixed edge stays as given; callers snap one that is a sum.
    return [lane >= anchor ? anchor : alignComputed(anchor - size), size] as const
}

/**
 * Ranked hits, the first a single pick's; `set` acts together: when a note's span holds the point,
 * notes reached only by side slack drop out, unless first.
 */
export type PointHits<T extends Entity = Entity> = { hits: T[]; set: T[] }

export const pointHitsOfType = <T extends EntityType>(
    type: T,
    x: number,
    y: number,
    minimumNoteWidth = 1.5,
): PointHits<EntityOfType<T>> => {
    const isType = (entity: Entity): entity is EntityOfType<T> => entity.type === type
    if (editorNavigation.value) {
        const { hits, set } = editorNavigation.value.hitPoint(x, y, minimumNoteWidth)
        return { hits: hits.filter(isType), set: set.filter(isType) }
    }
    return remember(type, x, y, minimumNoteWidth, () =>
        findPointHits(
            hitEntities(type, ...pointWindow(x, y), minimumNoteWidth, sceneState.value),
            x,
            y,
            minimumNoteWidth,
        ),
    )
}

export const pointHitsAt = (x: number, y: number, minimumNoteWidth = 1.5): PointHits =>
    editorNavigation.value
        ? editorNavigation.value.hitPoint(x, y, minimumNoteWidth)
        : remember(undefined, x, y, minimumNoteWidth, () =>
              findPointHits(
                  hitAllEntities(...pointWindow(x, y), minimumNoteWidth, sceneState.value),
                  x,
                  y,
                  minimumNoteWidth,
              ),
          )

// The hover and the cursor ask for the same point each frame; they share one answer.
let remembered: { key: unknown[]; hits: PointHits<never> } | undefined
const remember = <T extends Entity>(
    type: EntityType | undefined,
    x: number,
    y: number,
    minimumNoteWidth: number,
    find: () => PointHits<T>,
): PointHits<T> => {
    const key = [
        type,
        x,
        y,
        minimumNoteWidth,
        state.value,
        sceneState.value,
        viewBox.value,
        view.x,
        view.y,
        view.w,
        view.h,
        view.layout,
        // Read through, as a change in place keeps its identity.
        Object.values(view.visibilities).join(),
        scopeLookup.value,
    ]
    if (remembered?.key.every((value, i) => value === key[i])) return remembered.hits
    const hits = find()
    remembered = { key, hits: hits as PointHits<never> }
    return hits
}

/** A selected object in reach, as the set counts them. */
export const selectedHit = <T extends Entity>({ set }: PointHits<T>) =>
    set.find((entity) => selectedEntities.value.includes(entity))

/** What a press takes: a selected object in reach, else the first hit. */
export const pressTarget = <T extends Entity>(hits: PointHits<T>) =>
    selectedHit(hits) ?? hits.hits[0]

// 10 pixels around a point, in lanes and times.
const pointWindow = (x: number, y: number) =>
    [xToLane(x - 10), xToLane(x + 10), yToTime(y + 10), yToTime(y - 10)] as const

/** Orders point hits as the hit model says. */
export const orderPointHits = <T extends Entity>(
    hits: T[],
    x: number,
    y: number,
    source: State = state.value,
    composed: ComposedLayout | undefined = getComposedLayout(source),
) => orderHits(hits, xToLane(x), yToTime(y), ups.value, source, composed)

// A previewed scene is hit where it is shown, as the committed objects it shows.
const findPointHits = <T extends Entity>(
    entities: T[],
    x: number,
    y: number,
    minimumNoteWidth: number,
): PointHits<T> => {
    const source = sceneState.value
    const composed = getComposedLayout(source)
    const visible = entities.filter(isVisible)
    const lane = xToLane(x)
    const isDirectNote = (entity: T) => {
        const hitbox = composed ? composed.hitbox(entity) : entity.hitbox
        return (
            entity.type === 'note' &&
            !!hitbox &&
            lane >= hitbox.lane - Math.max(hitbox.w, minimumNoteWidth / 2) &&
            lane <= hitbox.lane + Math.max(hitbox.w, minimumNoteWidth / 2)
        )
    }
    const filtered = visible.some(isDirectNote)
    const shown = orderPointHits(visible, x, y, source, composed).flatMap((entity) => {
        const committed = toCommittedEntity(entity)
        return committed
            ? [{ committed, inSet: !filtered || entity.type !== 'note' || isDirectNote(entity) }]
            : []
    })
    return {
        hits: shown.map(({ committed }) => committed),
        set: shown.flatMap(({ committed, inSet }, i) => (!i || inSet ? [committed] : [])),
    }
}

export const hitEntitiesInSelection = <T extends EntityType>(type: T, selection: Selection) =>
    hitEntities(
        type,
        selection.laneMin,
        selection.laneMax,
        selection.timeMin,
        selection.timeMax,
    ).filter(isVisible)

export const hitAllEntitiesInSelection = (selection: Selection) =>
    hitAllEntities(
        selection.laneMin,
        selection.laneMax,
        selection.timeMin,
        selection.timeMax,
    ).filter(isVisible)

export const modifyEntities = (entities: Entity[], modifiers: Modifiers) => {
    if (!modifiers.shift) return entities

    const allEntities = new Set(entities)

    for (const entity of entities) {
        if (entity.type !== 'note') continue

        const notes = store.value.slides.note.get(entity.slideId)
        if (!notes) continue

        // Slides can span groups and stages; never extend into hidden ones.
        for (const note of notes) {
            if (isEntityInScope(note)) allEntities.add(note)
        }
    }

    return [...allEntities]
}

export const toSelection = (startLane: number, startTime: number, x: number, y: number) => {
    let laneMin = startLane
    let timeMin = startTime
    let laneMax = xToLane(x)
    let timeMax = yToTime(y)

    if (laneMin > laneMax) [laneMin, laneMax] = [laneMax, laneMin]
    if (timeMin > timeMax) [timeMin, timeMax] = [timeMax, timeMin]

    return {
        laneMin,
        laneMax,
        timeMin,
        timeMax,
    }
}

/**
 * Whether an entity can be hovered, hit-tested, selected and edited: its type
 * is shown and its group and stage scopes are fully visible. Dimmed entities
 * are drawn but never interactive; connectors and event connections are never
 * hit directly.
 */
export const isVisible = (entity: Entity) => {
    if (!view.visibilities[entity.type]) return false

    switch (entity.type) {
        case 'cameraEventConnection':
        case 'stageMaskEventConnection':
        case 'stagePivotEventConnection':
        case 'stageStyleEventConnection':
        case 'stageTransformEventConnection':
        case 'connector':
            return false
        case 'bpm':
        case 'timeScale':
        case 'cameraEventJoint':
        case 'stageMaskEventJoint':
        case 'stagePivotEventJoint':
        case 'stageStyleEventJoint':
        case 'stageTransformEventJoint':
        case 'note':
            return isEntityInScope(entity)
    }
}
