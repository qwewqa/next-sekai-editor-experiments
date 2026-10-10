import type { EditableObject } from '../../state/operations/editable'
import { constrainLaneObject } from '../laneLimits'
import { snapYToBeat } from '../view'

/** A tool's moved object, held to the lane limits once the pointer's lane or its beat changes, as Select does. */
export const constrainMoved = <T extends EditableObject & { beat: number }>(
    object: T,
    beat: number,
    pressLane: number,
    lane: number,
) => constrainLaneObject(object, { enabled: lane !== pressLane || object.beat !== beat })

/** A tool's resized object, held to the lane limits once the pointer's lane or beat moves, as Select does. */
export const constrainResized = <T extends EditableObject>(
    object: T,
    beat: number,
    pressBeat: number,
    pressLane: number,
    lane: number,
    y: number,
) =>
    constrainLaneObject(object, {
        enabled: lane !== pressLane || snapYToBeat(y, beat, pressBeat) !== beat,
        resizing: true,
    })
