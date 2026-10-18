import type { Command } from '..'
import { isPristine, redoState } from '../../../history'
import { i18n } from '../../../i18n'
import { interpolate } from '../../../utils/interpolate'
import { openHistoryAction } from '../../history/openHistory'
import { notify } from '../../notification'
import { view } from '../../view'
import RedoIcon from './RedoIcon.vue'

export const redo: Command = {
    title: () => i18n.value.commands.redo.title,
    icon: {
        is: RedoIcon,
    },

    execute() {
        const name = redoState()
        if (name) {
            view.entities = {
                hovered: [],
                creating: [],
            }

            notify(interpolate(() => i18n.value.commands.redo.redid, name))
        } else {
            notify(() => i18n.value.commands.redo.noState, {
                action: openHistoryAction(isPristine.value ? 'sessions' : 'timeline'),
            })
        }
    },
}
