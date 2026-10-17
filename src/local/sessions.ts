import type { LockService } from '../platform/types'
import { clientLock, sessionLock } from './locks'

// Sessions on the main thread (Part 1 §1.3.6, §1.6.5, §1.6.6). The page holds the session locks,
// never the worker, so a worker killed mid-flush takes none with it (r12-arch-web H3). Until
// Step 4 every load starts a new session and a new chain; a continuation's parent lock and the
// reload's blocking request come with Step 4's startup.

/** A lock held until released: the promise settles once it is granted. */
export type HeldLock = {
    readonly name: string
    /** Resolves once granted; rejects if the request fails. */
    readonly granted: Promise<void>
    release: () => void
}

/** Requests a lock and holds it until `release`, as Web Locks hold a lock while a callback runs. */
export const holdLock = (
    locks: LockService,
    name: string,
    mode: 'exclusive' | 'shared' = 'exclusive',
): HeldLock => {
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
    return { name, granted: Promise.race([granted, request]), release }
}

/**
 * This tab's session lock, exclusive while it might still write the session (§1.6.6): taken
 * when the session starts, released once nothing of it is pending after it is replaced.
 */
export const holdSessionLock = (locks: LockService, sessionId: string) =>
    holdLock(locks, sessionLock(sessionId))

/**
 * An unstored continuation's hold on its parent (§1.3.6): the parent's lock in shared mode
 * until the continuation's first write, so the parent counts as open meanwhile.
 */
export const holdParentLock = (locks: LockService, parentId: string) =>
    holdLock(locks, sessionLock(parentId), 'shared')

/**
 * This tab's client id for `query()` (§1.6.5; r12-arch-web L2): pages can't read their own, so
 * the tab holds a unique `nse-client:<random>` lock and reads the `clientId` it shows under.
 */
export class TabClient {
    readonly lock: HeldLock

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

    /** Whether another tab holds a lock: held by a client that isn't this one. */
    async heldElsewhere(name: string): Promise<boolean> {
        const own = await this.id()
        const snapshot = await this.locks.query()
        return snapshot.held.some((lock) => lock.name === name && lock.clientId !== own)
    }
}

/** A session's paste identity (§1.3.6): per page load and per session opened, as today. */
export { chartSessionId as pasteId } from '../history/chartSession'
