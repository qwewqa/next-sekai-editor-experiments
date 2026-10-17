import type { LockService } from '../../platform/types'
import type { Channel } from '../channel'
import { MemoryKv } from '../kv/memory'
import { asError, type KvFactory } from '../kv/types'
import { Scheduler, type Actor, type Waiter } from '../scheduler'
import { FakeChannels } from './channels'
import { FakeClock } from './clock'
import { FakeLockManager } from './locks'

// The test core's world (§1.6.1, §1.11's test notes): one browser profile with tabs. Each tab has
// its own connections, lock client and channels, and every delivery to it is a task of its actor
// on the seeded scheduler, so killing a tab drops its pending work, aborts its open transactions
// and releases its locks. A tab's storage worker is an actor of its own, which dies with the page
// but can also die alone, and timers run on the world's clock.

export type Tab = {
    readonly name: string
    readonly actor: Actor
    readonly kv: KvFactory
    readonly locks: LockService
    readonly waiter: Waiter
    channel: (name: string) => Channel
    /** Runs fn as a task of this tab; never settles if the tab is killed first. */
    run: <T>(fn: () => Promise<T> | T) => Promise<T>
    kill: () => void
    readonly alive: boolean
}

export type World = {
    readonly seed: number | undefined
    readonly scheduler: Scheduler
    readonly memory: MemoryKv
    readonly locks: FakeLockManager
    readonly channels: FakeChannels
    readonly clock: FakeClock
    /** A tab, or with `owner` a worker of that tab's page: killed with it, or alone. */
    tab: (name: string, options?: { owner?: Tab }) => Tab
    /** Waits until nothing is queued, then fails on any error a task threw. */
    idle: () => Promise<void>
}

let blobsPatched = false

/** Node reads a Blob within microtasks; browsers take a task, which a transaction can't span. */
const readBlobsInTasks = () => {
    if (blobsPatched) return
    blobsPatched = true
    const later = <T>(value: T) =>
        new Promise<T>((resolve) => {
            setTimeout(() => {
                resolve(value)
            }, 0)
        })
    const prototype = Blob.prototype as {
        arrayBuffer: (this: Blob) => Promise<ArrayBuffer>
        text: (this: Blob) => Promise<string>
    }
    const { arrayBuffer, text } = prototype
    prototype.arrayBuffer = async function () {
        return later(await arrayBuffer.call(this))
    }
    prototype.text = async function () {
        return later(await text.call(this))
    }
}

export const createWorld = ({ seed }: { seed?: number } = {}): World => {
    readBlobsInTasks()
    const scheduler = new Scheduler({ seed })
    const memory = new MemoryKv(scheduler)
    const locks = new FakeLockManager(scheduler)
    const channels = new FakeChannels(scheduler)
    const clock = new FakeClock(scheduler)
    const tab = (name: string, { owner }: { owner?: Tab } = {}): Tab => {
        const actor = scheduler.actor(name)
        if (owner)
            scheduler.onKill(owner.actor, () => {
                scheduler.kill(actor)
            })
        const kv = memory.factory(actor)
        return {
            name,
            actor,
            kv,
            locks: locks.client(actor),
            waiter: scheduler.waiter(actor),
            channel: (channelName) => channels.channel(actor, channelName),
            run: <T>(fn: () => Promise<T> | T) =>
                new Promise<T>((resolve, reject) => {
                    scheduler.post(actor, scheduler.lane(), () => {
                        try {
                            Promise.resolve(fn()).then(resolve, reject)
                        } catch (error) {
                            reject(asError(error))
                        }
                    })
                }),
            kill: () => {
                scheduler.kill(actor)
            },
            get alive() {
                return actor.alive
            },
        }
    }
    return {
        seed,
        scheduler,
        memory,
        locks,
        channels,
        clock,
        tab,
        idle: async () => {
            await scheduler.idle()
            if (scheduler.errors.length) throw scheduler.errors[0] as Error
        },
    }
}

/** The seeds CI runs each two-tab scenario under. */
export const CI_SEEDS = [1, 2, 3, 5, 8, 13, 21, 34]
