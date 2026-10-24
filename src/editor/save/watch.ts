import { session as currentSession } from '../../history/session'
import type { Flusher, FlushSession } from '../../local/flush'
import { storedRead, type ReadWorker } from '../../local/storedRead'
import type { StorageWorker } from '../../local/worker/client'
import { unbindFile } from '../file'

// What other tabs' saves change in this one (Part 1 §1.4.7 R6): a binding a save picker took over
// shows as not saved to a file once this tab reads its record again, on the `sessionUpdated`
// broadcast, `pageshow` or becoming visible, with no notice.

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/**
 * Reads the open session's chain record again: a binding taken over goes from the label. The
 * chain then counts as edited (R6), so closing the tab prompts.
 */
export const refreshBinding = async (worker: ReadWorker, flusher: Flusher | undefined) => {
    const session = flusher?.session
    if (!session?.stored) return
    const read = await storedRead(worker, 'readChainRecord', session.chainId)
    if (flusher?.session !== session) return
    // A failed read is a hint only: the press reads again (R10).
    if (read.storedRead !== 'value' || !read.storedValue) return
    const record = read.storedValue
    const replaced = revokedOf(record, session)
    if (!replaced) return
    // A binding kept in memory (storage paused) was made before the takeover: it goes too.
    session.identity = undefined
    const { file: _gone, ...rest } = record
    session.chain = { ...rest, replaced, edited: true, hasContent: true }
    session.edited = true
    if (currentSession.value.sessionId === session.id && currentSession.value.file) unbindFile()
}

/**
 * The takeover of the session's binding: the record's `replaced`, when it's newer than a binding
 * kept in memory.
 */
export const revokedOf = (record: Row | undefined, session: FlushSession) => {
    if (!record || isRow(record.file) || !isRow(record.replaced)) return undefined
    const at = record.replaced.at
    const from = session.identity?.from
    return !session.identity || (typeof at === 'number' && at !== from?.replacedAt)
        ? record.replaced
        : undefined
}

/** Listens for other tabs' binding changes (§1.6.6: hints only). */
export const watchBindings = (
    worker: Pick<StorageWorker, 'call'>,
    flusher: () => Flusher | undefined,
) => {
    const refresh = () => {
        void refreshBinding(worker, flusher())
    }
    try {
        const channel = new BroadcastChannel('nse-local-data')
        channel.addEventListener('message', (event: MessageEvent) => {
            if (isRow(event.data) && event.data.type === 'sessionUpdated') refresh()
        })
    } catch {
        // No BroadcastChannel: pageshow and visibility still refresh it.
    }
    addEventListener('pageshow', refresh)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh()
    })
}
