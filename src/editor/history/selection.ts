import { shallowRef, watch } from 'vue'
import { recordError } from '../../diagnostics'
import {
    operationStepCount,
    renderOperationRecipe,
    type OperationRecipe,
    type OperationTextContext,
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
    type PeekFailure,
} from '../../history/peek'
import { i18n } from '../../i18n'
import type { State } from '../../state'
import { notify } from '../notification'
import { historyTab, historyViewGeneration } from './state'

// What the History list asks the peek to show: the entry's key, and
// what the peek bar says of it. Light, so the canvas's bar loads without the panel.

/** An entry on the chain: its key, and its snapshot's root once stored. */
export type ChainKey = { key: EntryKey; snapshot?: string }

/**
 * An entry as the peek bar names it, with its root once stored and the entry it is compared with:
 * the one before it on the chain, or before the oldest of its ×N run.
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

/**
 * A session as the peek bar names it (Recent Sessions' peek): the head's last entry,
 * shown without BGM. It has no change view, so it is kept apart from the steps' `PeekedInfo`.
 */
export type PeekedSession = {
    key: EntryKey
    chainId: string
    /** The row's name, as shown. */
    name: string
    time: number
    /** What the bar's button is: Restore Session, or Restore as a Copy. */
    action: 'restore' | 'copy'
    /** The button's action: the session action of the row it was peeked from. */
    restore: () => void
}

/** An entry's key in the peek. */
export const keyOf = (entry: { sessionId: string; seq: number }): EntryKey =>
    entryKey(entry.sessionId, entry.seq)

/** What the bar names, set when the list asks for a peek. */
export const peekedInfo = shallowRef<PeekedInfo>()

/** What the bar names while a session is peeked: the steps' `peekedInfo` is empty then. */
export const peekedSession = shallowRef<PeekedSession>()

export const peekedLabel = (info: PeekedInfo, context: OperationTextContext) => {
    const title = renderOperationRecipe(info.recipe, context)
    return info.recipe.kind === 'group'
        ? `${title} · ${operationStepCount(info.recipe, context)}`
        : title
}

/** Entries whose state could not be read, by key: shown as damaged. */
export const damagedEntries = shallowRef<ReadonlySet<string>>(new Set())

/** Entries whose state a newer version wrote, by key: shown as needing a newer version, never damaged. */
export const newerEntries = shallowRef<ReadonlySet<string>>(new Set())

/** Entries found removed when a peek or Restore reached them, by key: their rows read removed. */
export const removedEntries = shallowRef<ReadonlySet<string>>(new Set())

const withKey = (set: ReadonlySet<string>, key: string) => new Set(set).add(key)

/**
 * A peek or Restore that failed: told, since the user asked. A failure of the entry itself that
 * its row shows (damaged, needs a newer version) is told by the row alone, and an entry not stored
 * yet can be tried again (`quiet`: a peek says nothing of it); a failure of the read or the restore
 * is also kept in the diagnostics.
 */
const reportFailure = (error: unknown, message: () => string, quiet: PeekFailure[] = []) => {
    if (error instanceof PeekError) {
        if (error.reason === 'damaged' || error.reason === 'newer') return
        if (quiet.includes(error.reason)) return
    } else recordError(error)
    notify(message, { card: true, severity: 'error' })
}

/** Marks the row of an entry that a peek or Restore found unreadable. */
const markFailed = (error: unknown, key: string) => {
    if (!(error instanceof PeekError)) return
    if (error.reason === 'damaged') damagedEntries.value = withKey(damagedEntries.value, key)
    else if (error.reason === 'newer') newerEntries.value = withKey(newerEntries.value, key)
    else if (error.reason === 'removed') removedEntries.value = withKey(removedEntries.value, key)
}

type ReadyHook = (info: PeekedInfo, state: State) => Promise<unknown> | undefined
let readyHook: ReadyHook | undefined

/**
 * Registers what a step's peek waits for before it shows (the change view reads the step's
 * change then, so the state and its change land together). A hook, as the change view imports
 * this file.
 */
export const setPeekReady = (hook: ReadyHook | undefined) => {
    readyHook = hook
}

/** Peeks an entry; the peek itself waits a moment when requests come close together. */
export const requestPeek = (info: PeekedInfo) => {
    const generation = peekSourceGeneration.value
    peekedSession.value = undefined
    peekedInfo.value = info
    peekEntry(info.key, { ready: (state) => readyHook?.(info, state) }).catch((error: unknown) => {
        if (generation !== peekSourceGeneration.value) return
        // Peek has ended it. A state that fails its check reads damaged from then on, and one
        // removed since the row was read reads removed; one not stored yet can be tried again.
        markFailed(error, info.key)
        reportFailure(error, () => i18n.value.notice.peekFailed, ['missing'])
        if (peekedInfo.value === info) peekedInfo.value = undefined
    })
}

/**
 * Peeks a session's head: shown without BGM, named by the bar. A session that cannot be read
 * (`onFailed`: damaged, or from a newer version) is marked by the list; the peek ends and says
 * so only for a failure the row does not show.
 */
export const requestSessionPeek = (
    info: PeekedSession,
    onFailed?: (reason: 'damaged' | 'newer') => void,
) => {
    const generation = peekSourceGeneration.value
    peekedInfo.value = undefined
    peekedSession.value = info
    peekEntry(info.key, { audio: 'none' }).catch((error: unknown) => {
        if (generation !== peekSourceGeneration.value) return
        if (error instanceof PeekError && (error.reason === 'damaged' || error.reason === 'newer'))
            onFailed?.(error.reason)
        reportFailure(error, () => i18n.value.notice.peekSessionFailed, ['missing'])
        if (peekedSession.value === info) peekedSession.value = undefined
    })
}

/**
 * Restores an entry. One that cannot be read is marked as a failed peek marks it, and the peek
 * ends, so a Restore that fails is never silent.
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
        markFailed(error, key)
        reportFailure(error, () => i18n.value.notice.restoreFailed)
        if (peekedKey.value === key || peekedInfo.value?.key === key) backToNow()
    })
}

/** Back to Now: leaves the peek. */
export const backToNow = () => {
    peekedInfo.value = undefined
    peekedSession.value = undefined
    leavePeek()
}

// A peek ended elsewhere (Undo, an edit, New) leaves nothing to name.
watch(peekedKey, (key) => {
    if (key) return
    peekedInfo.value = undefined
    peekedSession.value = undefined
})

// A session's peek belongs to its list: every way to the Timeline (its tab, Open History) ends it.
watch(
    historyTab,
    (tab) => {
        if (tab !== 'sessions' && peekedSession.value) backToNow()
    },
    { flush: 'sync' },
)
