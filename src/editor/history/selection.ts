import { shallowRef, watch } from 'vue'
import { leavePeek, peekEntry, peekedKey, type EntryKey } from '../../history/peek'

// What the History list asks the peek to show (Part 1 §1.4.10.5, §1.4.11): the entry's key, and
// what the peek bar says of it. Light, so the canvas's bar loads without the panel.

/** An entry as the peek bar names it. */
export type PeekedInfo = { key: EntryKey; time: number; label: string }

export const entryKey = (entry: { sessionId: string; seq: number }): EntryKey => ({
    sessionId: entry.sessionId,
    seq: entry.seq,
})

export const sameKey = (a: EntryKey | undefined, b: EntryKey | undefined) =>
    !!a && !!b && a.sessionId === b.sessionId && a.seq === b.seq

/** What the bar names, set when the list asks for a peek. */
export const peekedInfo = shallowRef<PeekedInfo>()

/** The entry asked for and not shown yet: arrowing is debounced, and a state may be loading. */
export const peekPending = shallowRef<EntryKey>()

/** Entries whose state could not be read, by `sessionId:seq`: shown as damaged (§1.4.10.5). */
export const damagedEntries = shallowRef<ReadonlySet<string>>(new Set())

const DEBOUNCE_MS = 100

let timer: ReturnType<typeof setTimeout> | undefined

/** Peeks an entry: at once for a click, after a short wait for keys that arrow past many. */
export const requestPeek = (info: PeekedInfo, { immediate = false } = {}) => {
    clearTimeout(timer)
    peekPending.value = info.key
    peekedInfo.value = info
    const run = () => {
        timer = undefined
        peekEntry(info.key)
            .catch(() => {
                damagedEntries.value = new Set(damagedEntries.value).add(
                    `${info.key.sessionId}:${info.key.seq}`,
                )
                if (sameKey(peekPending.value, info.key)) backToNow()
            })
            .finally(() => {
                if (sameKey(peekPending.value, info.key)) peekPending.value = undefined
            })
    }
    if (immediate) run()
    else timer = setTimeout(run, DEBOUNCE_MS)
}

/** Back to Now: leaves the peek, and drops a peek still being asked for. */
export const backToNow = () => {
    clearTimeout(timer)
    timer = undefined
    peekPending.value = undefined
    peekedInfo.value = undefined
    leavePeek()
}

// A peek ended elsewhere (Undo, an edit, New) leaves nothing to name.
watch(peekedKey, (key) => {
    if (!key && !peekPending.value) peekedInfo.value = undefined
})
