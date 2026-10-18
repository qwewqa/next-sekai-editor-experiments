import { computed, nextTick, shallowRef } from 'vue'
import { onResetState } from '../../history/resetHooks'
import { isPeeking } from '../../history/stack'
import { i18n } from '../../i18n'
import { closeModal, isBlockingModalOpen, modals, showModal } from '../../modals'
import {
    closeElevationEditor,
    elevationBeat,
    isElevationEditorOpen,
    isElevationSideBySide,
    openElevationEditor,
} from '../elevation/state'
import type { NoticeAction } from '../notification'
import { prepareToolModal, showToolModal } from '../toolModals'
import { isPanelEnabled, showPanel } from '../workspace'
import { createHistoryPresentation, type HistoryCloseResult } from './presentation'
import { backToNow } from './selection'
import { historyFilter, historyTab, listFocus, type HistoryTab } from './state'

// The ways in (Part 1 §1.4.10.1): the History command always runs the dialog; the links in notices,
// Settings and the like select the tab, and run the dialog only when the tab is Disabled.

const historyId = shallowRef<number>()
const historyModal = computed(() => modals.find(({ id }) => id === historyId.value))
export const isHistoryDialogOpen = computed(() => !!historyModal.value)
const canFocusChart = () =>
    isPeeking.value && !isBlockingModalOpen.value && !isHistoryDialogOpen.value

let opening = false
let generation = 0
onResetState(() => generation++)

/** Opens or focuses History; View Chart alone closes it while retaining the peek. */
export const openHistoryDialog = async (tab?: HistoryTab) => {
    if (tab) historyTab.value = tab
    if (isHistoryDialogOpen.value || opening) {
        listFocus.value = { surface: 'dialog', at: Date.now() }
        return
    }
    // The Elevation Editor alone fills the editor: it steps aside for the sheet, and returns after.
    const reopenAt =
        isElevationEditorOpen.value && !isElevationSideBySide.value
            ? elevationBeat.value
            : undefined
    if (reopenAt !== undefined) closeElevationEditor()
    const at = generation
    opening = true
    let result: HistoryCloseResult | undefined
    let presentation: ReturnType<typeof createHistoryPresentation> | undefined
    try {
        // Loads when first opened: it brings the storage modules' readers.
        const { default: HistoryDialog } = await import('./HistoryDialog.vue')
        if (at !== generation) return
        presentation = createHistoryPresentation(
            () => historyTab.value === 'timeline' && historyFilter.value !== 'all',
            () => {
                const modal = historyModal.value
                if (modal?.presentation !== 'tool') return
                const index = modals.indexOf(modal)
                modals.splice(index, 1, {
                    ...modal,
                    presentation: undefined,
                    pane: undefined,
                    sheet: undefined,
                    size: 'large',
                    tall: true,
                })
            },
        )
        const props = { presentation: presentation.state }
        if (presentation.state.compact) prepareToolModal()
        const pending = presentation.state.compact
            ? showModal(HistoryDialog, props, { size: 'large', tall: true })
            : showToolModal(HistoryDialog, props, { sheet: true })
        historyId.value = modals.at(-1)?.id
        result = await pending
    } finally {
        presentation?.stop()
        historyId.value = undefined
        opening = false
    }
    if (at !== generation) return
    if (result === 'view-chart' && isPeeking.value) {
        if (reopenAt !== undefined) {
            const { restoreElevationAfterPeek } = await import('../peek')
            if (at !== generation) return
            restoreElevationAfterPeek(reopenAt)
        }
        await nextTick()
        if (at === generation && canFocusChart())
            document
                .querySelector<HTMLElement>('[data-peek-main] button')
                ?.focus({ preventScroll: true })
    } else {
        backToNow()
        if (reopenAt !== undefined) openElevationEditor(reopenAt)
    }
}

/** The History command: shows the dialog, or closes it when it is shown. */
export const toggleHistoryDialog = () => {
    const modal = historyModal.value
    if (modal) closeModal(modal)
    else void openHistoryDialog()
}

/**
 * A link to History at a tab: the dialog when it is shown or the tab is Disabled, else the tab,
 * unfolded and with its list focused, as a tap on its name would.
 */
export const showHistoryLink = (tab: HistoryTab = 'timeline') => {
    historyTab.value = tab
    if (isHistoryDialogOpen.value || !isPanelEnabled('history')) {
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
