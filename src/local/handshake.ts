import type { LockService } from '../platform/types'
import type { Channel } from './channel'
import { DB_NAME } from './db'
import type { KvDatabase, KvFactory, KvUpgrade } from './kv/types'
import { errorName } from './kv/types'
import { realTimers, type Timers } from './locks'

// The upgrade handshake (Part 1 §1.6.1; r12-arch-web H2), shipped in v1 since only v1 tabs can
// answer a later version's request. A tab opens without a version and reads db.version: equal
// goes on, higher is read-only, lower asks other tabs to step aside with `upgradeWanted` before
// requesting the version. An upgrade blocked by a tab that can't answer (frozen, hung, in the
// back-forward cache) leaves this tab with storage unavailable after about 3 s, never waiting.

export const UPGRADE_WANTED = 'upgradeWanted'

export type UpgradeWanted = { type: typeof UPGRADE_WANTED; version: number }

export const isUpgradeWanted = (message: unknown): message is UpgradeWanted =>
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === UPGRADE_WANTED &&
    typeof (message as { version?: unknown }).version === 'number'

/** How long a blocked upgrade waits before the tab runs with storage unavailable. */
export const BLOCKED_MS = 3000
/** The longest an upgrade waits even without a blocked event. */
export const UPGRADE_MS = 8000

export type HandshakeDeps = {
    factory: KvFactory
    channel: Channel
    /** For the check of other editor tabs before asking them to step aside. */
    locks?: LockService
    /** The version this build wants: DB_VERSION, or a test's simulated later one. */
    version: number
    upgrade: (upgrade: KvUpgrade) => void
    timers?: Timers
    blockedMs?: number
    upgradeMs?: number
}

export type Opened =
    | { kind: 'stored'; db: KvDatabase }
    /** An older build after a rollback: read, save and export, never write (VersionError). */
    | { kind: 'readOnly'; db: KvDatabase }
    /** Another tab holds the database open at an older version; retry asks again. */
    | { kind: 'blocked'; retry: () => Promise<Opened> }
    | { kind: 'failed'; error: unknown }

/** A connection that arrived after giving up, then closed for a newer tab: open afresh. */
const CLOSED_LATE = new Error('Closed for a newer version')

/** Opens `nse-local-data` the versionless way, upgrading through the handshake when it's older. */
export const openWithHandshake = (deps: HandshakeDeps): Promise<Opened> => {
    const timers = deps.timers ?? realTimers
    // The versionless open waits in the connection queue behind another tab's pending upgrade,
    // so it too gives up in time, and Try Again waits for the same request again.
    let late: { db: KvDatabase } | { error: unknown } | undefined
    let gaveUp = false
    const opening = deps.factory.open(DB_NAME, undefined, { upgrade: deps.upgrade }).then(
        (db) => {
            late = { db }
            if (gaveUp)
                db.onversionchange = () => {
                    db.close()
                    late = { error: CLOSED_LATE }
                }
        },
        (error: unknown) => {
            late = { error }
        },
    )
    const attempt = (ms: number) =>
        new Promise<Opened>((resolve) => {
            let timedOut = false
            const timer = timers.setTimeout(() => {
                timedOut = true
                gaveUp = true
                resolve({ kind: 'blocked', retry: () => attempt(deps.blockedMs ?? BLOCKED_MS) })
            }, ms)
            void opening.then(() => {
                if (timedOut) return
                timers.clearTimeout(timer)
                gaveUp = false
                resolve(afterOpen(deps, late))
            })
        })
    return attempt(deps.upgradeMs ?? UPGRADE_MS)
}

const afterOpen = (
    deps: HandshakeDeps,
    opened: { db: KvDatabase } | { error: unknown } | undefined,
): Promise<Opened> | Opened => {
    if (!opened || !('db' in opened))
        return opened?.error === CLOSED_LATE
            ? openWithHandshake(deps)
            : { kind: 'failed', error: opened?.error }
    const { db } = opened
    db.onversionchange = undefined
    if (db.version === deps.version) return { kind: 'stored', db }
    if (db.version > deps.version) return { kind: 'readOnly', db }
    db.close()
    return new UpgradeAttempt(deps).run()
}

/** One request for the newer version, kept across Try Again while it's still queued. */
class UpgradeAttempt {
    private outcome: { db: KvDatabase } | { error: unknown } | undefined
    private gaveUp = false
    private blocked = false
    private wake: (() => void) | undefined
    private readonly timers: Timers

    constructor(private readonly deps: HandshakeDeps) {
        this.timers = deps.timers ?? realTimers
    }

    async run(): Promise<Opened> {
        await this.announce()
        this.deps.factory
            .open(DB_NAME, this.deps.version, {
                upgrade: this.deps.upgrade,
                blocked: () => {
                    this.blocked = true
                    this.wake?.()
                },
            })
            .then(
                (db) => {
                    this.outcome = { db }
                    // Given up: hold it for Try Again, and step aside if a newer tab asks.
                    if (this.gaveUp)
                        db.onversionchange = () => {
                            db.close()
                            this.outcome = { error: CLOSED_LATE }
                        }
                    this.wake?.()
                },
                (error: unknown) => {
                    this.outcome = { error }
                    this.wake?.()
                },
            )
        return this.wait(this.deps.upgradeMs ?? UPGRADE_MS, true)
    }

    /** Asks other editor tabs to close their connections first. */
    private async announce() {
        try {
            // Informational: a tab whose locks this context can't see is asked all the same.
            await this.deps.locks?.query()
        } catch {
            // No Web Locks here.
        }
        this.deps.channel.post({ type: UPGRADE_WANTED, version: this.deps.version })
    }

    /** Waits for the request: blockedMs once blocked, at most totalMs, then gives up. */
    private wait(totalMs: number, untilBlocked: boolean): Promise<Opened> {
        return new Promise<Opened>((resolve) => {
            let blockedTimer: unknown
            const finish = () => {
                this.timers.clearTimeout(timer)
                this.timers.clearTimeout(blockedTimer)
                this.wake = undefined
            }
            const check = () => {
                if (this.outcome) {
                    finish()
                    resolve(this.settle())
                    return
                }
                if (this.blocked && untilBlocked && blockedTimer === undefined)
                    blockedTimer = this.timers.setTimeout(giveUp, this.deps.blockedMs ?? BLOCKED_MS)
            }
            const giveUp = () => {
                finish()
                this.gaveUp = true
                resolve({ kind: 'blocked', retry: () => this.retry() })
            }
            const timer = this.timers.setTimeout(giveUp, totalMs)
            this.wake = check
            check()
        })
    }

    private async settle(): Promise<Opened> {
        const outcome = this.outcome
        if (outcome && 'db' in outcome) return { kind: 'stored', db: outcome.db }
        const error = outcome?.error
        // A newer tab upgraded past this build meanwhile: read-only, as at load.
        if (errorName(error) === 'VersionError') return openWithHandshake(this.deps)
        return { kind: 'failed', error }
    }

    /** Try Again: takes a connection that arrived late, or asks again and waits about 3 s. */
    private async retry(): Promise<Opened> {
        if (this.outcome) {
            if ('db' in this.outcome) {
                this.outcome.db.onversionchange = undefined
                return { kind: 'stored', db: this.outcome.db }
            }
            return openWithHandshake(this.deps)
        }
        this.gaveUp = false
        await this.announce()
        return this.wait(this.deps.blockedMs ?? BLOCKED_MS, false)
    }
}

/**
 * Every tab, from v1, answers `upgradeWanted` as it answers onversionchange: the transaction in
 * flight finishes, the connection closes, and storing pauses until a reload.
 */
export const answerUpgrades = (
    db: KvDatabase,
    stepAside: () => void,
): { onMessage: (message: unknown) => void } => {
    let done = false
    const answer = () => {
        if (done) return
        done = true
        // close() waits for the transaction in flight.
        db.close()
        stepAside()
    }
    db.onversionchange = answer
    return {
        onMessage: (message) => {
            if (isUpgradeWanted(message) && message.version > db.version) answer()
        },
    }
}
