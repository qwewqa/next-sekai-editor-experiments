import type { NoteType } from '../chart/note'
import { settings } from '../settings'
import type { Entity, EntityType } from '../state/entities'
import type { NoteEntity } from '../state/entities/slides/note'
import type { EditableObject } from '../state/operations/editable'
import {
    constrainLaneObject as constrain,
    edgeShiftRange,
    laneShiftRange,
} from '../state/operations/laneLimits'
import { clamp } from '../utils/math'
import { view } from './view'

export const minimumNoteSize = (noteType: NoteType | undefined) =>
    settings.zeroWidthNotes === 'all' ||
    (settings.zeroWidthNotes === 'anchors' && noteType === 'anchor')
        ? 0
        : 1 / view.laneDivision

export const constrainLaneObject = <T extends EditableObject>(
    object: T,
    { enabled = true, resizing = false }: { enabled?: boolean; resizing?: boolean } = {},
): T =>
    enabled
        ? constrain(
              object,
              settings.maxLane,
              resizing,
              minimumNoteSize('noteType' in object ? object.noteType : undefined),
          )
        : object

export type LaneShifts = readonly [min: number, max: number]

/**
 * The lane shifts the lane limit allows objects that move as one group, from their spans before
 * the shift; undefined without a limit.
 */
export const getLaneShifts = (spans: Iterable<readonly [number, number]>): LaneShifts | undefined =>
    laneShiftRange(spans, settings.maxLane)

/**
 * The shifts the lane limit allows the moving edges of a resize of several objects: none goes
 * further past the limit than it is.
 */
export const getEdgeShifts = (edges: Iterable<number>): LaneShifts | undefined =>
    edgeShiftRange(edges, settings.maxLane)

/** A group's lane shift, held to the lane limit. */
export const limitLaneShift = (shift: number, shifts: LaneShifts | undefined) =>
    shifts ? clamp(shift, shifts[0], shifts[1]) : shift

/**
 * Whether moving a selection shifts an object's lane: an attached tick within its slide follows
 * the slide, and editor lanes move only in a selection of their own type.
 */
export const movesLane = (
    onlyType: EntityType | undefined,
    entity: Entity,
    isSlideEnd: (note: NoteEntity) => boolean,
) => {
    switch (entity.type) {
        case 'note':
            return !entity.isAttached || isSlideEnd(entity)
        case 'timeScale':
        case 'stageStyleEventJoint':
            return onlyType === entity.type
        case 'cameraEventJoint':
        case 'stageMaskEventJoint':
        case 'stagePivotEventJoint':
        case 'stageTransformEventJoint':
            return true
        case 'bpm':
        case 'connector':
        case 'cameraEventConnection':
        case 'stageMaskEventConnection':
        case 'stagePivotEventConnection':
        case 'stageStyleEventConnection':
        case 'stageTransformEventConnection':
            return false
    }
}
