import type { Command } from '..'
import { i18n } from '../../../i18n'
import { findEditsHere } from '../../history/editsHere'
import EditsHereIcon from './EditsHereIcon.vue'

/** Filters the Timeline to the entries that changed the beats in view or selected. */
export const editsHere: Command = {
    title: () => i18n.value.commands.editsHere.title,
    icon: {
        is: EditsHereIcon,
    },

    execute() {
        findEditsHere()
    },
    readOnly: true,
}
