import type { State } from '../state'
import type { Entity, EntityType } from '../state/entities'
import { createSlideInfoLookup } from '../state/entities/slides/lookup'
import type { NoteEntity } from '../state/entities/slides/note'
import { getNoteVisualType, type NoteVisualType } from '../state/entities/slides/visualType'
import type { TimeScaleEntity } from '../state/entities/timeScale'
import { beatToTime } from '../state/integrals/bpms'
import { beatToKey } from '../state/store/grid'
import { clamp } from '../utils/math'
import type { ComposedLayout } from './composed'

/*
 * The hit model: the order in which a point takes the objects it hits. It is the
 * ground truth for picking; drawing matches it by convention, and
 * hitModelConsistency.spec flags where they drift apart.
 *
 * Which objects a point hits: each one's hitbox, notes at least the minimum
 * width, within 10 pixels. The model orders them:
 * 1. Those whose primary shape holds the point, by precedence: time-scale
 *    markers, then notes, then transform, style, pivot, mask and camera
 *    markers, then BPM labels; within a kind, an earlier beat, then a later entity in the grid.
 * 2. The rest, nearest primary shape first, so reach between two objects meets
 *    halfway; equally near, by type, then earlier beat, then later entity.
 *
 * Primary shapes, in lanes, across from an object's line (down the screen):
 * - A note's box at its shown width, a zero-width one a 0.2-lane placeholder:
 *   0.3 lanes each way, or 0.15 for anchors, ticks, damage and trace notes. A
 *   sized tick or trace adds its diamond, 0.3 lanes out and up and 0.15 down.
 *   Flick arrows, names and outlines' strokes are decoration.
 * - An event joint's marker: 0.1 lanes each way at each of its lanes.
 * - A time scale's marker, 0.135 lanes each way, for the first of a same-beat
 *   jump on its lane.
 * - A BPM change's label box: its hitbox.
 */

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
export const noteHitShape = (size: number, type: NoteVisualType): Shape => {
    const half = type === 'single' || type === 'head' || type === 'tail' ? 0.3 : 0.15
    const [l, r] = size > 0 ? [0, size] : [-0.1, 0.1]
    return {
        boxes: [{ l, r, t: -half, b: half }],
        diamond: (type === 'tick' || type === 'trace') && size > 0 ? size / 2 : undefined,
    }
}

const markerBox = (x: number, half: number): Box => ({
    l: x - half,
    r: x + half,
    t: -half,
    b: half,
})

// The first of a same-beat jump draws the marker on its lane.
const isTimeScaleMarked = (source: State, entity: TimeScaleEntity) => {
    for (const other of source.store.grid.timeScale.get(beatToKey(entity.beat)) ?? []) {
        if (other.groupId !== entity.groupId || other.beat !== entity.beat) continue
        return other === entity || other.editorLane !== entity.editorLane
    }
    return true
}

const eventHitShape = (source: State, entity: Entity): Shape | undefined => {
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
            return isTimeScaleMarked(source, entity)
                ? { boxes: [markerBox(entity.editorLane, TIME_SCALE_MARKER)] }
                : undefined
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
    if (entity.type !== 'note') return eventHitShape(source, entity)
    const note: NoteEntity = entity
    const position = composed?.notePosition(note) ?? note
    const infos = source.store.slides.info.get(note.slideId)
    const type = getNoteVisualType(
        position.size === note.size
            ? note
            : { ...note, size: position.size, useInfoOf: note.useInfoOf ?? note },
        infos,
        infos && slideInfoLookup(infos),
    )
    const { boxes, diamond } = noteHitShape(position.size, type)
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

/**
 * Orders the objects a point hits, at a lane and time, as the hit model says.
 * Selection is left to the tools, so cycling through the hits stays stable.
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
    return [...hits].sort((a, b) => {
        const onA = distance(a) === 0
        const onB = distance(b) === 0
        return (
            +onB - +onA ||
            (onA
                ? precedence.indexOf(a.type) - precedence.indexOf(b.type)
                : distance(a) - distance(b) || comparePointHitTypes(a, b)) ||
            a.beat - b.beat ||
            (index.get(b) ?? 0) - (index.get(a) ?? 0)
        )
    })
}
