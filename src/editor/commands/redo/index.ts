import type { Command } from '..'
import { canRedo, isPristine, pendingMoveOutcome, redoState } from '../../../history'
import { leavePeek } from '../../../history/peek'
import { i18n } from '../../../i18n'
import { openHistoryAction } from '../../history/openHistory'
import { notify } from '../../notification'
import { view } from '../../view'
import { noticeOnLanding, notifyMove } from '../undo/moveNotice'
import RedoIcon from './RedoIcon.vue'

export const redo: Command = {
    title: () => i18n.value.commands.redo.title,
    icon: {
        is: RedoIcon,
    },

    leavesPeek: true,

    execute() {
        // Leaves a peek only to redo; with nothing to redo it stays.
        if (canRedo.value) leavePeek()
        const step = redoState()
        if (step) {
            view.entities = {
                hovered: [],
                creating: [],
            }

            // A move waiting for its slot is told when it lands (§1.6.4 #6).
            const queued = pendingMoveOutcome()
            if (queued) noticeOnLanding(queued)
            else notifyMove(1, step)
        } else {
            notify(() => i18n.value.commands.redo.noState, {
                action: openHistoryAction(isPristine.value ? 'sessions' : 'timeline'),
            })
        }
    },
}
