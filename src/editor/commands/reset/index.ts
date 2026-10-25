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

    leavesPeek: true,

    async execute() {
        // Asks first when the chart has edits no file holds.
        if (!(await confirmSwitch({ unsaved: true }))) return

        resetState(false)

        // "New level", with Reopen while the session left can be reopened.
        notifyLeft(() => i18n.value.notice.newLevel)
    },
}
