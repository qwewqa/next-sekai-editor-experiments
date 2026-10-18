import { shallowRef } from 'vue'
import { showModal } from '../../modals'
import SettingsModal from './SettingsModal.vue'
import type { SettingsSectionId } from './sections'

/** A section the open Settings dialog is asked to show; `n` makes a repeated request new. */
export const requestedSection = shallowRef<{ id: SettingsSectionId; n: number } | undefined>()

let opening = false
let requests = 0

/**
 * Opens Settings, scrolled to a section with its heading focused (Part 1 §1.4.14): the load
 * notices' [Local Data] uses it. Settings already open only moves to the section.
 */
export const openSettings = async (section?: SettingsSectionId) => {
    if (section) requestedSection.value = { id: section, n: ++requests }
    if (opening) return
    opening = true
    try {
        await showModal(SettingsModal, {}, { size: 'large' })
    } finally {
        opening = false
        requestedSection.value = undefined
    }
}
