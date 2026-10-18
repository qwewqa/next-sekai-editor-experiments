import type { Command } from '..'
import { earlierSteps, isPristine, undoState } from '../../../history'
import { i18n } from '../../../i18n'
import { previousSession } from '../../../local/startup/events'
import { interpolate } from '../../../utils/interpolate'
import { openHistoryAction } from '../../history/openHistory'
import { notify } from '../../notification'
import { notifyLeft } from '../../switch'
import { view } from '../../view'
import UndoIcon from './UndoIcon.vue'

export const undo: Command = {
    title: () => i18n.value.commands.undo.title,
    icon: {
        is: UndoIcon,
    },

    execute() {
        const name = undoState()
        if (name) {
            view.entities = {
                hovered: [],
                creating: [],
            }

            notify(interpolate(() => i18n.value.commands.undo.undid, name))
        } else {
            // Right after New, an open or an import, with Reopen: the habit of pressing Undo
            // after replacing the chart by mistake gets the work back (Part 1 §1.4.1). Else
            // Open History, at Recent Sessions when the Timeline holds only its first entry.
            if (earlierSteps.value)
                // A reloaded stack is capped (§1.6.4 #6): the steps before it are in the Timeline.
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
