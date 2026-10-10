import type { EditableObject } from '../../state/operations/editable'
import { alignNear } from '../../utils/math'
import { constrainLaneObject } from '../laneLimits'
import { snapYToBeat, view } from '../view'

/** A tool's moved object, held to the lane limits once the pointer's lane or its beat changes, as Select does. */
export const constrainMoved = <T extends EditableObject & { beat: number }>(
    object: T,
    beat: number,
    pressLane: number,
    lane: number,
) => constrainLaneObject(object, { enabled: lane !== pressLane || object.beat !== beat })

/** A tool move's beat, landing exactly on the grid; unmoved, it stays exact. */
export const snapYToMovedBeat = (y: number, beat: number, pressBeat: number) => {
    const moved = snapYToBeat(y, beat, pressBeat)
    return moved === beat ? beat : alignNear(moved, view.division)
}
