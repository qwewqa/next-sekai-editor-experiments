import type { Command } from '..'
import { isPristine, undoState } from '../../../history'
import { i18n } from '../../../i18n'
import { interpolate } from '../../../utils/interpolate'
import { notify } from '../../notification'
import { notifyLeft } from '../../switch'
import { view } from '../../view'
import UndoIcon from './UndoIcon.vue'

export const undo: Command = {
    title: () => i18n.value.commands.undo.title,
    icon: {
        is: UndoIcon,
    },

    leavesPeek: true,

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
            // after replacing the chart by mistake gets the work back (Part 1 §1.4.1).
            notifyLeft(() => i18n.value.commands.undo.noState, isPristine.value)
        }
    },
}
