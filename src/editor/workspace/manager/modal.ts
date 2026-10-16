import { isPanelEnabled, showPanel, type PanelId } from '..'
import { showModal } from '../../../modals'
import ManagerModal from './ManagerModal.vue'

export type ManagerTab = Extract<PanelId, 'groups' | 'stages'>

export const showManagerModal = (tab: ManagerTab) => {
    void showModal(ManagerModal, { tab }, { size: 'large' })
}

/** The manager's panel, or its dialog while the panel is disabled. */
export const showManager = (tab: ManagerTab) => {
    if (isPanelEnabled(tab)) showPanel(tab)
    else showManagerModal(tab)
}
