import type { LockInfo, LockMode, LockService, LockSnapshot } from '../../platform/types'
import { asError } from '../kv/types'
import { Scheduler, type Actor } from '../scheduler'

// FakeLockManager (§1.6.1): Web Locks in FIFO order with shared and exclusive modes and
// ifAvailable, pending requests in query(), and a killed actor's locks released. Grants and
// callbacks are tasks of the requesting actor. No Node API, so the platform mock can use it.

type LockRequest = {
    name: string
    mode: LockMode
    clientId: string
    actor: Actor
    run: (held: boolean) => void
    abort: () => void
}

const abortError = () => new DOMException('The lock request was aborted', 'AbortError')

export class FakeLockManager {
    readonly scheduler: Scheduler
    private readonly held = new Map<string, LockRequest[]>()
    private readonly queues = new Map<string, LockRequest[]>()
    private readonly watched = new Set<Actor>()

    constructor(scheduler?: Scheduler) {
        this.scheduler = scheduler ?? new Scheduler()
    }

    /** The lock service one actor (a tab's main thread or worker) sees. */
    client(actor: Actor, clientId: string = actor.name): LockService {
        if (!this.watched.has(actor)) {
            this.watched.add(actor)
            this.scheduler.onKill(actor, () => {
                this.release(actor)
            })
        }
        return {
            request: (name, options, callback) =>
                this.request(actor, clientId, name, options, callback),
            query: () =>
                new Promise<LockSnapshot>((resolve) => {
                    this.scheduler.post(actor, this.scheduler.lane(), () => {
                        resolve(this.snapshot())
                    })
                }),
        }
    }

    /** What query() reports now. */
    snapshot(): LockSnapshot {
        const info = ({ name, mode, clientId }: LockRequest): LockInfo => ({ name, mode, clientId })
        return {
            held: [...this.held.values()].flat().map(info),
            pending: [...this.queues.values()].flat().map(info),
        }
    }

    private request<T>(
        actor: Actor,
        clientId: string,
        name: string,
        options: { mode?: LockMode; ifAvailable?: boolean; signal?: AbortSignal },
        callback: (held: boolean) => Promise<T>,
    ): Promise<T> {
        const mode = options.mode ?? 'exclusive'
        const { signal } = options
        return new Promise<T>((resolve, reject) => {
            if (signal?.aborted) {
                reject(abortError())
                return
            }
            const lane = this.scheduler.lane()
            const request: LockRequest = {
                name,
                mode,
                clientId,
                actor,
                run: (granted) => {
                    this.scheduler.post(actor, lane, () => {
                        let result: Promise<T>
                        try {
                            result = callback(granted)
                        } catch (error) {
                            result = Promise.reject(asError(error))
                        }
                        void result
                            .finally(() => {
                                if (granted) this.unlock(request)
                            })
                            .then(resolve, reject)
                    })
                },
                abort: () => {
                    this.scheduler.post(actor, lane, () => {
                        reject(abortError())
                    })
                },
            }
            if (options.ifAvailable) {
                if (this.grantableAtEnd(name, mode)) this.grant(request)
                else request.run(false)
                return
            }
            let queue = this.queues.get(name)
            if (!queue) this.queues.set(name, (queue = []))
            queue.push(request)
            signal?.addEventListener('abort', () => {
                const pending = this.queues.get(name) ?? []
                const at = pending.indexOf(request)
                if (at < 0) return
                pending.splice(at, 1)
                if (!pending.length) this.queues.delete(name)
                request.abort()
                this.process(name)
            })
            this.process(name)
        })
    }

    private heldBy(name: string) {
        return this.held.get(name) ?? []
    }

    /** Whether a request added at the end of the queue could be granted now. */
    private grantableAtEnd(name: string, mode: LockMode) {
        const held = this.heldBy(name)
        const queue = this.queues.get(name) ?? []
        if (mode === 'exclusive') return !held.length && !queue.length
        return (
            held.every((lock) => lock.mode === 'shared') && queue.every((r) => r.mode === 'shared')
        )
    }

    private grant(request: LockRequest) {
        let held = this.held.get(request.name)
        if (!held) this.held.set(request.name, (held = []))
        held.push(request)
        request.run(true)
    }

    private unlock(request: LockRequest) {
        const held = this.held.get(request.name) ?? []
        const at = held.indexOf(request)
        if (at < 0) return
        held.splice(at, 1)
        if (!held.length) this.held.delete(request.name)
        this.process(request.name)
    }

    /** Grants from the front of the queue: one exclusive, or a run of shared. */
    private process(name: string) {
        const queue = this.queues.get(name)
        for (let head = queue?.[0]; queue && head; head = queue[0]) {
            const held = this.heldBy(name)
            const grantable =
                head.mode === 'exclusive'
                    ? !held.length
                    : held.every((lock) => lock.mode === 'shared')
            if (!grantable) break
            queue.shift()
            this.grant(head)
        }
        if (queue && !queue.length) this.queues.delete(name)
    }

    private release(actor: Actor) {
        const names = new Set<string>()
        for (const [name, queue] of this.queues) {
            const kept = queue.filter((request) => request.actor !== actor)
            if (kept.length !== queue.length) names.add(name)
            if (kept.length) this.queues.set(name, kept)
            else this.queues.delete(name)
        }
        for (const [name, held] of this.held) {
            const kept = held.filter((request) => request.actor !== actor)
            if (kept.length !== held.length) names.add(name)
            if (kept.length) this.held.set(name, kept)
            else this.held.delete(name)
        }
        for (const name of names) this.process(name)
    }
}
