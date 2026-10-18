import { ref, shallowRef } from 'vue'
import { openHistory } from '../workspace'
import type { Filter } from './rows'

// The History panel's tab, filter and open groups, kept while the editor is open (Part 1
// §1.4.10), and the ways in that name a tab.

export type HistoryTab = 'timeline' | 'sessions'

export const historyTab = ref<HistoryTab>('timeline')

export const historyFilter = ref<Filter>('all')

/** The ×N groups shown open, by their newest entry's id. */
export const expandedGroups = shallowRef<ReadonlySet<string>>(new Set())

/** Opens History at a tab, as Open History on a notice does. */
export const showHistory = (tab: HistoryTab = 'timeline') => {
    historyTab.value = tab
    openHistory()
}
