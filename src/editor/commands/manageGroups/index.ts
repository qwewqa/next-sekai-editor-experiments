import type { Command } from '..'
import { i18n } from '../../../i18n'
import { showManagerModal } from '../../workspace/manager/modal'
import ManageGroupsIcon from './ManageGroupsIcon.vue'

export const manageGroups: Command = {
    title: () => i18n.value.commands.manageGroups.title,
    icon: {
        is: ManageGroupsIcon,
    },

    execute() {
        showManagerModal('groups')
    },
}
