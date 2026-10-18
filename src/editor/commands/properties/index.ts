import type { Command } from '..'
import { isPeeking, pushState, state } from '../../../history'
import { initialLife } from '../../../history/initialLife'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import { initialLifeLabel } from '../../headerLabels'
import { notify } from '../../notification'
import PropertiesIcon from './PropertiesIcon.vue'
import PropertiesModal from './PropertiesModal.vue'

export const properties: Command = {
    title: () => i18n.value.commands.properties.title,
    icon: {
        is: PropertiesIcon,
    },

    // Level Info opens read-only while peeking (§1.4.11).
    readOnly: true,

    async execute() {
        const newInitialLife = await showModal(PropertiesModal, {
            initialLife: initialLife.value,
            readOnly: isPeeking.value,
        })
        // Confirming it unchanged is no edit, and nothing is changed while peeking.
        if (!newInitialLife || newInitialLife === initialLife.value || isPeeking.value) return

        const label = initialLifeLabel(newInitialLife)
        pushState(label, {
            ...state.value,
            initialLife: newInitialLife,
        })

        notify(label)
    },
}
