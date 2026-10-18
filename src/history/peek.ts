import { computed } from 'vue'
import type { State } from '../state'
import { peek } from './stack'

// A minimal stand-in for 5-peek's `peek.ts` (Part 1 §1.4.11), with the names the History panel
// codes against. Take 5-peek's file on merge and drop this one.

export { isPeeking } from './stack'

/** An entry of the open chain: its session and sequence number. */
export type EntryKey = { sessionId: string; seq: number }

export const peekedKey = computed(() => peek.value?.source as EntryKey | undefined)

let refused: ((message: () => string) => void) | undefined

/** Says why a command was refused while peeking. */
export const onPeekRefused = (fn: (message: () => string) => void) => {
    refused = fn
}

/** Reads an entry's state: from memory when it is still waiting to be stored, else from storage. */
const stateOf = async (key: EntryKey): Promise<State> => {
    const { flusher } = await import('../local/storing')
    const pending = flusher?.session?.id === key.sessionId
        ? flusher.session.pending.find((entry) => entry.seq === key.seq)
        : undefined
    if (pending?.state) return pending.state
    const { storageWorker } = await import('../local/start')
    const { decodeSnapshot } = await import('../local/records/snapshot')
    const { stateFromRecords } = await import('../local/records/records')
    if (!storageWorker) throw new Error('Storage is not running')
    const page = await storageWorker.call('readTimeline', {
        sessionId: key.sessionId,
        before: key.seq + 1,
        limit: 1,
    })
    const entry = page.entries[0]
    if (!entry || entry.seq !== key.seq || !entry.kept) throw new Error('No such entry')
    const parts = await storageWorker.call('readSnapshot', entry.snapshot)
    return stateFromRecords(
        decodeSnapshot(parts.root, {
            node: (hex) => parts.nodes[hex],
            chunk: (hex) => parts.chunks[hex],
        }),
    )
}

let requests = 0

/** Shows an entry's state, read-only; a later call replaces it. */
export const peekEntry = async (key: EntryKey) => {
    const request = ++requests
    const state = await stateOf(key)
    if (request === requests) peek.value = { source: key, state }
}

export const leavePeek = () => {
    requests++
    peek.value = undefined
}

/** Restores an entry as an edit, which Undo reverses. */
export const restoreEntry = async (key: EntryKey) => {
    const state = await stateOf(key)
    leavePeek()
    const { pushState } = await import('./stack')
    pushState(() => `Restored to ${new Date().toLocaleTimeString()}`, state)
    void refused
}
