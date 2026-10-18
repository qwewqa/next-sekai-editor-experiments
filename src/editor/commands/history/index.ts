import type { Command } from '..'
import { i18n } from '../../../i18n'
import { onPanelTab } from '../../workspace'
import HistoryIcon from './HistoryIcon.vue'

/** Opens History (Part 1 §1.4.10.1). Never takes the Undo group's face. */
export const history: Command = {
    title: () => i18n.value.commands.history.title,
    icon: {
        is: HistoryIcon,
    },

    execute() {
        onPanelTab('history')
    },
    readOnly: true,
    keepsFace: true,
}
