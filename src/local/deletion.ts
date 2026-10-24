import type { JournalStore, LockService } from '../platform/types'
import type { GcResult } from './gc'
import type { JournalOutcome } from './journal/replay'
import { importLock, sessionLock } from './locks'
import type { DeleteTarget, Mark, Marked, RemoveRequest, RemoveResult } from './removal'
import { tryLease, type LockLease } from './sessions'
import { storedRead, type ReadWorker } from './storedRead'
import type { CallOptions } from './worker/rpc'
import type { StorageHandlers } from './worker/storage.worker'

// Delete, Undo and the sweep on the page. The page takes the locks and
// checks the journals (the worker can reach neither); the worker runs the transactions. A remover
// locks every session and import of a chain, or leaves the chain alone (R3), and never touches a
// session with a pending journal (R5).

export type { Mark } from './removal'

/** How old a Delete's mark is before the sweep removes the chain. */
export const SWEEP_AGE_MS = 10 * 60 * 1000

/** A GC pass can be long on a large profile: past the usual call timeout. */
const GC_TIMEOUT_MS = 10 * 60 * 1000

export type MarkDeletedResult =
    | { kind: 'marked'; mark: Mark }
    /** A session or import lock of the chain is held: open, building, importing or continuing. */
    | { kind: 'open' }
    /** No record, already marked, or a Delete of it in flight in this tab. */
    | { kind: 'gone' }
    /** A refused or failed read or write; storing goes on. */
    | { kind: 'failed' }

export type UndoDeletedResult =
    { kind: 'done'; restored: string[]; lost: string[] } | { kind: 'failed' }

export type RemoveLockedResult =
    | RemoveResult
    | { kind: 'open' }
    /** A session has a pending journal: the next load replays it first. */
    | { kind: 'journal' }
    | { kind: 'failed' }

export type SweepResult = { removed: number; busy: boolean }

export type DeletionDeps = {
    worker: ReadWorker
    locks: LockService
    journal: Pick<JournalStore, 'read'>
    /** Applies a session's pending journal under the lock the caller holds. */
    replayJournal: (sessionId: string) => Promise<JournalOutcome | undefined>
    /** Tells lists in every tab that sessions changed. */
    updated: () => void
    /** Asks for a sweep at this wall time (the maintenance runner's timer). */
    sweepAt?: (at: number) => void
    now?: () => number
}

type Worker = DeletionDeps['worker']

/** A worker call, typed by its handler. */
const call = <K extends keyof StorageHandlers>(
    worker: Worker,
    method: K,
    arg: Parameters<StorageHandlers[K]>[0],
    options?: CallOptions,
) => worker.call(method, arg as never, options) as Promise<Awaited<ReturnType<StorageHandlers[K]>>>

/** Every session and import lock of a chain, exclusive and ifAvailable; undefined if any is held. */
const lockChain = async (
    locks: LockService,
    sessions: readonly string[],
): Promise<LockLease[] | undefined> => {
    const held: LockLease[] = []
    for (const id of sessions)
        for (const name of [sessionLock(id), importLock(id)]) {
            const lease = await tryLease(locks, name, { mode: 'exclusive', ifAvailable: true })
            if (!lease) {
                for (const each of held) each.release()
                return
            }
            held.push(lease)
        }
    return held
}

/** Runs a GC pass, `always` after a removal; a failure waits for the next trigger. */
export const runGc = (worker: Worker, always: boolean): Promise<GcResult | undefined> =>
    call(worker, 'gcPass', { always }, { timeoutMs: GC_TIMEOUT_MS }).catch(() => undefined)

export const createDeletion = (deps: DeletionDeps) => {
    const { worker, locks, journal } = deps
    const now = deps.now ?? Date.now
    const inFlight = new Set<string>()

    const journalled = async (sessions: readonly string[]) => {
        const found = new Set((await journal.read()).map((each) => each.sessionId))
        return sessions.filter((id) => found.has(id))
    }

    /** The removal primitive: locks, journal check, one worker transaction. */
    const removeLocked = async (request: RemoveRequest): Promise<RemoveLockedResult> => {
        const leases = await lockChain(locks, request.locked)
        if (!leases) return { kind: 'open' }
        let result: RemoveLockedResult
        try {
            if ((await journalled(request.locked)).length) return { kind: 'journal' }
            result = await call(worker, 'removeSessions', request)
        } catch {
            return { kind: 'failed' }
        } finally {
            for (const lease of leases) lease.release()
        }
        if (result.kind === 'removed') deps.updated()
        return result
    }

    /** Delete: applies the chain's journals, then marks it; the sweep removes it later. */
    const markDeleted = async (chainId: string): Promise<MarkDeletedResult> => {
        if (inFlight.has(chainId)) return { kind: 'gone' }
        inFlight.add(chainId)
        try {
            const read = await storedRead(worker, 'deleteTarget', chainId)
            if (read.storedRead === 'failed') return { kind: 'failed' }
            const target: DeleteTarget = read.storedValue
            if (target.kind === 'gone') return { kind: 'gone' }
            const leases = await lockChain(locks, target.sessions)
            if (!leases) return { kind: 'open' }
            let marked: Mark
            try {
                // A journal that can't be applied stays: R5 keeps the chain until a load does.
                for (const id of await journalled(target.sessions)) await deps.replayJournal(id)
                const result = await call(worker, 'markDeleting', {
                    chainId,
                    sessions: target.sessions,
                    head: target.head,
                    wall: now(),
                })
                // Changed: another tab continued the chain meanwhile, so it is open.
                if (result.kind === 'changed') return { kind: 'open' }
                if (result.kind === 'gone') return { kind: 'gone' }
                marked = { chainId, at: result.at }
            } catch {
                return { kind: 'failed' }
            } finally {
                for (const lease of leases) lease.release()
            }
            deps.updated()
            deps.sweepAt?.(marked.at + SWEEP_AGE_MS)
            return { kind: 'marked', mark: marked }
        } finally {
            inFlight.delete(chainId)
        }
    }

    /** Undo (R9): clears each mark that is still the one its Delete wrote. */
    const undoDeleted = async (marks: Mark[]): Promise<UndoDeletedResult> => {
        let result: { restored: string[]; lost: string[] }
        try {
            result = await call(worker, 'undoDeleting', marks)
        } catch {
            return { kind: 'failed' }
        }
        if (result.restored.length) deps.updated()
        return { kind: 'done', ...result }
    }

    /** Removes the chains marked at least `minAgeMs` ago; the runner's GC follows. */
    const sweepDeleted = async (minAgeMs = SWEEP_AGE_MS): Promise<SweepResult> => {
        let marked: Marked[]
        try {
            marked = await call(worker, 'listMarked', { minAgeMs, wall: now() })
        } catch {
            return { removed: 0, busy: false }
        }
        let removed = 0
        let busy = false
        for (const chain of marked) {
            const result = await removeLocked({
                chainId: chain.chainId,
                locked: chain.sessions,
                expect: { head: chain.head, updatedAt: chain.updatedAt, deleting: chain.at },
                reason: 'delete',
            })
            if (result.kind === 'removed') removed++
            else if (result.kind === 'busy') busy = true
        }
        return { removed, busy }
    }

    return { markDeleted, undoDeleted, sweepDeleted, removeLocked }
}

export type Deletion = ReturnType<typeof createDeletion>

let current: Deletion | undefined

/** This tab's deletion, once storing started stored (the maintenance runner sets it). */
export const setDeletion = (deletion: Deletion | undefined) => {
    current = deletion
}

/** Recent Sessions' Delete: marks the chain; `failed` before storage is ready. */
export const markDeleted = (chainId: string): Promise<MarkDeletedResult> =>
    current ? current.markDeleted(chainId) : Promise.resolve({ kind: 'failed' })

/** Undo of one or more Deletes. */
export const undoDeleted = (marks: Mark[]): Promise<UndoDeletedResult> =>
    current ? current.undoDeleted(marks) : Promise.resolve({ kind: 'failed' })

/** The sweep; a spec passes 0 to remove every marked chain now. */
export const sweepDeleted = (minAgeMs = SWEEP_AGE_MS): Promise<SweepResult> =>
    current ? current.sweepDeleted(minAgeMs) : Promise.resolve({ removed: 0, busy: false })

/** The removal primitive for Delete Sessions… and cleanup. */
export const removeLocked = (request: RemoveRequest): Promise<RemoveLockedResult> =>
    current ? current.removeLocked(request) : Promise.resolve({ kind: 'failed' })
