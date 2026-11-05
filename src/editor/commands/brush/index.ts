import type { Command } from '..'
import { i18n } from '../../../i18n'
import { notify } from '../../notification'
import { isSidebarVisible, revealPropertiesSection } from '../../sidebars'
import { showToolModal } from '../../toolModals'
import { switchToolTo, toolName } from '../../tools'
import BrushIcon from './BrushIcon.vue'
import BrushPropertiesModal from './BrushPropertiesModal.vue'

export const brush: Command = {
    title: () => i18n.value.commands.brush.title,
    icon: {
        is: BrushIcon,
    },

    execute() {
        const active = toolName.value === 'brush'
        switchToolTo('brush')

        notify(() => i18n.value.commands.brush.switched)

        if (isSidebarVisible.value) revealPropertiesSection('tool')
        // From another tool it only switches, as Note, Slide and Event do.
        else if (active) void showToolModal(BrushPropertiesModal, {})
    },
}
