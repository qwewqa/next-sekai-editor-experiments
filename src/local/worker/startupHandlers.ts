import { readMeta } from '../db'
import { prepareFlush, type FlushBatch } from '../flushWrite'
import { HANDLES } from '../handleRows'
import { readRecent } from '../recent'
import { directWaiter, type Waiter } from '../scheduler'
import {
    MIGRATION_STORES,
    writeMigration,
    type MigrationBatch,
    type MigrationResult,
} from '../startup/migrationWrite'
import {
    readBindings,
    readNewestSession,
    readSessionForOpen,
    writeChainFields,
    type ChainFieldsResult,
} from '../startup/stored'
import { refuseUnlessStored, StorageRefusedError, type Progress } from './core'
import type { WorkerContext } from './handlers'
import type { CallScope } from './rpc'

// The storage worker's startup methods: the canary's ids, reading
// a session to open it, the most recent session, chain-field writes from the head, and the auto
// save migration's transaction.

const READ_STORES = ['sessions', 'chains', 'entries', 'stackBlocks', 'nodes', 'meta']

export const startupHandlers = (context: WorkerContext, outside: Waiter = directWaiter) => {
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
        /** `meta.dbInstanceId` and `meta.deviceId`, for the canary; never memory's. */
        readMetaIds: async () => {
            // A worker restarted over memory: its ids would read as a cleared database.
            if (context.core.status.mode === 'memory') throw new StorageRefusedError('failed')
            return context.core.read(['meta'], async (tx) => ({
                dbInstanceId: await readMeta(tx, 'dbInstanceId'),
                deviceId: await readMeta(tx, 'deviceId'),
            }))
        },

        /** Whether `meta.migratedHashes` holds an old auto save's hash. */
        migratedBefore: (hash: string) =>
            context.core.read(['meta'], async (tx) =>
                ((await readMeta(tx, 'migratedHashes')) ?? []).includes(hash),
            ),

        /** A session with its chain and stack, to open it. */
        readSession: (sessionId: string, scope?: CallScope) =>
            context.core.read(READ_STORES, (tx) => readSessionForOpen(tx, sessionId), scope),

        /** The most recent session a new visit continues. */
        readNewestSession: (_: undefined, scope?: CallScope) =>
            context.core.read(READ_STORES, readNewestSession, scope),

        /** Recent Sessions' list: every chain not marked for Delete, newest first. */
        listRecent: () => context.core.read(['chains', 'sessions', 'stackBlocks'], readRecent),

        /** The bindings of sessions open in other tabs, for the bound-elsewhere check. */
        readBindings: (sessionIds: string[]) =>
            context.core.read(['sessions', 'chains'], (tx) => readBindings(tx, sessionIds)),

        /** Chain fields from the chain's head, committed strictly. */
        writeChainFields: (
            request: Parameters<typeof writeChainFields>[1],
            scope?: CallScope,
        ): Promise<ChainFieldsResult> =>
            context.core.write(
                ['chains', 'sessions', HANDLES],
                (tx) => writeChainFields(tx, request),
                {
                    durability: 'strict',
                    ...scope,
                },
            ),

        /** The `recovered` store's rows without their bytes, for Local Data. */
        listRecovered: () =>
            context.core.read(['recovered'], async (tx) =>
                (await tx.getAll('recovered')).map((row) => {
                    const { bytes: _bytes, ...rest } = row as Record<string, unknown>
                    return rest as {
                        id: string
                        source: string
                        from: string
                        sessionId?: string
                        size: number
                        foundAt: number
                        appVersion: string
                    }
                }),
            ),

        /** A `recovered` row's bytes as text, for Download; undefined when it's gone. */
        readRecovered: async (id: string) => {
            const row = (await context.core.read(['recovered'], (tx) =>
                tx.get('recovered', id),
            )) as { bytes?: Blob } | undefined
            return row?.bytes ? await outside.wait(row.bytes.text()) : undefined
        },

        /** Discard… on unreadable recovered work: the only thing that removes a row. */
        discardRecovered: (id: string, scope?: CallScope) =>
            context.core.write(['recovered'], (tx) => tx.delete('recovered', id), {
                durability: 'strict',
                ...scope,
            }),

        /** The auto save as a session, in one strict transaction, only into the database. */
        migrateAutoSave: async (
            batch: MigrationBatch,
            scope?: CallScope,
        ): Promise<MigrationResult> => {
            refuseUnlessStored(context.core.status)
            const progress: Progress = scope ?? {}
            const prepared = await prepareFlush(
                {
                    text: batch.text,
                    ends: batch.ends,
                    snapshots: [batch.snapshot],
                    media: [],
                    entries: [],
                } as unknown as FlushBatch,
                waiterOf(progress),
            )
            return context.core.write(
                MIGRATION_STORES,
                (tx) => writeMigration(tx, batch, prepared),
                { durability: 'strict', ...progress },
            )
        },
    }
}

export type StartupHandlers = ReturnType<typeof startupHandlers>
