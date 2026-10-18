import type { Command } from '..'
import { resetState } from '../../../history'
import { i18n } from '../../../i18n'
import { confirmSwitch, notifyLeft } from '../../switch'
import ResetIcon from './ResetIcon.vue'

export const reset: Command = {
    title: () => i18n.value.commands.reset.title,
    icon: {
        is: ResetIcon,
    },

    readOnly: true,

    async execute() {
        if (!(await confirmSwitch())) return

        resetState(false)

        // "New level", with Reopen while the session left can be reopened (Part 1 §1.4.1).
        notifyLeft(() => i18n.value.notice.newLevel)
    },
}
