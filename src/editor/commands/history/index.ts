import type { Command } from '..'
import { i18n } from '../../../i18n'
import { toggleHistory } from '../../workspace'
import HistoryIcon from './HistoryIcon.vue'

/** Opens or closes the History panel (Part 1 §1.4.10.1). Never takes the Undo group's face. */
export const history: Command = {
    title: () => i18n.value.commands.history.title,
    icon: {
        is: HistoryIcon,
    },

    execute() {
        toggleHistory()
    },
    readOnly: true,
    keepsFace: true,
}
