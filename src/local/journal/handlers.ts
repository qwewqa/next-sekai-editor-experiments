import { readMeta, writeMeta } from '../db'
import { directWaiter, type Waiter } from '../scheduler'
import type { WorkerContext } from '../worker/handlers'
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

export const journalHandlers = (context: WorkerContext, waiter: Waiter = directWaiter) => ({
    /** Applies a journal, or keeps it as a recovery session, in one strict transaction. */
    applyJournal: async (batch: JournalApplyBatch): Promise<JournalApplyResult> => {
        const prepared = await prepareJournal(batch, waiter)
        return context.core.write(JOURNAL_STORES, (tx) => writeJournalApply(tx, batch, prepared), {
            durability: 'strict',
        })
    },

    /** Moves an unreadable journal's bytes into the `recovered` store, strictly. */
    keepRecovered: (item: RecoveredBytes) =>
        context.core.write(
            ['recovered', 'meta'],
            async (tx) => {
                const foundAt = Math.max(Date.now(), ((await readMeta(tx, 'maxSeenTime')) ?? 0) + 1)
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
            { durability: 'strict' },
        ),

    /**
     * Commits strictly, so what relaxed flushes stored before it is durable too and their
     * journals can be cleared (§1.6.4: a key is cleared only after a strict commit covers it).
     */
    syncStrict: () =>
        context.core.write(
            ['meta'],
            async (tx) => {
                await writeMeta(tx, 'maxSeenTime', (await readMeta(tx, 'maxSeenTime')) ?? 0)
            },
            { durability: 'strict' },
        ),
})

export type JournalHandlers = ReturnType<typeof journalHandlers>
