import { FLUSH_STORES, prepareFlush, type FlushBatch } from '../flushWrite'
import { HANDLES } from '../handleRows'
import { KeyRange } from '../kv/types'
import { readEarlierChains } from '../open/earlier'
import type { ImportTarget } from '../open/importLoop'
import {
    prepareBatch,
    prepareOpenHead,
    readStoredChunks,
    rootsReaching,
    writeAbandon,
    writeBatch,
    writeOpenHead,
    writeUnlink,
    type BatchOutcome,
    type OpenStoreRequest,
    type OpenStoreResult,
} from '../open/importWrite'
import {
    attachOpened,
    dropOpened,
    dropOpenedFor,
    openedFile,
    readOpened,
    type OpenReadReply,
} from '../open/opened'
import { directWaiter, type Waiter } from '../scheduler'
import type { Progress } from './core'
import type { WorkerContext } from './handlers'
import type { CallScope } from './rpc'

// The storage worker's open methods (Part 1 §1.5.4): reading a picked `.nxsp`, the open's first
// transaction, the background import's batches, the unlink on damage (§1.6.11.8), and ending
// an import that can't go on. The page drives the batches, holding `nse-import:<sessionId>`.

/** Why a batch couldn't run: the file isn't open in this worker (a restart): read it again. */
export type NotOpened = { kind: 'notOpened' }

export const openHandlers = (context: WorkerContext, outside: Waiter = directWaiter) => {
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
        /** Reads a picked file; a `.nxsp` stays open here under the reply's id. */
        openRead: (file: Blob, scope?: CallScope): Promise<OpenReadReply> => {
            scope?.tick()
            return readOpened(file).finally(() => scope?.tick())
        },

        /** Forgets an opened file: a cancelled open, or an import that ended. */
        openDrop: (id: string) => {
            dropOpened(id)
            return true
        },

        /** The open's first transaction, strict; the import's batches are planned after it. */
        openStore: async (
            request: OpenStoreRequest,
            scope?: CallScope,
        ): Promise<(OpenStoreResult & { batches: number }) | NotOpened> => {
            const progress: Progress = scope ?? {}
            const opened = openedFile(request.id)
            if (!opened) return { kind: 'notOpened' }
            const waiter = waiterOf(progress)
            const prepared = await prepareOpenHead(
                opened,
                request,
                (batch) =>
                    prepareFlush(
                        {
                            text: batch.text,
                            ends: batch.ends,
                            snapshots: [batch.snapshot],
                            media: [],
                            entries: [],
                        } as unknown as FlushBatch,
                        waiter,
                    ),
                waiter,
            )
            const result = await context.core.write(
                FLUSH_STORES,
                (tx) => writeOpenHead(tx, opened, request, prepared),
                { durability: 'strict', ...progress },
            )
            for (const hash of result.mediaFailed ?? []) context.core.mediaFailed(hash)
            attachOpened(opened, request.ids.sessionId, prepared.stored, !!prepared.entries)
            if (!opened.plan) dropOpened(opened.id)
            return { ...result, batches: opened.plan?.length ?? 0 }
        },

        /**
         * Reads the bound file again to resume an import a tab didn't finish (§1.5.4), when its
         * revision and fingerprint are still the binding's.
         */
        openResume: async (
            request: { sessionId: string; file: Blob; revisionId?: string; fingerprint?: string },
            scope?: CallScope,
        ): Promise<
            | { kind: 'resumed'; id: string; batches: number }
            | { kind: 'changed' }
            | { kind: 'unreadable' }
        > => {
            scope?.tick()
            let reply: OpenReadReply
            try {
                reply = await readOpened(request.file)
            } catch {
                return { kind: 'unreadable' }
            }
            if (reply.kind !== 'nxsp') return { kind: 'unreadable' }
            const opened = openedFile(reply.id)
            if (
                !opened?.read.history ||
                reply.disk?.fingerprint !== request.fingerprint ||
                reply.project?.revision?.id !== request.revisionId
            ) {
                dropOpened(reply.id)
                return opened?.read.history ? { kind: 'changed' } : { kind: 'unreadable' }
            }
            attachOpened(opened, request.sessionId, new Set())
            return { kind: 'resumed', id: opened.id, batches: opened.plan?.length ?? 0 }
        },

        /** One background batch: prepared, then its own transaction. */
        openBatch: async (
            { id, n }: { id: string; n: number },
            scope?: CallScope,
        ): Promise<BatchOutcome | NotOpened> => {
            const progress: Progress = scope ?? {}
            const opened = openedFile(id)
            const batch = opened?.plan?.[n]
            const history = opened?.read.history
            const sessionId = opened?.sessionId
            if (!opened || !batch || !history || !sessionId) return { kind: 'notOpened' }
            const storedChunks =
                batch.kind === 'chunks'
                    ? await context.core.read(
                          ['chunks'],
                          (tx) => readStoredChunks(tx, batch.hashes),
                          progress,
                      )
                    : new Set<string>()
            const prepared = await prepareBatch(
                history,
                sessionId,
                batch,
                storedChunks,
                waiterOf(progress),
            )
            if (prepared.kind === 'readError') return prepared
            return context.core.write(
                ['sessions', 'entries', 'nodes', 'chunks', 'meta'],
                (tx) => writeBatch(tx, sessionId, prepared, Date.now()),
                progress,
            )
        },

        /**
         * Damage found by the import in the chain's own file (§1.6.11.8): the chain unlinks, and
         * the rows whose states need the bad chunks become `kept: false`.
         */
        openUnlink: async (
            request: {
                id: string
                chainId: string
                docId: string
                hashes: string[]
                appVersion: string
            },
            scope?: CallScope,
        ) => {
            const opened = openedFile(request.id)
            const history = opened?.read.history
            const sessionId = opened?.sessionId
            if (!history || !sessionId) return
            const roots = [...rootsReaching(history, new Set(request.hashes))]
            return context.core.write(
                ['chains', 'entries', HANDLES],
                (tx) =>
                    writeUnlink(tx, {
                        sessionId,
                        chainId: request.chainId,
                        docId: request.docId,
                        hashes: request.hashes,
                        roots,
                        appVersion: request.appVersion,
                    }),
                { durability: 'strict', ...scope },
            )
        },

        /** Ends an import that can't go on: rows whose states never arrived become `kept: false`. */
        openAbandon: (sessionId: string, scope?: CallScope) => {
            dropOpenedFor(sessionId)
            return context.core.write(
                ['sessions', 'entries', 'nodes', 'chunks'],
                (tx) => writeAbandon(tx, sessionId),
                { durability: 'strict', ...scope },
            )
        },

        /** What a resumed import reads of its chain: the binding and the base revision. */
        openImportTarget: (chainId: string) =>
            context.core.read(['chains'], async (tx): Promise<ImportTarget | undefined> => {
                const chain = (await tx.get('chains', chainId)) as
                    Record<string, unknown> | undefined
                if (!chain) return
                // Never its handle: the page reads that through `handleOf` (D24).
                const bound = chain.file as ImportTarget['file']
                const file = bound && { name: bound.name, disk: bound.disk }
                const revision = chain.revision as { id?: unknown } | undefined
                return {
                    ...(file ? { file } : {}),
                    ...(typeof revision?.id === 'string' ? { revisionId: revision.id } : {}),
                }
            }),

        /**
         * The chains of a document other than `exclude`, as the open's notice reads them (§1.5.4
         * step 4): each one's latest session, base revision, binding, whether its head differs
         * from its file event's state, and when it was last edited.
         */
        openEarlierChains: ({ docId, exclude }: { docId: string; exclude: string }) =>
            context.core.read(['chains', 'sessions', 'stackBlocks', HANDLES], (tx) =>
                readEarlierChains(tx, docId, exclude),
            ),

        /**
         * Sessions whose open's import hasn't finished, with their chains (§1.6.11.2's
         * `importPending`); never one of a chain marked for Delete (R8).
         */
        openPendingImports: () =>
            context.core.read(['sessions', 'chains'], async (tx) => {
                const out: { sessionId: string; chainId: string }[] = []
                for (const row of (await tx.getAll('sessions', KeyRange.lowerBound(''))) as Record<
                    string,
                    unknown
                >[]) {
                    if (row.importPending !== true || typeof row.chainId !== 'string') continue
                    const chain = (await tx.get('chains', row.chainId)) as
                        Record<string, unknown> | undefined
                    if (chain?.deleting !== undefined) continue
                    out.push({ sessionId: String(row.id), chainId: row.chainId })
                }
                return out
            }),
    }
}

export type OpenHandlers = ReturnType<typeof openHandlers>
