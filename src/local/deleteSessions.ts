import { dayKey, daysBetween, hostZone, type Zone } from '../calendar/calendar'
import { recordError } from '../diagnostics'
import type { LockService } from '../platform/types'
import { runGc, type RemoveLockedResult } from './deletion'
import { notSavedToFile } from './keptData'
import { importLock, sessionLock } from './locks'
import { displayName } from './names'
import type { RemoveRequest } from './removal'
import type { ShownName } from './startup/events'
import { storedRead, type ReadWorker, type StoredRead } from './storedRead'
import type { PauseReason } from './worker/core'

// Delete Sessions…. The page reads the chains once
// (`readDeleteChoices`), the dialog counts and names them, and `deleteSessions` then removes
// exactly the chains it is given, each whole through the removal primitive: a chain opened, given
// a journal or edited since the read is skipped. It runs GC afterwards, so a full browser finds
// the space (after the reclaim of what the chains left outside storage), and asks storing to try
// again when it was paused for being full.

/** One chain as the dialog counts and names it. */
export type DeleteChain = {
    chainId: string
    /** The removal's `expect` (a damaged chain has no `head`), and the sessions the page locks. */
    head?: string
    updatedAt: number
    fileAt?: number
    sessions: string[]
    /** Whole local calendar days between the last edit and now by the wall clock; 0 for an edit in the future. */
    ageDays: number
    /** `notSavedToFile`; a chain this build can't read counts as not saved. */
    notSaved: boolean
    /** `newer` or `damaged`: it has a session this build can't read, or no head; deleted all the same. */
    readable: 'yes' | 'newer' | 'damaged'
    name: ShownName
}

export type DeleteSessionsResult =
    | { deleted: number; skipped: number }
    /** The worker failed on a removal: what went before stays deleted. */
    | { kind: 'failed'; deleted: number }

/** A busy `nse-maint` is retried about this often, for at most `BUSY_LIMIT_MS` in all. */
export const BUSY_RETRY_MS = 200
export const BUSY_LIMIT_MS = 10_000

export type DeleteSessionsDeps = {
    worker: ReadWorker
    locks: LockService
    /** The deletion's primitive (`removeLocked`). */
    removeLocked: (request: RemoveRequest) => Promise<RemoveLockedResult>
    /** Why storing is paused now, if it is. */
    paused: () => PauseReason | undefined
    /** Try Again for storing; called after GC when storing is paused `full`. */
    retryStoring: () => Promise<unknown>
    /** Removes what deleted chains left outside storage (markers, kept copies). */
    reclaim?: () => Promise<void>
    zone?: () => Zone
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    gc?: () => Promise<unknown>
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const createDeleteSessions = (deps: DeleteSessionsDeps) => {
    const { worker, locks } = deps
    const now = deps.now ?? Date.now
    const sleep = deps.sleep ?? wait
    const gc = deps.gc ?? (() => runGc(worker, true))

    /** The sessions held now, in this tab or another: those chains are left out. */
    const heldSessions = async () => {
        const snapshot = await locks.query()
        const held = new Set<string>()
        for (const { name } of snapshot.held)
            for (const lock of [sessionLock, importLock]) {
                const prefix = lock('')
                if (name.startsWith(prefix)) held.add(name.slice(prefix.length))
            }
        return held
    }

    /** Every chain not marked for Delete and not held open now, in storage's order (newest first). */
    const readDeleteChoices = async (): Promise<StoredRead<DeleteChain[]>> => {
        const read = await storedRead(worker, 'deleteCandidates', undefined)
        if (read.storedRead === 'failed') return read
        let held: Set<string>
        try {
            held = await heldSessions()
        } catch (error) {
            recordError(error)
            return { storedRead: 'failed', storedError: error }
        }
        const chains = read.storedValue
        const zone = (deps.zone ?? hostZone)()
        const today = dayKey(now(), zone)
        const out: DeleteChain[] = []
        for (const chain of chains) {
            if (chain.sessions.some((id) => held.has(id))) continue
            out.push({
                chainId: chain.chainId,
                ...(chain.head === undefined ? {} : { head: chain.head }),
                updatedAt: chain.updatedAt,
                ...(chain.fileAt === undefined ? {} : { fileAt: chain.fileAt }),
                sessions: chain.sessions,
                ageDays: Math.max(0, daysBetween(dayKey(chain.updatedAt, zone), today)),
                notSaved: notSavedToFile(chain),
                readable: chain.readable,
                name: { name: displayName(chain.nameParts), at: chain.startedAt },
            })
        }
        return { storedRead: 'value', storedValue: out }
    }

    /**
     * Removes exactly these chains. `onProgress` hears each chain as it is dealt with; `signal`
     * stops between chains (each removal is whole). A busy `nse-maint` is waited for at most
     * `BUSY_LIMIT_MS` in all: after that a busy chain is skipped without waiting.
     */
    const deleteSessions = async (
        targets: readonly DeleteChain[],
        onProgress?: (done: number, total: number) => void,
        signal?: AbortSignal,
    ): Promise<DeleteSessionsResult> => {
        let deleted = 0
        let skipped = 0
        let failed = false
        let waited = 0
        for (const [index, chain] of targets.entries()) {
            if (signal?.aborted) break
            let result: RemoveLockedResult
            for (;;) {
                result = await deps.removeLocked({
                    chainId: chain.chainId,
                    locked: chain.sessions,
                    expect: { head: chain.head, updatedAt: chain.updatedAt, fileAt: chain.fileAt },
                    reason: 'deleteSessions',
                })
                if (result.kind !== 'busy' || waited >= BUSY_LIMIT_MS) break
                await sleep(BUSY_RETRY_MS)
                waited += BUSY_RETRY_MS
            }
            if (result.kind === 'failed') {
                failed = true
                break
            }
            if (result.kind === 'removed') deleted++
            else skipped++
            onProgress?.(index + 1, targets.length)
        }
        if (deleted) {
            // Before GC and Try Again, so a full browser finds the space the kept copies held.
            await deps.reclaim?.().catch(() => undefined)
            await gc()
            if (deps.paused() === 'full') await deps.retryStoring().catch(() => undefined)
        }
        return failed ? { kind: 'failed', deleted } : { deleted, skipped }
    }

    return { readDeleteChoices, deleteSessions }
}

export type DeleteSessions = ReturnType<typeof createDeleteSessions>

let current: DeleteSessions | undefined

/** This tab's Delete Sessions…, once storing started stored (the maintenance runner sets it). */
export const setDeleteSessions = (next: DeleteSessions | undefined) => {
    current = next
}

/** The chains to choose from, or the failure; `failed` before storage is ready. */
export const readDeleteChoices = (): Promise<StoredRead<DeleteChain[]>> =>
    current
        ? current.readDeleteChoices()
        : Promise.resolve({ storedRead: 'failed', storedError: new Error('Storage is not ready') })

/** Removes exactly the confirmed chains. */
export const deleteSessions = (
    targets: readonly DeleteChain[],
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal,
): Promise<DeleteSessionsResult> =>
    current
        ? current.deleteSessions(targets, onProgress, signal)
        : Promise.resolve({ kind: 'failed', deleted: 0 })
