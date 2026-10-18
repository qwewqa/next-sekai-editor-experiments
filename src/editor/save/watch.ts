import { session as currentSession } from '../../history/session'
import type { Flusher } from '../../local/flush'
import type { StorageWorker } from '../../local/worker/client'
import { pendingRevocations, removeRevocation, showBinding } from './env'

// What other tabs' saves change in this one (Part 1 §1.4.7 R6, R11): a binding a save picker
// took over shows as not saved to a file once this tab reads its record again, on the
// `sessionUpdated` broadcast, `pageshow` or becoming visible, with no notice; and revocations kept
// in localStorage while storage couldn't take them are applied when it can.

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** Reads the open session's chain record again: a binding taken over goes from the label. */
export const refreshBinding = async (
    worker: Pick<StorageWorker, 'call'>,
    flusher: Flusher | undefined,
) => {
    const session = flusher?.session
    // A binding kept in memory (storage paused) is this tab's newer one.
    if (!session?.stored || session.identity) return
    const record = await worker.call('readChainRecord', session.chainId).catch(() => undefined)
    if (!record || flusher?.session !== session) return
    if (isRow(record.file) || !isRow(record.replaced)) return
    const { file: _gone, ...rest } = session.chain ?? {}
    session.chain = { ...rest, replaced: record.replaced, edited: true, hasContent: true }
    if (currentSession.value.sessionId === session.id && currentSession.value.file)
        showBinding(undefined)
}

/** Applies every revocation kept in localStorage (R11); each key goes once its write commits. */
export const applyRevocations = async (worker: Pick<StorageWorker, 'call'>) => {
    for (const { chainId, revoke } of pendingRevocations()) {
        try {
            await worker.call('applyRevocation', { chainId, revoke })
            removeRevocation(chainId)
        } catch {
            // Storage still can't take it: the next resume or start tries again.
        }
    }
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
