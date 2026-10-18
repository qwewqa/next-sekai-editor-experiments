import type { Command } from '..'
import { i18n } from '../../../i18n'
import { showNextChange } from '../../history/changes'
import ShowChangeIcon from './ShowChangeIcon.vue'

/**
 * Brings the next of the peeked entry's changes into view, in chart order, wrapping (Part 1
 * §1.4.11). No default key; while not peeking a change with places it does nothing.
 */
export const showChange: Command = {
    title: () => i18n.value.commands.showChange.title,
    icon: {
        is: ShowChangeIcon,
    },

    execute() {
        showNextChange()
    },
    readOnly: true,
}
