import {
    applyRevocation,
    BIND_STORES,
    finishOwnSave,
    listHandleOwners,
    readChainRecord,
    readSessionStarts,
    takeOver,
    type Revocation,
    type SaveEntryForm,
    type TakeOver,
} from '../save/bind'
import type { IdentityUnit } from '../save/commit'
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

    /** A save picker's revocation and pre-bind, in one transaction (R5). */
    takeOver: (request: TakeOver) =>
        context.core.write(BIND_STORES, (tx) => takeOver(tx, request), { durability: 'strict' }),

    /** A revocation kept in localStorage while storage couldn't take it (R11). */
    applyRevocation: ({ chainId, revoke }: { chainId: string; revoke: Revocation }) =>
        context.core.write(BIND_STORES, (tx) => applyRevocation(tx, chainId, revoke), {
            durability: 'strict',
        }),

    /** Our own completed Save, recorded (§1.4.7). */
    finishOwnSave: ({
        chainId,
        entry,
        unit,
    }: {
        chainId: string
        entry: SaveEntryForm
        unit: IdentityUnit
    }) =>
        context.core.write(BIND_STORES, (tx) => finishOwnSave(tx, chainId, entry, unit), {
            durability: 'strict',
        }),
})
