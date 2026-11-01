import { shallowRef } from 'vue'
import { showModal } from '../../modals'
import type { HelpEntryId } from './content'
import HelpModal from './HelpModal.vue'

/** An entry the open Help dialog is asked to show; `n` makes a repeated request new. */
export const requestedEntry = shallowRef<{ id: HelpEntryId; n: number } | undefined>()

let opening = false
let requests = 0

/**
 * Opens Help scrolled to an entry, with its heading focused.
 */
export const openHelp = async (entry: HelpEntryId) => {
    requestedEntry.value = { id: entry, n: ++requests }
    if (opening) return
    opening = true
    try {
        await showModal(HelpModal, {}, { size: 'large', tall: true })
    } finally {
        opening = false
        requestedEntry.value = undefined
    }
}
