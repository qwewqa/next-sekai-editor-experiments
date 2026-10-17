import { readMeta, writeMeta } from '../db'
import { MaintTimeoutError } from '../locks'
import { directWaiter, type Waiter } from '../scheduler'
import { StoragePausedError, StorageRefusedError, type Progress } from '../worker/core'
import type { WorkerContext } from '../worker/handlers'
import type { CallScope } from '../worker/rpc'
import {
    JOURNAL_STORES,
    prepareJournal,
    writeJournalApply,
    type JournalApplyBatch,
    type JournalApplyResult,
} from './apply'

// The storage worker's journal methods (Part 1 §1.6.4 #7): replay's transaction, an unreadable
// journal's bytes kept in the `recovered` store, and the strict commit that lets a journal go.

/** A journal key that couldn't be read: its text, kept as it was (§1.6.11.2's `recovered`). */
export type RecoveredBytes = {
    id: string
    source: 'journal'
    /** The key without the editor's prefix. */
    from: string
    sessionId?: string
    text: string
    appVersion: string
}

/**
 * A journal that can't be applied or kept as a recovery session, by an error that will recur
 * (not storage being unavailable or busy): the page keeps its bytes in the `recovered` store.
 */
export class JournalUnappliableError extends Error {
    override name = 'JournalUnappliableError'
}

/** Whether a failure is storage's (unavailable, full, busy), which a later load may not meet. */
export const isStorageFailure = (error: unknown) => {
    if (error instanceof StorageRefusedError || error instanceof MaintTimeoutError) return true
    const cause = error instanceof StoragePausedError ? error.cause : error
    return (
        cause instanceof DOMException ||
        cause instanceof MaintTimeoutError ||
        cause instanceof StorageRefusedError
    )
}

export const journalHandlers = (context: WorkerContext, outside: Waiter = directWaiter) => {
    // Each wait outside IndexedDB counts as the call's progress (§1.6.5).
    const waiterOf = (progress: Progress): Waiter => ({
        wait: async (promise) => {
            try {
                return await outside.wait(promise)
            } finally {
                progress.tick?.()
            }
        },
    })
    return {
        /**
         * Applies a journal, or keeps it as a recovery session, in one strict transaction. An apply
         * that fails by an error that will recur is kept as a recovery session instead, and one
         * that can't be either throws `JournalUnappliableError`, so no journal fails every load.
         */
        applyJournal: async (
            batch: JournalApplyBatch,
            scope?: CallScope,
        ): Promise<JournalApplyResult> => {
            const progress: Progress = scope ?? {}
            const write = (force?: string) =>
                context.core.write(
                    JOURNAL_STORES,
                    (tx) => writeJournalApply(tx, batch, prepared, force ? { force } : {}),
                    { durability: 'strict', ...progress },
                )
            let prepared: Awaited<ReturnType<typeof prepareJournal>>
            try {
                prepared = await prepareJournal(batch, waiterOf(progress))
            } catch (error) {
                throw new JournalUnappliableError(`Its state could not be stored: ${String(error)}`)
            }
            try {
                return await write()
            } catch (error) {
                if (isStorageFailure(error)) throw error
                const cause = error instanceof StoragePausedError ? error.cause : error
                try {
                    return await write(`the apply failed: ${String(cause)}`)
                } catch (second) {
                    if (isStorageFailure(second)) throw second
                    throw new JournalUnappliableError(String(cause))
                }
            }
        },

        /** Moves an unreadable journal's bytes into the `recovered` store, strictly. */
        keepRecovered: (item: RecoveredBytes, scope?: CallScope) =>
            context.core.write(
                ['recovered', 'meta'],
                async (tx) => {
                    const foundAt = Math.max(
                        Date.now(),
                        ((await readMeta(tx, 'maxSeenTime')) ?? 0) + 1,
                    )
                    const bytes = new Blob([item.text], { type: 'text/plain;charset=utf-8' })
                    await tx.put('recovered', {
                        id: item.id,
                        source: item.source,
                        from: item.from,
                        ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
                        bytes,
                        size: bytes.size,
                        foundAt,
                        appVersion: item.appVersion,
                    })
                    await writeMeta(tx, 'maxSeenTime', foundAt)
                },
                { durability: 'strict', ...scope },
            ),

        /**
         * Commits strictly, so what relaxed flushes stored before it is durable too and their
         * journals can be cleared (§1.6.4: a key is cleared only after a strict commit covers it).
         */
        syncStrict: (_: undefined, scope?: CallScope) =>
            context.core.write(
                ['meta'],
                async (tx) => {
                    await writeMeta(tx, 'maxSeenTime', (await readMeta(tx, 'maxSeenTime')) ?? 0)
                },
                { durability: 'strict', ...scope },
            ),
    }
}

export type JournalHandlers = ReturnType<typeof journalHandlers>
