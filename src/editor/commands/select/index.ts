import type { Command } from '..'
import { i18n } from '../../../i18n'
import { notify } from '../../notification'
import { switchToolTo, toolName } from '../../tools'
import SelectIcon from './SelectIcon.vue'

export const select: Command = {
    title: () => i18n.value.commands.select.title,
    icon: {
        is: SelectIcon,
    },

    execute() {
        // The Elevation tool already selects, and keeps the Elevation Editor's tool to return from.
        if (toolName.value !== 'elevation') switchToolTo('select')

        notify(() => i18n.value.commands.select.switched)
    },
}
