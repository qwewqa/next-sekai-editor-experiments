import { shallowRef, watch } from 'vue'
import {
    PeekError,
    entryKey,
    leavePeek,
    peekEntry,
    peekedKey,
    restoreEntry,
    type EntryKey,
} from '../../history/peek'

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
    label: string
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

/** Entries whose state could not be read, by key: shown as damaged (§1.4.10.5). */
export const damagedEntries = shallowRef<ReadonlySet<string>>(new Set())

/** Peeks an entry; the peek itself waits a moment when requests come close together. */
export const requestPeek = (info: PeekedInfo) => {
    peekedInfo.value = info
    peekEntry(info.key).catch((error: unknown) => {
        // Peek has ended it. A state that fails its check reads damaged from then on; a removed
        // one already reads so from its row, and one not stored yet can be tried again.
        if (error instanceof PeekError && error.reason === 'damaged')
            damagedEntries.value = new Set(damagedEntries.value).add(info.key)
        if (peekedInfo.value === info) peekedInfo.value = undefined
    })
}

/**
 * Restores an entry. One that cannot be read is marked damaged, as a failed peek marks it, and the
 * peek ends, so a Restore that fails is never silent.
 */
export const requestRestore = async (key: EntryKey) => {
    try {
        await restoreEntry(key)
    } catch (error) {
        if (error instanceof PeekError && error.reason !== 'removed')
            damagedEntries.value = new Set(damagedEntries.value).add(key)
        if (peekedKey.value === key || peekedInfo.value?.key === key) backToNow()
    }
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
