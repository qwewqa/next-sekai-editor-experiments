import { computed, shallowRef, type InjectionKey } from 'vue'
import { onResetState } from '../../../history/resetHooks'
import type { ManagerTab } from './modal'

export type ManagerDisclosureRequest = {
    tab: ManagerTab
    destination: { kind: 'panel' } | { kind: 'modal'; id: number }
}

export const managerDisclosureOwnerKey: InjectionKey<ManagerDisclosureRequest> = Symbol('manager disclosure owner')

const pending = shallowRef<ManagerDisclosureRequest>()
export const managerDisclosureRequest = computed(() => pending.value)

export const requestManagerDisclosure = (
    tab: ManagerTab,
    destination: ManagerDisclosureRequest['destination'],
) => {
    const request = { tab, destination }
    pending.value = request
    return request
}

export const clearManagerDisclosure = (request = pending.value) => {
    if (pending.value === request) pending.value = undefined
}

onResetState(() => {
    clearManagerDisclosure()
})
