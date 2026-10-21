import type { LockService } from '../../platform/types'
import type { Channel } from '../channel'
import { MemoryKv } from '../kv/memory'
import { asError, type KvFactory } from '../kv/types'
import { Scheduler, type Actor, type Waiter } from '../scheduler'
import { FakeChannels } from './channels'
import { FakeClock } from './clock'
import { HoleLedger } from './holes'
import { FakeLockManager } from './locks'
import { transitionViolations, type CreationContext, type TransitionChecks } from './transitions'

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
    /** Waits until nothing is queued, then fails on any error a task threw or rule a commit broke. */
    idle: () => Promise<void>
    /**
     * The rules the profile's commits broke, in order (`transitionViolations`): a transaction that
     * created a session's rows without the page holding its lock, rows at or below `lastSeq`, a
     * frozen session's rows changed, a binding recorded during an import. Empty when none did.
     */
    readonly violations: string[]
    /** The `seq`s the flushers made holes of: watched flushers report them (`HoleLedger.watch`). */
    readonly holes: HoleLedger
    /** Which rules are checked; a test that writes rows directly turns the ones it breaks off. */
    readonly checks: TransitionChecks
}

export type WorldOptions = {
    seed?: number
    /**
     * The checks to start with: the transition rules on, the lock-holder assertion off. A test
     * that holds its sessions' locks as a page does (`createCheckedWorld`, the model test) turns
     * the lock on; a fixture that seeds rows itself passes `false`.
     */
    checks?: TransitionChecks | false
    /** Keep what a power loss would undo: `memory.loseRelaxed` and `memory.loseCommits`. */
    commitLog?: boolean
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

export const createWorld = ({ seed, checks: given, commitLog }: WorldOptions = {}): World => {
    readBlobsInTasks()
    const scheduler = new Scheduler({ seed })
    const memory = new MemoryKv(scheduler)
    if (commitLog) memory.recordCommits = true
    const locks = new FakeLockManager(scheduler)
    const channels = new FakeChannels(scheduler)
    const clock = new FakeClock(scheduler)
    const checks: TransitionChecks =
        given === false
            ? { lock: false, transitions: false }
            : { lock: false, transitions: true, ...given }
    const violations: string[] = []
    /** A worker's page: the actor that holds the locks its transactions are judged by. */
    const pages = new Map<Actor, Actor>()
    const pageOf = (actor: Actor) => pages.get(actor) ?? actor
    memory.observe({
        created: ({ actor }): CreationContext => {
            const page = pageOf(actor)
            const prefix = 'nse-session:'
            return {
                sessions: new Set(
                    locks
                        .holders()
                        .filter(
                            (held) =>
                                held.mode === 'exclusive' &&
                                held.name.startsWith(prefix) &&
                                pageOf(held.actor) === page,
                        )
                        .map((held) => held.name.slice(prefix.length)),
                ),
            }
        },
        committed: (report) => {
            violations.push(...transitionViolations(report, checks))
        },
    })
    const tab = (name: string, { owner }: { owner?: Tab } = {}): Tab => {
        const actor = scheduler.actor(name)
        if (owner) {
            pages.set(actor, pageOf(owner.actor))
            scheduler.onKill(owner.actor, () => {
                scheduler.kill(actor)
            })
        }
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
        violations,
        checks,
        holes: new HoleLedger(),
        idle: async () => {
            await scheduler.idle()
            if (scheduler.errors.length) throw scheduler.errors[0] as Error
            if (violations.length)
                throw new Error(
                    `A commit broke a rule of the stored data: ${String(violations[0])}`,
                )
        },
    }
}

/** The seeds CI runs each two-tab scenario under. */
export const CI_SEEDS = [1, 2, 3, 5, 8, 13, 21, 34]
