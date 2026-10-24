import type { LockMode, LockService, LockSnapshot } from '../platform/types'

// The maintenance lock. Writers hold `nse-maint` shared only around their
// transaction, after deflate, verify and hash, and wait at most 3 s for it. Every transaction that
// deletes rows or bodies runs inside it exclusive (`StorageCore.exclusive`, R1), always requested
// with ifAvailable, so a deleter never queues in front of a writer.

export const MAINT_LOCK = 'nse-maint'
export const sessionLock = (sessionId: string) => `nse-session:${sessionId}`
export const importLock = (sessionId: string) => `nse-import:${sessionId}`
export const clientLock = (random: string) => `nse-client:${random}`

/** How long a writer waits for `nse-maint` before storing counts as paused. */
export const MAINT_WAIT_MS = 3000

/** A writer's 3 s wait for `nse-maint` ran out. */
export class MaintTimeoutError extends Error {
    constructor() {
        super('nse-maint was not granted within 3 s')
        this.name = 'MaintTimeoutError'
    }
}

export type Timers = {
    setTimeout: (fn: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
}

export const realTimers: Timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
}

/** Runs fn holding `nse-maint` shared: the writer's side, around one transaction. */
export const withMaintShared = async <T>(
    locks: LockService,
    fn: () => Promise<T>,
    { waitMs = MAINT_WAIT_MS, timers = realTimers }: { waitMs?: number; timers?: Timers } = {},
): Promise<T> => {
    const controller = new AbortController()
    const timer = timers.setTimeout(() => {
        controller.abort()
    }, waitMs)
    try {
        return await locks.request(
            MAINT_LOCK,
            { mode: 'shared', signal: controller.signal },
            async () => {
                timers.clearTimeout(timer)
                return fn()
            },
        )
    } catch (error) {
        if (
            controller.signal.aborted &&
            error instanceof DOMException &&
            error.name === 'AbortError'
        )
            throw new MaintTimeoutError()
        throw error
    } finally {
        timers.clearTimeout(timer)
    }
}

/**
 * Runs one batch holding `nse-maint` exclusive, requested with ifAvailable: undefined when the
 * lock is held, and the caller backs off to the next idle period or visibility change.
 */
export const withMaintExclusive = <T>(locks: LockService, batch: () => Promise<T>) =>
    locks.request(MAINT_LOCK, { mode: 'exclusive', ifAvailable: true }, async (held) =>
        held ? { ran: true as const, value: await batch() } : { ran: false as const },
    )

type NavigatorLocks = {
    request: (
        name: string,
        options: { mode?: LockMode; ifAvailable?: boolean; signal?: AbortSignal },
        callback: (lock: unknown) => Promise<unknown>,
    ) => Promise<unknown>
    query: () => Promise<{
        held?: { name?: string; mode?: LockMode; clientId?: string }[]
        pending?: { name?: string; mode?: LockMode; clientId?: string }[]
    }>
}

const navigatorLocks = () =>
    (globalThis as { navigator?: { locks?: NavigatorLocks } }).navigator?.locks

/** Whether this context has Web Locks (insecure origins have none). */
export const hasWebLocks = () => navigatorLocks() !== undefined

/** navigator.locks as a LockService, looked up per call so importing touches nothing. */
export const webLockService: LockService = {
    request: <T>(
        name: string,
        options: { mode?: LockMode; ifAvailable?: boolean; signal?: AbortSignal },
        callback: (held: boolean) => Promise<T>,
    ) => {
        const locks = navigatorLocks()
        if (!locks) return Promise.reject(new DOMException('No Web Locks', 'NotSupportedError'))
        return locks.request(name, options, (lock) => callback(lock !== null)) as Promise<T>
    },
    query: async (): Promise<LockSnapshot> => {
        const locks = navigatorLocks()
        if (!locks) throw new DOMException('No Web Locks', 'NotSupportedError')
        const snapshot = await locks.query()
        const info = (list: typeof snapshot.held) =>
            (list ?? []).map((lock) => ({
                name: lock.name ?? '',
                mode: lock.mode ?? 'exclusive',
                clientId: lock.clientId,
            }))
        return { held: info(snapshot.held), pending: info(snapshot.pending) }
    },
}
