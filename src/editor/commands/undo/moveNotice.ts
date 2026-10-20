import { getHistoryOperationContext } from '../../../history/createHistoryOperation'
import { describeStep } from '../../../history/operationPresentation/format'
import type { UndoableStep } from '../../../history/operations'
import type { MoveOutcome } from '../../../history/stack'
import { i18n } from '../../../i18n'
import { interpolate } from '../../../utils/interpolate'
import { notify } from '../../notification'

/**
 * Tells the user what Undo or Redo did, once it has done it. A move onto a slot that is not loaded
 * waits for the slot (§1.6.4 #6), and an edit or a peek can cancel it or the read can fail, so its
 * notice is raised when the chart changes, never on the key press (the notice is then untrue).
 * Presses queued together share one outcome and one notice, which names the last step crossed.
 */
const announced = new WeakSet<Promise<MoveOutcome>>()

export const noticeOnLanding = (outcome: Promise<MoveOutcome>) => {
    if (announced.has(outcome)) return
    announced.add(outcome)
    void outcome.then((result) => {
        // A cancelled move is explained by what cancelled it (an edit, or the peek).
        if (result.kind === 'landed') notifyMove(result.direction, result.step)
        else if (result.kind === 'failed') notifyFailed(result.direction)
    })
}

/** The slot could not be read: nothing changed, and the next press tries again. */
const notifyFailed = (direction: -1 | 1) => {
    notify(() =>
        direction < 0 ? i18n.value.commands.undo.failed : i18n.value.commands.redo.failed,
    )
}

/** The notice for a step crossed by Undo (negative) or Redo. */
export const notifyMove = (direction: -1 | 1, step: UndoableStep) => {
    notify(
        interpolate(
            () => (direction < 0 ? i18n.value.commands.undo.undid : i18n.value.commands.redo.redid),
            () => describeStep(step, getHistoryOperationContext()),
        ),
    )
}
