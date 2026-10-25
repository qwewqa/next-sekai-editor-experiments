import type { LockService } from '../platform/types'
import { clientLock, sessionLock } from './locks'

// Sessions on the main thread. The page holds the session locks,
// never the worker, so a worker killed mid-flush takes none with it.

/**
 * A lock with one owner at a time. Whoever creates a lease releases it when it is done with
 * it, in a `finally`; a receiver lets the flusher take it or leaves it alone. Only the flusher
 * calls `take()`, as the first statements of the start that registers a session, so a lock passes
 * to the next holder only where that holder takes it. The raw release exists in this module only.
 */
export type LockLease = {
    readonly name: string
    /** Resolves once granted; rejects if the request fails. */
    readonly granted: Promise<void>
    readonly state: 'held' | 'taken' | 'released'
    /** Moves the lock to the caller and returns the one release function. Throws unless held. */
    take(): () => void
    /** Releases the lock unless it was taken or released already. */
    release(): void
}

/**
 * The only constructor of a lease: `release` is the lock's raw release and goes no further.
 * Production code gets leases from the holders below; tests build theirs here.
 */
export const lockLease = (name: string, granted: Promise<void>, release: () => void): LockLease => {
    let state: LockLease['state'] = 'held'
    const end = () => {
        if (state === 'released') return
        state = 'released'
        release()
    }
    return {
        name,
        granted,
        get state() {
            return state
        },
        take() {
            if (state !== 'held') throw new Error(`The lock ${name} is ${state}, not held`)
            state = 'taken'
            return end
        },
        release() {
            if (state === 'held') end()
        },
    }
}

/** A lease on a lock held nowhere else: where there are no Web Locks, there's no other tab. */
export const noLease = (name: string): LockLease =>
    lockLease(name, Promise.resolve(), () => undefined)

/** Requests a lock and holds it until released, as Web Locks hold a lock while a callback runs. */
export const holdLock = (
    locks: LockService,
    name: string,
    mode: 'exclusive' | 'shared' = 'exclusive',
): LockLease => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    let grant!: () => void
    const granted = new Promise<void>((resolve) => {
        grant = resolve
    })
    // A release before the grant lets the callback end as soon as it runs.
    const request = locks.request(name, { mode }, async () => {
        grant()
        await held
    })
    return lockLease(name, Promise.race([granted, request]), release)
}

/**
 * A lock held only if it is granted under `options` (`ifAvailable`, or a `signal` that ends a
 * blocking request): undefined when it isn't, or when the request fails.
 */
export const tryLease = (
    locks: LockService,
    name: string,
    options: Parameters<LockService['request']>[1],
): Promise<LockLease | undefined> => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    return new Promise<LockLease | undefined>((resolve) => {
        locks
            .request(name, options, async (granted) => {
                if (!granted) {
                    resolve(undefined)
                    return
                }
                resolve(lockLease(name, Promise.resolve(), release))
                await held
            })
            .catch(() => {
                resolve(undefined)
            })
    })
}

/**
 * This tab's session lock, exclusive while it might still write the session: taken
 * when the session starts, released once nothing of it is pending after it is replaced.
 */
export const holdSessionLock = (locks: LockService, sessionId: string) =>
    holdLock(locks, sessionLock(sessionId))

/**
 * An unstored continuation's hold on its parent: the parent's lock in shared mode
 * until the continuation's first write, so the parent counts as open meanwhile.
 */
export const holdParentLock = (locks: LockService, parentId: string) =>
    holdLock(locks, sessionLock(parentId), 'shared')

/**
 * This tab's client id for `query()`: pages can't read their own, so
 * the tab holds a unique `nse-client:<random>` lock and reads the `clientId` it shows under.
 */
export class TabClient {
    readonly lock: LockLease

    constructor(
        private readonly locks: LockService,
        random: string = crypto.randomUUID(),
    ) {
        this.lock = holdLock(locks, clientLock(random))
    }

    /** This tab's client id, once its lock is granted; undefined where query() can't tell. */
    async id(): Promise<string | undefined> {
        await this.lock.granted
        const snapshot = await this.locks.query()
        return snapshot.held.find((lock) => lock.name === this.lock.name)?.clientId
    }

    /**
     * Whether another tab holds a lock: held by a client that isn't this one. Without client ids
     * every holder counts as another tab, the safe side: a fork, never a second writer.
     */
    async heldElsewhere(name: string): Promise<boolean> {
        const own = await this.id()
        const snapshot = await this.locks.query()
        return snapshot.held.some(
            (lock) =>
                lock.name === name &&
                (own === undefined || lock.clientId === undefined || lock.clientId !== own),
        )
    }
}

/** A session's paste identity: per page load and per session opened, as today. */
export { chartSessionId as pasteId } from '../history/chartSession'
