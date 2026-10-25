import { HANDLES } from '../handleRows'
import { writeUnlink } from '../open/importWrite'
import {
    BIND_STORES,
    keepHandle,
    listHandleOwners,
    readChainRecord,
    readSessionStarts,
    recordOwnSave,
    takeOver,
    type OwnSaveRecord,
    type TakeOver,
} from '../save/bind'
import type { WorkerContext } from './handlers'

// The storage worker's methods for the Save core's bindings: each a short
// transaction, committed strictly, so a takeover or a recorded Save is on disk before the write
// that relies on it.

export const bindHandlers = (context: WorkerContext) => ({
    /** A chain's record without handles, read again before a write. */
    readChainRecord: (chainId: string) =>
        context.core.read(['chains'], (tx) => readChainRecord(tx, chainId)),

    /** Stored sessions' `startedAt`, for a binding kept in memory. */
    readSessionStarts: (sessionIds: string[]) =>
        context.core.read(['sessions'], (tx) => readSessionStarts(tx, sessionIds)),

    /** Every binding and Export target with a stored handle. */
    listHandleOwners: () => context.core.read(['chains', 'handles'], listHandleOwners),

    /** The handle of a partial or unlinked open's file, kept while its session is open. */
    keepHandle: ({ chainId, name, handle }: { chainId: string; name: string; handle: unknown }) =>
        context.core.write(['chains', HANDLES], (tx) => keepHandle(tx, chainId, name, handle)),

    /** A save picker's revocation and pre-bind, in one transaction. */
    takeOver: (request: TakeOver) =>
        context.core.write(BIND_STORES, (tx) => takeOver(tx, request), { durability: 'strict' }),

    /**
     * An append that met damage in the chain's own file: the chain unlinks (a new
     * `docId`, no `revision`, no binding), with nothing marked.
     */
    unlinkChain: ({
        chainId,
        docId,
        appVersion,
    }: {
        chainId: string
        docId: string
        appVersion: string
    }) =>
        context.core.write(
            ['chains', 'entries', HANDLES],
            (tx) =>
                writeUnlink(tx, {
                    sessionId: '',
                    chainId,
                    docId,
                    hashes: [],
                    roots: [],
                    appVersion,
                }),
            { durability: 'strict' },
        ),

    /** Our own completed Save's binding, recorded and nothing else. */
    recordOwnSave: (record: OwnSaveRecord) =>
        context.core.write(BIND_STORES, (tx) => recordOwnSave(tx, record), {
            durability: 'strict',
        }),
})
