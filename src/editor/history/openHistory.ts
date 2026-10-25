import { computed, nextTick, shallowRef } from 'vue'
import { bump } from '../../analytics/tally'
import { recordError } from '../../diagnostics'
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
import { notify, type NoticeAction } from '../notification'
import { prepareToolModal, showToolModal } from '../toolModals'
import { isPanelEnabled, showPanel } from '../workspace'
import { checkHistoryCalendar } from './calendarClock'
import { createHistoryPresentation, type HistoryCloseResult } from './presentation'
import { historyFilter, historyTab, listFocus, type HistoryTab } from './state'

// The ways in: the History command always runs the dialog; the links in notices,
// Settings and the like select the tab, and run the dialog only when the tab is Disabled.

const historyId = shallowRef<number>()
const historyModal = computed(() => modals.find(({ id }) => id === historyId.value))
export const isHistoryDialogOpen = computed(() => !!historyModal.value)
export const canFocusHistory = (surface: 'panel' | 'dialog') =>
    surface === 'dialog'
        ? historyId.value !== undefined && modals.at(-1)?.id === historyId.value
        : modals.length === 0
// A dialog gives focus back to its opener. An opener that is gone or hidden gets none (and the sheet's
// host has already given its own), so the chart takes it.
const focusChartIfLost = () => {
    const active = document.activeElement
    if (!active || active === document.body)
        document.querySelector<HTMLElement>('.chart-pane')?.focus({ preventScroll: true })
}
const canFocusChart = () =>
    isPeeking.value && !isBlockingModalOpen.value && !isHistoryDialogOpen.value

let opening = false
let generation = 0
onResetState(() => generation++)

/** Opens or focuses History; View Chart alone closes it while retaining the peek. */
export const openHistoryDialog = async (tab?: HistoryTab) => {
    if (tab) historyTab.value = tab
    if (isHistoryDialogOpen.value || opening) {
        checkHistoryCalendar()
        listFocus.value = { surface: 'dialog', at: performance.now() }
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
    bump('features.historyDialog')
    let result: HistoryCloseResult | undefined
    let presentation: ReturnType<typeof createHistoryPresentation> | undefined
    try {
        // Loads when first opened: it brings the storage modules' readers.
        let HistoryDialog: Awaited<typeof import('./HistoryDialog.vue')>['default']
        try {
            HistoryDialog = (await import('./HistoryDialog.vue')).default
        } catch (error) {
            // The chunk did not load (offline after a deploy): the editor stays as it was, and the
            // user, who asked, is told.
            recordError(error)
            if (at !== generation) return
            notify(() => i18n.value.history.loadFailed)
            if (reopenAt !== undefined) openElevationEditor(reopenAt)
            return
        }
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
    // Closing History never ends a peek: Back to Now does, so the groups and stages can be
    // visited while an old step is shown.
    if (isPeeking.value) {
        if (reopenAt !== undefined) {
            const { restoreElevationAfterPeek } = await import('../peek')
            if (at !== generation) return
            restoreElevationAfterPeek(reopenAt)
        }
        await nextTick()
        if (at === generation && canFocusChart()) {
            if (result === 'view-chart')
                document
                    .querySelector<HTMLElement>('[data-peek-back]')
                    ?.focus({ preventScroll: true })
            else focusChartIfLost()
        }
    } else if (reopenAt !== undefined) openElevationEditor(reopenAt)
    else {
        await nextTick()
        if (at === generation) focusChartIfLost()
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
    checkHistoryCalendar()
    listFocus.value = { surface: 'panel', at: performance.now() }
    showPanel('history')
}

/** The notice button that opens History at a tab. */
export const openHistoryAction = (tab: HistoryTab = 'timeline'): NoticeAction => ({
    label: () => i18n.value.notice.openHistory,
    run: () => {
        showHistoryLink(tab)
    },
})
