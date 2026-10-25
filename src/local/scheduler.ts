// The task scheduler the in-memory store, the fake locks and the test core deliver through.
// Each delivery is a task of an actor (a tab or its worker) on a lane (a transaction, a lock
// request): FIFO within a lane; across lanes FIFO, or a seeded choice in tests. A task's promise
// continuations run before the task ends, as in a browser's event loop, and only then do the
// end-of-task hooks run, which is when the in-memory store lets a transaction go inactive.

export type Actor = {
    readonly name: string
    alive: boolean
    /** Tasks run so far: each is the continuation of one await. */
    steps: number
}

type Task = { actor: Actor; lane: unknown; fn: () => void; seq: number }

/** An await point for promises from outside the store (crypto.subtle, Blob reads). */
export type Waiter = { wait: <T>(promise: PromiseLike<T> | T) => Promise<T> }

/** Production code outside the in-memory store awaits directly. */
export const directWaiter: Waiter = { wait: (promise) => Promise.resolve(promise) }

type Immediate = (fn: () => void) => void

// Two callbacks queued together run back to back with only microtasks between them (Node's
// setImmediate), so no timer or I/O callback can run while a task's continuations are pending.
const makeImmediate = (): Immediate => {
    const nodeImmediate = (globalThis as { setImmediate?: (fn: () => void) => unknown })
        .setImmediate
    if (nodeImmediate) return (fn) => void nodeImmediate(fn)
    const queue: (() => void)[] = []
    const channel = new MessageChannel()
    channel.port1.onmessage = () => queue.shift()?.()
    return (fn) => {
        queue.push(fn)
        channel.port2.postMessage(0)
    }
}

/** A small seeded generator (mulberry32). */
export const seededRandom = (seed: number) => {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

export class Scheduler {
    readonly main: Actor
    /** Errors thrown by task functions: always a bug in the store or the harness. */
    readonly errors: unknown[] = []
    private readonly lanes = new Map<unknown, Task[]>()
    private readonly random: (() => number) | undefined
    private readonly immediate = makeImmediate()
    private readonly taskEndHooks = new Set<() => void>()
    private readonly killHooks = new Map<Actor, Set<() => void>>()
    private readonly killPoints = new Map<Actor, { step: number; then?: () => void }>()
    private readonly externals = new Set<Promise<unknown>>()
    private idleWaiters: (() => void)[] = []
    private running = false
    private current: Actor | undefined
    private seq = 0
    private uniqueLane = 0

    constructor(options: { seed?: number } = {}) {
        this.random = options.seed === undefined ? undefined : seededRandom(options.seed)
        this.main = this.actor('main')
    }

    /** Whether tasks are chosen by a seed (tests) rather than in order. */
    get seeded() {
        return this.random !== undefined
    }

    /** Whether a task, or its promise continuations, is running now. */
    get inTask() {
        return this.current !== undefined
    }

    actor(name: string): Actor {
        return { name, alive: true, steps: 0 }
    }

    /** A fresh lane, for a delivery ordered against nothing else. */
    lane(): unknown {
        return { lane: this.uniqueLane++ }
    }

    post(actor: Actor, lane: unknown, fn: () => void) {
        if (!actor.alive) return
        let queue = this.lanes.get(lane)
        if (!queue) this.lanes.set(lane, (queue = []))
        queue.push({ actor, lane, fn, seq: this.seq++ })
        this.kick()
    }

    /** Awaits a promise from outside, delivering its result as a task of the actor. */
    wait<T>(actor: Actor, promise: PromiseLike<T> | T): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const lane = this.lane()
            const settled = Promise.resolve(promise).then(
                (value) => {
                    this.post(actor, lane, () => {
                        resolve(value)
                    })
                },
                (error: unknown) => {
                    this.post(actor, lane, () => {
                        reject(error instanceof Error ? error : new Error(String(error)))
                    })
                },
            )
            this.externals.add(settled)
            void settled.finally(() => {
                this.externals.delete(settled)
                this.kick()
            })
        })
    }

    /** A Waiter whose awaits are the actor's tasks. */
    waiter(actor: Actor): Waiter {
        return { wait: (promise) => this.wait(actor, promise) }
    }

    /** Runs after each task, once its promise continuations have run. */
    onTaskEnd(hook: () => void) {
        this.taskEndHooks.add(hook)
        return () => this.taskEndHooks.delete(hook)
    }

    onKill(actor: Actor, hook: () => void) {
        let hooks = this.killHooks.get(actor)
        if (!hooks) this.killHooks.set(actor, (hooks = new Set()))
        hooks.add(hook)
        return () => hooks.delete(hook)
    }

    /** Kills the actor: its queued tasks go, and its kill hooks run (aborts, lock releases). */
    kill(actor: Actor) {
        if (!actor.alive) return
        actor.alive = false
        for (const [lane, queue] of this.lanes) {
            const kept = queue.filter((task) => task.actor !== actor)
            if (kept.length) this.lanes.set(lane, kept)
            else this.lanes.delete(lane)
        }
        for (const hook of this.killHooks.get(actor) ?? []) hook()
        this.killHooks.delete(actor)
    }

    /** Kills the actor in place of running its task number `step` (0 is its first). */
    killAt(actor: Actor, step: number, then?: () => void) {
        this.killPoints.set(actor, { step, then })
    }

    /** Resolves once no task is queued and no outside promise is pending. */
    async idle(): Promise<void> {
        // A turn first, so continuations of promises resolved from outside can post their tasks.
        await new Promise<void>((resolve) => {
            this.immediate(resolve)
        })
        if (!this.running && !this.lanes.size && !this.externals.size) return
        await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
    }

    private kick() {
        if (this.running) return
        this.running = true
        this.next()
    }

    private next() {
        const task = this.pick()
        if (!task) {
            this.running = false
            if (!this.externals.size) {
                const waiters = this.idleWaiters
                this.idleWaiters = []
                for (const resolve of waiters) resolve()
            }
            return
        }
        const point = this.killPoints.get(task.actor)
        if (point?.step === task.actor.steps) {
            this.killPoints.delete(task.actor)
            this.kill(task.actor)
            point.then?.()
            this.immediate(() => {
                this.endTask()
            })
            return
        }
        task.actor.steps++
        this.immediate(() => {
            this.current = task.actor
            try {
                task.fn()
            } catch (error) {
                this.errors.push(error)
            }
        })
        this.immediate(() => {
            this.endTask()
        })
    }

    private endTask() {
        this.current = undefined
        for (const hook of [...this.taskEndHooks]) {
            try {
                hook()
            } catch (error) {
                this.errors.push(error)
            }
        }
        // Outside promises settle before the next choice, so a seed replays the same order.
        if (this.externals.size && this.random) {
            void Promise.allSettled([...this.externals]).then(() => {
                this.immediate(() => {
                    this.next()
                })
            })
            return
        }
        this.next()
    }

    private pick(): Task | undefined {
        if (!this.lanes.size) return
        let chosen: Task[] | undefined
        if (this.random) {
            const heads = [...this.lanes.values()]
            chosen = heads[Math.floor(this.random() * heads.length)]
        } else {
            for (const queue of this.lanes.values())
                if (!chosen || (queue[0]?.seq ?? Infinity) < (chosen[0]?.seq ?? Infinity))
                    chosen = queue
        }
        const task = chosen?.shift()
        if (task && !chosen?.length) this.lanes.delete(task.lane)
        return task
    }
}
