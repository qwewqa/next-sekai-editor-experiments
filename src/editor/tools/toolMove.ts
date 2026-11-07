import type { EditableObject } from '../../state/operations/editable'
import { constrainLaneObject, getEdgeShifts, limitLaneShift } from '../laneLimits'
import { resizeShift } from './utils'

/** A tool's moved object, held to the lane limits once the pointer's lane or its beat changes, as Select does. */
export const constrainMoved = <T extends EditableObject & { beat: number }>(
    object: T,
    beat: number,
    pressLane: number,
    lane: number,
) => constrainLaneObject(object, { enabled: lane !== pressLane || object.beat !== beat })

/**
 * A tool resize's moving edge target and snapped shift, as Select's: the edge goes no further past
 * the lane limit, and one past it comes back in gradually.
 */
export const limitResize = (edge: number, delta: number, origin = 0) => {
    const shifts = getEdgeShifts([edge])
    const shift = limitLaneShift(resizeShift(edge, edge + delta, origin), shifts)
    return { lane: shifts ? edge + shift : edge + delta, shift }
}
