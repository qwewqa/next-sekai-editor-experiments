import { deleteHandleRow, HANDLES, KEPT_ROLE } from '../handleRows'
import { writeUnlink } from '../open/importWrite'
import {
    applyRevocation,
    BIND_STORES,
    keepHandle,
    listHandleOwners,
    listKept,
    readChainRecord,
    readSessionStarts,
    recordOwnSave,
    takeOver,
    type OwnSaveRecord,
    type Revocation,
    type TakeOver,
} from '../save/bind'
import type { WorkerContext } from './handlers'

// The storage worker's methods for the Save core's bindings (Part 1 §1.4.7 R3–R11): each a short
// transaction, committed strictly, so a takeover or a recorded Save is on disk before the write
// that relies on it.

export const bindHandlers = (context: WorkerContext) => ({
    /** A chain's record without handles, read again before a write (R10). */
    readChainRecord: (chainId: string) =>
        context.core.read(['chains'], (tx) => readChainRecord(tx, chainId)),

    /** Stored sessions' `startedAt`, for a binding kept in memory. */
    readSessionStarts: (sessionIds: string[]) =>
        context.core.read(['sessions'], (tx) => readSessionStarts(tx, sessionIds)),

    /** Every binding and Export target with a stored handle (R3). */
    listHandleOwners: () => context.core.read(['chains', 'handles'], listHandleOwners),

    /** The handle of a partial or unlinked open's file, kept while its session is open (D26). */
    keepHandle: ({ chainId, name, handle }: { chainId: string; name: string; handle: unknown }) =>
        context.core.write(['chains', HANDLES], (tx) => keepHandle(tx, chainId, name, handle)),

    /**
     * A kept file's handle let go: its session closed (§1.5.4). A planned seam for Step 7's
     * Recent Sessions and sweep, like `listKept`: nothing calls either until then.
     */
    dropKept: (chainId: string) =>
        context.core.write([HANDLES], (tx) => deleteHandleRow(tx, chainId, KEPT_ROLE)),

    /** The chains with a kept file, for a load's sweep. */
    listKept: () => context.core.read(['chains', HANDLES], listKept),

    /** A save picker's revocation and pre-bind, in one transaction (R5). */
    takeOver: (request: TakeOver) =>
        context.core.write(BIND_STORES, (tx) => takeOver(tx, request), { durability: 'strict' }),

    /** A revocation kept in localStorage while storage couldn't take it (R11). */
    applyRevocation: ({ chainId, revoke }: { chainId: string; revoke: Revocation }) =>
        context.core.write(BIND_STORES, (tx) => applyRevocation(tx, chainId, revoke), {
            durability: 'strict',
        }),

    /**
     * An append that met damage in the chain's own file (§1.6.11.8): the chain unlinks (a new
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

    /** Our own completed Save's binding, recorded and nothing else (§1.4.7). */
    recordOwnSave: (record: OwnSaveRecord) =>
        context.core.write(BIND_STORES, (tx) => recordOwnSave(tx, record), {
            durability: 'strict',
        }),
})
