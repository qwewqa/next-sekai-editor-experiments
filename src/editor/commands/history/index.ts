import type { Command } from '..'
import { i18n } from '../../../i18n'
import { toggleHistoryDialog } from '../../history/openHistory'
import HistoryIcon from './HistoryIcon.vue'

/** Opens or closes the History dialog. Never takes the Undo group's face. */
export const history: Command = {
    title: () => i18n.value.commands.history.title,
    icon: {
        is: HistoryIcon,
    },

    execute() {
        toggleHistoryDialog()
    },
    readOnly: true,
    keepsFace: true,
}
