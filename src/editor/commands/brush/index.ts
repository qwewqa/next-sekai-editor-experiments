import { nextTick } from 'vue'
import type { Command } from '..'
import { i18n } from '../../../i18n'
import { notify } from '../../notification'
import { isSidebarVisible, revealPropertiesSection } from '../../sidebars'
import { showToolModal } from '../../toolModals'
import { switchToolTo } from '../../tools'
import BrushIcon from './BrushIcon.vue'
import BrushPropertiesModal from './BrushPropertiesModal.vue'

export const brush: Command = {
    title: () => i18n.value.commands.brush.title,
    icon: {
        is: BrushIcon,
    },

    async execute() {
        switchToolTo('brush')

        notify(() => i18n.value.commands.brush.switched)

        if (!isSidebarVisible.value) {
            // The tool dialog host closes its dialog when the tool changes, at the next flush.
            await nextTick()
            void showToolModal(BrushPropertiesModal, {})
        } else {
            revealPropertiesSection('tool')
        }
    },
}
