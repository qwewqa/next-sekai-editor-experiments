import { ref, shallowRef, watch } from 'vue'
import { onResetState } from '../../history/resetHooks'
import { session } from '../../history/session'
import type { Filter } from './rows'

// The History panel's tab, filter and open groups, kept while the editor is open (Part 1
// §1.4.10), shared by the tab and the dialog.

export type HistoryTab = 'timeline' | 'sessions'

export const historyTab = ref<HistoryTab>('timeline')

export const historyFilter = ref<Filter>('all')

/** Edits Here's beats, taken once as the filter is turned on (Part 1 §1.4.10.5). */
export const hereRange = shallowRef<{ from: number; to: number }>()

/** The ×N groups shown open, by their newest entry's id. */
export const expandedGroups = shallowRef<ReadonlySet<string>>(new Set())

/** A link asking a surface's list to take focus; a list mounted a moment later still honours it. */
export const listFocus = ref<{ surface: 'panel' | 'dialog'; at: number }>()

export type HistoryViewMemory = {
    sessionId: string
    cursorId: string
    anchorId: string
    offset: number
    window: { first?: string; last?: string; gap: boolean }
}

let dialogView: HistoryViewMemory | undefined

/** One dialog view for the current session, without keeping rows or historical states. */
export const rememberHistoryView = (view: HistoryViewMemory) => {
    if (view.sessionId === session.value.sessionId) dialogView = view
}

export const rememberedHistoryView = () =>
    dialogView?.sessionId === session.value.sessionId ? dialogView : undefined

export const clearHistoryView = () => {
    dialogView = undefined
}

watch(() => session.value.sessionId, clearHistoryView, { flush: 'sync' })
onResetState(clearHistoryView)
