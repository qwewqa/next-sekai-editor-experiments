import { watch } from 'vue'
import { settleHeldBgm } from '../../editor/media/heldBgm'
import { session } from '../../history/session'
import type { LockService } from '../../platform/types'
import { storageKey } from '../../storage'
import { clientLock } from '../locks'

// The startup guard. While a page opens a stored session it keeps a record of that session in
// localStorage, tied to the page's `nse-client:<id>` lock. A record whose lock is free belongs
// to a page that died, froze and was closed, or was reloaded mid-open: the next automatic open
// of the session it names asks first. An id leaves a record only when an opening of that session
// has put it on screen and then settled. Nothing here may stop startup: every storage and lock
// failure means no guard for that load.

const PART = 'opening.'

/** What the guard needs of localStorage. */
export type GuardStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>

export type GuardEnv = {
    storage: () => GuardStorage | undefined
    locks: Pick<LockService, 'query'>
    /** The page's `nse-client:<id>` lock name and when it is granted. */
    clientLock: string
    granted: Promise<void>
    /** Resolves once what an opening started has drawn and been given a chance to fail. */
    settle: () => Promise<void>
    /** The localStorage prefix of the app's keys. */
    prefix?: string
}

/** One opening of a stored session. */
export type Opening = {
    /** Records a session being opened; resolves once the record is written. */
    add: (sessionId: string) => Promise<void>
    /** The opening put its session on screen. */
    published: () => void
    /** The opening is over; `threw` keeps its ids in the record for the page's life. */
    end: (threw?: boolean) => void
}

const none: Opening = {
    add: () => Promise.resolve(),
    published: () => undefined,
    end: () => undefined,
}

const attempt = <T>(run: () => T): T | undefined => {
    try {
        return run()
    } catch {
        // Storage that fails means no guard for this load.
        return undefined
    }
}

const idsOf = (text: string | null) => {
    if (text === null) return []
    const value = attempt(() => JSON.parse(text) as unknown)
    const list = (value as { ids?: unknown } | null | undefined)?.ids
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []
}

export class OpeningGuard {
    private pending = 0
    private generation = 0
    private readonly ids = new Set<string>()
    private readonly published = new Set<string>()
    private readonly failed = new Set<string>()
    private flush: Promise<void> | undefined
    private readonly key: string

    constructor(
        private readonly env: GuardEnv,
        /** The keys of the dead records found at this page's start. */
        private readonly deadKeys: readonly string[] = [],
    ) {
        this.key = `${env.prefix ?? storageKey('')}${PART}${env.clientLock.slice(clientLock('').length)}`
    }

    begin(): Opening {
        this.pending++
        this.generation++
        const own = new Set<string>()
        let didPublish = false
        let ended = false
        return {
            add: (sessionId) => {
                own.add(sessionId)
                this.ids.add(sessionId)
                return this.write()
            },
            published: () => {
                didPublish = true
            },
            end: (threw = false) => {
                if (ended) return
                ended = true
                this.pending--
                if (threw) for (const id of own) this.failed.add(id)
                else if (didPublish) for (const id of own) this.published.add(id)
                this.maybeSettle()
            },
        }
    }

    /** Writes the page's record once its lock is granted; never rejects. */
    private write(): Promise<void> {
        this.flush ??= this.env.granted.then(
            () => {
                this.flush = undefined
                this.store()
            },
            () => {
                this.flush = undefined
            },
        )
        return this.flush
    }

    private store() {
        attempt(() => {
            const storage = this.env.storage()
            if (!storage) return
            if (this.ids.size) storage.setItem(this.key, JSON.stringify({ ids: [...this.ids] }))
            else storage.removeItem(this.key)
        })
    }

    private maybeSettle() {
        if (this.pending > 0 || !this.published.size) return
        const generation = this.generation
        void this.env.settle().then(
            () => {
                if (generation === this.generation && this.pending === 0) this.retire()
            },
            () => undefined,
        )
    }

    /** Takes the settled ids out of the page's record and the dead records, one by one. */
    private retire() {
        const retired = [...this.published].filter((id) => !this.failed.has(id))
        this.published.clear()
        if (!retired.length) return
        for (const id of retired) this.ids.delete(id)
        this.store()
        attempt(() => {
            const storage = this.env.storage()
            if (!storage) return
            for (const key of this.deadKeys) {
                const left = idsOf(storage.getItem(key)).filter((id) => !retired.includes(id))
                if (left.length) storage.setItem(key, JSON.stringify({ ids: left }))
                else storage.removeItem(key)
            }
        })
    }
}

/** The ids of the records whose pages died, and their keys. */
export type Unfinished = { ids: Set<string>; keys: string[] }

/**
 * Finds the dead records: keys with no lock held under their page's name. With no keys there is
 * no lock query. A record that is gone when read again is not dead.
 */
export const findUnfinished = async (
    env: Pick<GuardEnv, 'storage' | 'locks' | 'prefix'>,
): Promise<Unfinished> => {
    const found: Unfinished = { ids: new Set(), keys: [] }
    try {
        const storage = env.storage()
        if (!storage) return found
        const start = `${env.prefix ?? storageKey('')}${PART}`
        const keys: string[] = []
        for (let at = 0; at < storage.length; at++) {
            const key = storage.key(at)
            if (key?.startsWith(start)) keys.push(key)
        }
        if (!keys.length) return found
        const held = new Set((await env.locks.query()).held.map((lock) => lock.name))
        for (const key of keys) {
            if (held.has(clientLock(key.slice(start.length)))) continue
            const ids = idsOf(storage.getItem(key))
            if (!ids.length) {
                // A record with nothing in it, or none that can be read, asks nothing.
                if (storage.getItem(key) !== null) storage.removeItem(key)
                continue
            }
            found.keys.push(key)
            for (const id of ids) found.ids.add(id)
        }
    } catch {
        // No guard for this load.
        return { ids: new Set(), keys: [] }
    }
    return found
}

let active: OpeningGuard | undefined

/** Begins an opening; where there is no guard it records nothing. */
export const beginOpening = (): Opening => active?.begin() ?? none

/** Runs `run` as one opening, ended exactly once. */
export const withOpening = async <T>(run: (opening: Opening) => Promise<T>): Promise<T> => {
    const opening = beginOpening()
    try {
        const result = await run(opening)
        opening.end(false)
        return result
    } catch (error) {
        opening.end(true)
        throw error
    }
}

/** Resolves on the next frame, or when the page is hidden: a hidden page draws nothing. */
const frame = () =>
    new Promise<void>((resolve) => {
        if (document.visibilityState === 'hidden') {
            resolve()
            return
        }
        const done = () => {
            document.removeEventListener('visibilitychange', onChange)
            resolve()
        }
        const onChange = () => {
            if (document.visibilityState === 'hidden') done()
        }
        document.addEventListener('visibilitychange', onChange)
        requestAnimationFrame(done)
    })

/** The idle callback's timeout after the first frame. */
const IDLE_WAIT_MS = 2000

const idle = () =>
    new Promise<void>((resolve) => {
        if (typeof requestIdleCallback === 'function')
            requestIdleCallback(
                () => {
                    resolve()
                },
                { timeout: IDLE_WAIT_MS },
            )
        else setTimeout(resolve, 0)
    })

const settlePage = async () => {
    await settleHeldBgm()
    await frame()
    await idle()
}

/**
 * Starts the guard for this page: finds the dead records and records every opening from now on,
 * including each switch of the open session. Resolves to the ids of the sessions whose last
 * opening did not finish. Never rejects.
 */
export const watchOpenings = async (env: {
    storage: () => GuardStorage | undefined
    locks: Pick<LockService, 'query'>
    clientLock: string
    granted: Promise<void>
}): Promise<ReadonlySet<string>> => {
    try {
        const found = await findUnfinished(env)
        const guard = new OpeningGuard({ ...env, settle: settlePage }, found.keys)
        active = guard
        // Every switch is a publication: level imports, New, Local Data's Open and the openings.
        watch(
            () => session.value.sessionId,
            (id) => {
                const opening = guard.begin()
                void opening.add(id)
                opening.published()
                opening.end(false)
            },
            { flush: 'sync' },
        )
        return found.ids
    } catch {
        return new Set()
    }
}
