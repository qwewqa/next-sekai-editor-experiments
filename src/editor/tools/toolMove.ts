import type { EditableObject } from '../../state/operations/editable'
import { constrainLaneObject } from '../laneLimits'

/** A tool's moved object, held to the lane limits once the pointer's lane or its beat changes, as Select does. */
export const constrainMoved = <T extends EditableObject & { beat: number }>(
    object: T,
    beat: number,
    pressLane: number,
    lane: number,
) => constrainLaneObject(object, { enabled: lane !== pressLane || object.beat !== beat })
