import { i18n } from '../../i18n'
import { closeModal, isSheetOpen, modals } from '../../modals'
import type { NoticeAction } from '../notification'
import { showToolModal } from '../toolModals'
import { isPanelEnabled, showPanel } from '../workspace'
import { backToNow } from './selection'
import { historyTab, listFocus, type HistoryTab } from './state'

// The ways in (Part 1 §1.4.10.1): the History command always runs the dialog; the links in notices,
// Settings and the like select the tab, and run the dialog only when the tab is Disabled.

export const isHistoryDialogOpen = isSheetOpen

let opening = false

/** Shows the History dialog, a sheet over the chart; already shown, it takes focus. */
export const openHistoryDialog = async (tab?: HistoryTab) => {
    if (tab) historyTab.value = tab
    if (isSheetOpen.value || opening) {
        listFocus.value = { surface: 'dialog', at: Date.now() }
        return
    }
    opening = true
    try {
        // Loads when first opened: it brings the storage modules' readers.
        const { default: HistoryDialog } = await import('./HistoryDialog.vue')
        opening = false
        await showToolModal(HistoryDialog, {}, { sheet: true })
    } finally {
        opening = false
    }
    // Closing the dialog ends the peek, whatever else shows the list.
    backToNow()
}

/** The History command: shows the dialog, or closes it when it is shown. */
export const toggleHistoryDialog = () => {
    const sheet = modals.find((modal) => modal.sheet)
    if (sheet) closeModal(sheet)
    else void openHistoryDialog()
}

/**
 * A link to History at a tab: the dialog when it is shown or the tab is Disabled, else the tab,
 * unfolded and with its list focused, as a tap on its name would.
 */
export const showHistoryLink = (tab: HistoryTab = 'timeline') => {
    historyTab.value = tab
    if (isSheetOpen.value || !isPanelEnabled('history')) {
        void openHistoryDialog(tab)
        return
    }
    listFocus.value = { surface: 'panel', at: Date.now() }
    showPanel('history')
}

/** The notice button that opens History at a tab (Part 1 §1.4.1, §1.4.3). */
export const openHistoryAction = (tab: HistoryTab = 'timeline'): NoticeAction => ({
    label: () => i18n.value.notice.openHistory,
    run: () => {
        showHistoryLink(tab)
    },
})
