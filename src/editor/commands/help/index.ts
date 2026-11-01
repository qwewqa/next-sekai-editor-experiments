import type { Command } from '..'
import { i18n } from '../../../i18n'
import { helpTarget } from '../../help/currentTarget'
import { openHelp } from '../../help/openHelp'
import HelpIcon from './HelpIcon.vue'

export const help: Command = {
    title: () => i18n.value.commands.help.title,
    icon: {
        is: HelpIcon,
    },

    readOnly: true,

    execute() {
        void openHelp(helpTarget())
    },
}
