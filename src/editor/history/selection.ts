import { shallowRef, watch } from 'vue'
import { recordError } from '../../diagnostics'
import { getHistoryOperationContext } from '../../history/createHistoryOperation'
import {
    operationStepCount,
    renderOperationRecipe,
    type OperationRecipe,
} from '../../history/operationPresentation'
import {
    PeekError,
    entryKey,
    leavePeek,
    peekEntry,
    peekSourceGeneration,
    peekedKey,
    restoreEntry,
    type EntryKey,
} from '../../history/peek'
import { i18n } from '../../i18n'
import { notify } from '../notification'
import { historyViewGeneration } from './state'

// What the History list asks the peek to show (Part 1 §1.4.10.5, §1.4.11): the entry's key, and
// what the peek bar says of it. Light, so the canvas's bar loads without the panel.

/** An entry on the chain: its key, and its snapshot's root once stored. */
export type ChainKey = { key: EntryKey; snapshot?: string }

/**
 * An entry as the peek bar names it, with its root once stored and the entry it is compared with
 * (§1.4.11): the one before it on the chain, or before the oldest of its ×N run.
 */
export type PeekedInfo = {
    key: EntryKey
    time: number
    recipe: OperationRecipe
    snapshot?: string
    previous?: ChainKey
    oldest?: EntryKey
    initial?: boolean
    rowId?: string
    members?: readonly EntryKey[]
    pinned?: readonly EntryKey[]
}

/** An entry's key in the peek. */
export const keyOf = (entry: { sessionId: string; seq: number }): EntryKey =>
    entryKey(entry.sessionId, entry.seq)

/** What the bar names, set when the list asks for a peek. */
export const peekedInfo = shallowRef<PeekedInfo>()

export const peekedLabel = (info: PeekedInfo) => {
    const context = getHistoryOperationContext()
    const title = renderOperationRecipe(info.recipe, context)
    return info.recipe.kind === 'group'
        ? `${title} · ${operationStepCount(info.recipe, context)}`
        : title
}

/** Entries whose state could not be read, by key: shown as damaged (§1.4.10.5). */
export const damagedEntries = shallowRef<ReadonlySet<string>>(new Set())

/** Entries whose state a newer version wrote, by key: shown as needing a newer version, never damaged. */
export const newerEntries = shallowRef<ReadonlySet<string>>(new Set())

/**
 * A peek or Restore that failed for a reason other than the entry itself (a storage read that
 * failed, an exception in the restore): kept in the diagnostics, and told, since the user asked.
 */
const reportFailure = (error: unknown, notice: 'restoreFailed' | 'peekFailed') => {
    if (error instanceof PeekError) return
    recordError(error)
    notify(() => i18n.value.notice[notice])
}

/** Peeks an entry; the peek itself waits a moment when requests come close together. */
export const requestPeek = (info: PeekedInfo) => {
    const generation = peekSourceGeneration.value
    peekedInfo.value = info
    peekEntry(info.key).catch((error: unknown) => {
        if (generation !== peekSourceGeneration.value) return
        // Peek has ended it. A state that fails its check reads damaged from then on; a removed
        // one already reads so from its row, and one not stored yet can be tried again.
        if (error instanceof PeekError && error.reason === 'damaged')
            damagedEntries.value = new Set(damagedEntries.value).add(info.key)
        if (error instanceof PeekError && error.reason === 'newer')
            newerEntries.value = new Set(newerEntries.value).add(info.key)
        reportFailure(error, 'peekFailed')
        if (peekedInfo.value === info) peekedInfo.value = undefined
    })
}

/**
 * Restores an entry. One that cannot be read is marked damaged, as a failed peek marks it, and the
 * peek ends, so a Restore that fails is never silent.
 */
export const requestRestore = async (key: EntryKey) => {
    const generation = peekSourceGeneration.value
    const historyGeneration = historyViewGeneration()
    await restoreEntry(key, (error) => {
        if (
            generation !== peekSourceGeneration.value ||
            historyGeneration !== historyViewGeneration()
        )
            return
        if (error instanceof PeekError && error.reason === 'newer')
            newerEntries.value = new Set(newerEntries.value).add(key)
        else if (error instanceof PeekError && error.reason !== 'removed')
            damagedEntries.value = new Set(damagedEntries.value).add(key)
        reportFailure(error, 'restoreFailed')
        if (peekedKey.value === key || peekedInfo.value?.key === key) backToNow()
    })
}

/** Back to Now: leaves the peek. */
export const backToNow = () => {
    peekedInfo.value = undefined
    leavePeek()
}

// A peek ended elsewhere (Undo, an edit, New) leaves nothing to name.
watch(peekedKey, (key) => {
    if (!key) peekedInfo.value = undefined
})
