import type { PanelId } from '..'
import { showModal } from '../../../modals'
import ManagerModal from './ManagerModal.vue'

export type ManagerTab = Extract<PanelId, 'groups' | 'stages'>

export const showManagerModal = (tab: ManagerTab) => {
    void showModal(ManagerModal, { tab }, { size: 'large' })
}
