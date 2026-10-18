import { session as currentSession } from '../../history/session'
import type { Flusher, FlushSession } from '../../local/flush'
import type { StorageWorker } from '../../local/worker/client'
import { unbindFile } from '../file'
import { pendingRevocations, readRevocation, removeRevocation } from './env'

// What other tabs' saves change in this one (Part 1 §1.4.7 R6, R11): a binding a save picker
// took over shows as not saved to a file once this tab reads its record again, on the
// `sessionUpdated` broadcast, `pageshow` or becoming visible, with no notice; and revocations kept
// in localStorage while storage couldn't take them are applied when it can.

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/**
 * Reads the open session's chain record again: a binding taken over goes from the label, whether
 * the record says so or a revocation kept in localStorage does (R11). The chain then counts as
 * edited (R6), so closing the tab prompts.
 */
export const refreshBinding = async (
    worker: Pick<StorageWorker, 'call'>,
    flusher: Flusher | undefined,
) => {
    const session = flusher?.session
    if (!session?.stored) return
    const record = await worker.call('readChainRecord', session.chainId).catch(() => undefined)
    if (flusher?.session !== session) return
    const replaced = revokedOf(record, session)
    if (!replaced) return
    // A binding kept in memory (storage paused) was made before the takeover: it goes too.
    session.identity = undefined
    const { file: _gone, ...rest } = record ?? session.chain ?? {}
    session.chain = { ...rest, replaced, edited: true, hasContent: true }
    session.edited = true
    if (currentSession.value.sessionId === session.id && currentSession.value.file) unbindFile()
}

/**
 * The revocation of the session's binding: the record's `replaced` when it's newer than a binding
 * kept in memory, or a localStorage key naming the binding the record holds (R11).
 */
export const revokedOf = (record: Row | undefined, session: FlushSession) => {
    const from = session.identity?.from
    if (record && !isRow(record.file) && isRow(record.replaced)) {
        const at = record.replaced.at
        if (!session.identity || (typeof at === 'number' && at !== from?.replacedAt))
            return record.replaced
    }
    const revoke = readRevocation(session.chainId)
    const fileAt = session.identity
        ? from?.fileAt
        : isRow(record?.file) && typeof record.file.at === 'number'
          ? record.file.at
          : undefined
    if (revoke && fileAt !== undefined && revoke.fileAt === fileAt)
        return { by: revoke.by, at: revoke.at, name: revoke.name }
    return undefined
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
