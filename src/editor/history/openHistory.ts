import { i18n } from '../../i18n'
import type { NoticeAction } from '../notification'
import { showHistory, type HistoryTab } from './state'

/** The notice button that opens History at a tab (Part 1 §1.4.1, §1.4.3). */
export const openHistoryAction = (tab: HistoryTab = 'timeline'): NoticeAction => ({
    label: () => i18n.value.notice.openHistory,
    run: () => {
        showHistory(tab)
    },
})
