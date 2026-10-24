import type { Command } from '..'
import { i18n } from '../../../i18n'
import { showManagerModal } from '../../workspace/manager/modal'
import ManageStagesIcon from './ManageStagesIcon.vue'

export const manageStages: Command = {
    title: () => i18n.value.commands.manageStages.title,
    icon: {
        is: ManageStagesIcon,
    },

    // Opens while peeking; the lists refuse every edit themselves.
    readOnly: true,

    execute() {
        // The Stages tab explains disabled dynamic stages and offers to enable
        // them, so opening the manager never changes the level.
        showManagerModal('stages')
    },
}
