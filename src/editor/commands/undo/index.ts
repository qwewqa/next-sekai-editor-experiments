import type { Command } from '..'
import { canUndo, earlierSteps, isPristine, pendingMoveOutcome, undoState } from '../../../history'
import { leavePeek } from '../../../history/peek'
import { i18n } from '../../../i18n'
import { previousSession } from '../../../local/startup/events'
import { openHistoryAction } from '../../history/openHistory'
import { notify } from '../../notification'
import { notifyLeft } from '../../switch'
import { view } from '../../view'
import { noticeOnLanding, notifyMove } from './moveNotice'
import UndoIcon from './UndoIcon.vue'

export const undo: Command = {
    title: () => i18n.value.commands.undo.title,
    icon: {
        is: UndoIcon,
    },

    leavesPeek: true,

    execute() {
        // Leaves a peek only to undo; with nothing to undo it stays.
        if (canUndo.value) leavePeek()
        const step = undoState()
        if (step) {
            view.entities = {
                hovered: [],
                creating: [],
            }

            // A move waiting for its slot is told when it lands.
            const queued = pendingMoveOutcome()
            if (queued) noticeOnLanding(queued)
            else notifyMove(-1, step)
        } else {
            // Right after New, an open or an import, with Reopen: the habit of pressing Undo
            // after replacing the chart by mistake gets the work back. Else
            // Open History, at Recent Sessions when the Timeline holds only its first entry.
            if (earlierSteps.value)
                // The stack is capped: the steps before it are in the Timeline.
                notify(() => i18n.value.notice.earlierInHistory, {
                    action: openHistoryAction(),
                })
            else if (isPristine.value && previousSession.value)
                notifyLeft(() => i18n.value.commands.undo.noState)
            else
                notify(() => i18n.value.commands.undo.noState, {
                    action: openHistoryAction(isPristine.value ? 'sessions' : 'timeline'),
                })
        }
    },
}
