import { watchEffect } from 'vue'
import { isPanelEnabled, isPanelVisible, showPanel, type PanelId } from '..'
import { modals, showModal } from '../../../modals'
import ManagerModal from './ManagerModal.vue'
import {
    clearManagerDisclosure,
    managerDisclosureRequest,
    requestManagerDisclosure,
    type ManagerDisclosureRequest,
} from './disclosure'

export type ManagerTab = Extract<PanelId, 'groups' | 'stages'>

type ManagerOptions = { revealCurrent?: boolean }

export const showManagerModal = (tab: ManagerTab, options: ManagerOptions = {}) => {
    const props: { tab: ManagerTab; disclosureRequest?: ManagerDisclosureRequest } = { tab }
    const result = showModal(ManagerModal, props, { size: 'large' })
    if (options.revealCurrent) {
        const modal = modals.at(-1)
        if (!modal) return
        const request = requestManagerDisclosure(tab, { kind: 'modal', id: modal.id })
        props.disclosureRequest = request
        void result.finally(() => {
            clearManagerDisclosure(request)
        })
    } else clearManagerDisclosure()
}

/** The manager's panel, or its dialog while the panel is disabled. */
export const showManager = (tab: ManagerTab, options: ManagerOptions = {}) => {
    if (isPanelEnabled(tab)) {
        if (options.revealCurrent) requestManagerDisclosure(tab, { kind: 'panel' })
        else clearManagerDisclosure()
        showPanel(tab)
    } else showManagerModal(tab, options)
}

watchEffect(
    () => {
        const request = managerDisclosureRequest.value
        if (!request) return
        const top = modals.filter((modal) => modal.presentation !== 'tool').at(-1)
        const visible =
            request.destination.kind === 'panel'
                ? !top && isPanelVisible(request.tab)
                : top?.id === request.destination.id
        if (!visible) clearManagerDisclosure(request)
    },
    { flush: 'post' },
)
