import type { State } from '../state'
import type { Entity, EntityType } from '../state/entities'
import { createSlideInfoLookup } from '../state/entities/slides/lookup'
import type { NoteEntity } from '../state/entities/slides/note'
import type { SlideNoteInfo } from '../state/entities/slides/semantics'
import { getNoteVisualType, type NoteVisualType } from '../state/entities/slides/visualType'
import { beatToTime } from '../state/integrals/bpms'
import { clamp } from '../utils/math'
import { isInRaisedChain, raisedOf } from './canvas/ordering'
import type { ComposedLayout } from './composed'

// The hit model, the ground truth for picking; drawing follows it (hitModelConsistency.spec).
// Within 10 px, hits on a primary shape go first: time scale markers, then joints of raised chains
// unless a selected object is hit, then by precedence, earlier beat, later in the grid;
// the rest nearest first, then by type. Flick arrows, names and outlines are decoration.

export type Box = { l: number; r: number; t: number; b: number }
export type Shape = { boxes: Box[]; diamond?: number }

// Each slide's roles, found without searching it.
const slideInfoLookup = createSlideInfoLookup()

const MARKER = 0.1
const TIME_SCALE_MARKER = 0.135

const precedence: EntityType[] = [
    'timeScale',
    'note',
    'stageTransformEventJoint',
    'stageStyleEventJoint',
    'stagePivotEventJoint',
    'stageMaskEventJoint',
    'cameraEventJoint',
    'bpm',
]

// Reach order by type, for objects equally near.
const typeOrder: EntityType[] = [
    'note',
    'stageTransformEventJoint',
    'stageStyleEventJoint',
    'stagePivotEventJoint',
    'stageMaskEventJoint',
    'cameraEventJoint',
    'timeScale',
    'bpm',
]

const comparePointHitTypes = (a: Entity, b: Entity) =>
    typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type)

/** A note's primary shape, from its left edge and its middle. */
const noteHitShape = (size: number, type: NoteVisualType): Shape => {
    const half = type === 'single' || type === 'head' || type === 'tail' ? 0.3 : 0.15
    const [l, r] = size > 0 ? [0, size] : [-0.1, 0.1]
    return {
        boxes: [{ l, r, t: -half, b: half }],
        diamond: (type === 'tick' || type === 'trace') && size > 0 ? size / 2 : undefined,
    }
}

/** A note's primary shape at a shown size, from its left edge and its middle. */
export const shownNoteHitShape = (
    note: NoteEntity,
    size: number,
    infos: readonly SlideNoteInfo[] | undefined,
) =>
    noteHitShape(
        size,
        getNoteVisualType(
            size === note.size ? note : { ...note, size, useInfoOf: note.useInfoOf ?? note },
            infos,
            infos && slideInfoLookup(infos),
        ),
    )

const markerBox = (x: number, half: number): Box => ({
    l: x - half,
    r: x + half,
    t: -half,
    b: half,
})

const eventHitShape = (entity: Entity): Shape | undefined => {
    switch (entity.type) {
        case 'cameraEventJoint':
            return {
                boxes: [
                    markerBox(entity.cameraLeft, MARKER),
                    markerBox(entity.cameraLeft + entity.cameraSize, MARKER),
                ],
            }
        case 'stageMaskEventJoint':
            return {
                boxes: [
                    markerBox(entity.maskLeft, MARKER),
                    markerBox(entity.maskLeft + entity.maskSize, MARKER),
                ],
            }
        case 'stagePivotEventJoint':
            return { boxes: [markerBox(entity.pivotLane, MARKER)] }
        case 'stageStyleEventJoint':
            return { boxes: [markerBox(entity.editorLane, MARKER)] }
        case 'stageTransformEventJoint':
            return { boxes: [markerBox(entity.xTranslation, MARKER)] }
        case 'timeScale':
            return { boxes: [markerBox(entity.editorLane, TIME_SCALE_MARKER)] }
        case 'bpm': {
            const box = entity.hitbox
            return (
                box && {
                    boxes: [{ l: box.lane - box.w, r: box.lane + box.w, t: -box.h, b: box.h }],
                }
            )
        }
        case 'note':
        case 'cameraEventConnection':
        case 'stageMaskEventConnection':
        case 'stagePivotEventConnection':
        case 'stageStyleEventConnection':
        case 'stageTransformEventConnection':
        case 'connector':
            return
    }
}

const segmentDistance = (
    x: number,
    y: number,
    [x1, y1]: readonly [number, number],
    [x2, y2]: readonly [number, number],
) => {
    const dx = x2 - x1
    const dy = y2 - y1
    const t = clamp(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy), 0, 1)
    return Math.hypot(x - x1 - t * dx, y - y1 - t * dy)
}

// From a diamond 0.3 lanes out and up and 0.15 down from its middle.
const diamondDistance = (x: number, y: number) => {
    if (Math.abs(x) / 0.3 + (y < 0 ? -y / 0.3 : y / 0.15) <= 1) return 0
    const [left, top, right, bottom] = [
        [-0.3, 0],
        [0, -0.3],
        [0.3, 0],
        [0, 0.15],
    ] as const
    return Math.min(
        segmentDistance(x, y, left, top),
        segmentDistance(x, y, top, right),
        segmentDistance(x, y, right, bottom),
        segmentDistance(x, y, bottom, left),
    )
}

/** How far a point, in lanes and across from an object's line, is from a shape: 0 on it. */
export const shapeDistance = ({ boxes, diamond }: Shape, x: number, y: number) =>
    Math.min(
        ...boxes.map(({ l, r, t, b }) =>
            Math.hypot(Math.max(l - x, 0, x - r), Math.max(t - y, 0, y - b)),
        ),
        diamond === undefined ? Number.POSITIVE_INFINITY : diamondDistance(x - diamond, y),
    )

/** An object's primary shape, in lanes across the chart and from its line. */
export const hitShapeOf = (
    entity: Entity,
    source: State,
    composed: ComposedLayout | undefined,
): Shape | undefined => {
    if (entity.type !== 'note') return eventHitShape(entity)
    const note: NoteEntity = entity
    const position = composed?.notePosition(note) ?? note
    const { boxes, diamond } = shownNoteHitShape(
        note,
        position.size,
        source.store.slides.info.get(note.slideId),
    )
    return {
        boxes: boxes.map(({ l, r, t, b }) => ({
            l: l + position.left,
            r: r + position.left,
            t,
            b,
        })),
        diamond: diamond === undefined ? undefined : diamond + position.left,
    }
}

/** Hits on their shape first, the rest nearest first, by their shapes' distances. */
export const compareShapeDistance = (a: number, b: number) =>
    +(b === 0) - +(a === 0) || (a === 0 ? 0 : a - b)

/**
 * Orders the objects a point hits, at a lane and time, as the hit model says.
 * Selection counts only through raised chains; the tools handle the rest, and a tap cycle keeps
 * its own order.
 */
export const orderHits = <T extends Entity>(
    hits: readonly T[],
    lane: number,
    time: number,
    ups: number,
    source: State,
    composed: ComposedLayout | undefined,
) => {
    const distances = new Map(
        hits.map((entity) => {
            // Lanes down the screen from the object's line; ups runs up it.
            const y = (time - beatToTime(source.bpms, entity.beat)) * ups
            const shape = hitShapeOf(entity, source, composed)
            return [entity, shape ? shapeDistance(shape, lane, y) : Number.POSITIVE_INFINITY]
        }),
    )
    const index = new Map(hits.map((entity, i) => [entity, i]))
    const distance = (entity: T) => distances.get(entity) ?? Number.POSITIVE_INFINITY
    const { selected, chains } = raisedOf(source)
    // A selected object hit is drawn above raised chains.
    const raise = !hits.some((entity) => distance(entity) === 0 && selected.has(entity))
    // Direct hits rank as drawn: time scale markers on top, then joints of raised chains.
    // Callers pass only visible hits, which draw full.
    const rank = (entity: T) =>
        entity.type === 'timeScale' ? 0 : raise && isInRaisedChain(chains, entity) ? 1 : 2
    return [...hits].sort(
        (a, b) =>
            compareShapeDistance(distance(a), distance(b)) ||
            (distance(a) === 0
                ? rank(a) - rank(b) || precedence.indexOf(a.type) - precedence.indexOf(b.type)
                : comparePointHitTypes(a, b)) ||
            a.beat - b.beat ||
            (index.get(b) ?? 0) - (index.get(a) ?? 0),
    )
}
