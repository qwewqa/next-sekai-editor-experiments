import { ref, shallowRef } from 'vue'
import type { Filter } from './rows'

// The History panel's tab, filter and open groups, kept while the editor is open (Part 1
// §1.4.10), shared by the tab and the dialog.

export type HistoryTab = 'timeline' | 'sessions'

export const historyTab = ref<HistoryTab>('timeline')

export const historyFilter = ref<Filter>('all')

/** The ×N groups shown open, by their newest entry's id. */
export const expandedGroups = shallowRef<ReadonlySet<string>>(new Set())

/** A link asking a surface's list to take focus; a list mounted a moment later still honours it. */
export const listFocus = ref<{ surface: 'panel' | 'dialog'; at: number }>()
