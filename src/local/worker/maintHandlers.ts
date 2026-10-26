import { readDeleteCandidates } from '../candidates'
import { removeCachedMedia } from '../cleanup'
import { gcPass } from '../gc'
import {
    markTx,
    readDeleteTarget,
    readMarked,
    REMOVE_STORES,
    removeTx,
    undoTx,
    type Mark,
    type MarkRequest,
    type RemoveRequest,
    type RemoveResult,
} from '../removal'
import type { WorkerContext } from './handlers'
import type { CallScope } from './rpc'

// The storage worker's deletion methods: Delete's target, mark and Undo,
// the marked chains a sweep removes, the removal transaction, GC and cleanup under pressure. Every deleting transaction
// runs inside `core.exclusive` (R1); the page holds the session locks (R3).

export const maintHandlers = (context: WorkerContext) => ({
    /** A chain to Delete: its head, last edit and sessions, or gone (no record, or marked). */
    deleteTarget: (chainId: string) =>
        context.core.read(['chains', 'sessions'], (tx) => readDeleteTarget(tx, chainId)),

    /** Delete's mark, strict; a failure is the caller's to report, so storing goes on. */
    markDeleting: (request: MarkRequest, scope?: CallScope) =>
        context.core.write(['chains', 'sessions', 'meta'], (tx) => markTx(tx, request), {
            durability: 'strict',
            pauseOnFailure: false,
            ...scope,
        }),

    /** Undo of Deletes, in one strict transaction: restored, or lost to a sweep. */
    undoDeleting: (marks: Mark[], scope?: CallScope) =>
        context.core.write(['chains'], (tx) => undoTx(tx, marks), {
            durability: 'strict',
            pauseOnFailure: false,
            ...scope,
        }),

    /** The marked chains old enough to sweep. */
    listMarked: (request: { minAgeMs: number; wall: number }) =>
        context.core.read(['chains', 'sessions', 'meta'], (tx) => readMarked(tx, request)),

    /** Removes locked sessions in one transaction under `nse-maint` exclusive; busy when held. */
    removeSessions: async (request: RemoveRequest): Promise<RemoveResult> => {
        const ran = await context.core.exclusive((hold) =>
            hold.write(REMOVE_STORES, (tx) => removeTx(tx, request)),
        )
        return ran.ran ? ran.value : { kind: 'busy' }
    },

    /** Delete Sessions…: every unmarked chain with the facts the ranges and the not-saved test read. */
    deleteCandidates: () =>
        context.core.read(['chains', 'sessions', 'stackBlocks', 'meta'], readDeleteCandidates),

    /** One GC pass when due, or `always` (after a removal). */
    gcPass: (request: { always?: boolean } | undefined, scope?: CallScope) =>
        gcPass(context.core, {
            always: request?.always === true,
            ...(scope ? { tick: scope.tick } : {}),
        }),

    /** Cleanup under pressure: cached earlier media, largest first, until `bytes` are freed. */
    removeCachedMedia: (request: { bytes: number }) => removeCachedMedia(context.core, request),
})

export type MaintHandlers = ReturnType<typeof maintHandlers>
