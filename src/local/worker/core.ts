import type { LockService } from '../../platform/types'
import type { Channel } from '../channel'
import { countDayOfUse } from '../days'
import { DB_NAME, DB_VERSION, readMeta, STORE_NAMES, upgradeDatabase, writeMeta } from '../db'
import { answerUpgrades, openWithHandshake, type Opened } from '../handshake'
import {
    domError,
    errorName,
    type Durability,
    type KvDatabase,
    type KvFactory,
    type KvTx,
} from '../kv/types'
import { MAINT_WAIT_MS, realTimers, withMaintShared, type Timers } from '../locks'
import { nextTime } from '../time'

// The storage worker's state (Part 1 §1.6.1, §1.6.5, §1.6.7): which store it writes to, whether
// storing is paused and why, the connection-loss retry, and writes under `nse-maint`. No browser
// global is touched here, so Node tests run it over the in-memory store and fake locks.

/** stored: IndexedDB; readOnly: a newer database (VersionError); memory: storage unavailable. */
export type StorageMode = 'stored' | 'readOnly' | 'memory'

/** §1.4.19's `storage.reason.*`: full, upgrading, olderTabs, failed. */
export type PauseReason = 'full' | 'upgrading' | 'olderTabs' | 'failed'

export type StorageStatus = {
    mode: StorageMode
    /** Stored: why storing is paused. Memory: olderTabs when an upgrade is blocked. */
    reason?: PauseReason
    /**
     * Media whose read-back failed, as hex, until a later read-back succeeds (§1.6.8.4). Storing
     * isn't paused for them: the history goes on being stored. Absent when there are none.
     */
    mediaPending?: string[]
}

/** The worker's startup test flag (§1.11's test notes): addInitScript can't reach a worker. */
export type TestFlags = {
    noStorage?: boolean
    forceQuota?: boolean
    forceUnknownError?: boolean
    /** Step 8's GC reads it. */
    slowGc?: boolean
    /** A simulated later build: requests this version, with an empty upgrade. */
    dbVersion?: number
    /** A frozen tab: never answers onversionchange or upgradeWanted. */
    ignoreVersionChange?: boolean
    /** Kills the worker at the test point of this name. */
    crashAt?: string
}

export type CoreDeps = {
    /** IndexedDB; undefined where there is none (an insecure origin, a blocked private mode). */
    factory: KvFactory | undefined
    /** The in-memory store a tab runs on when storage is unavailable. */
    memory: () => KvFactory
    channel: Channel
    locks: LockService
    appVersion: string
    deviceId?: string
    randomId: () => string
    /** navigator.storage.estimate(), to tell a full disk reported as UnknownError. */
    estimate?: () => Promise<{ usage?: number; quota?: number }>
    flags?: TestFlags
    timers?: Timers
    blockedMs?: number
    upgradeMs?: number
    maintWaitMs?: number
    /** Ends the worker as a crash would, for test points. */
    crash?: (point: string) => void
}

/** Writes are refused: read-only, or paused until a reload. */
export class StorageRefusedError extends Error {
    constructor(readonly reason: 'readOnly' | PauseReason) {
        super(`Storing is ${reason === 'readOnly' ? 'read-only' : `paused: ${reason}`}`)
        this.name = 'StorageRefusedError'
    }
}

/** A write that failed and paused storing; nothing of it was committed. */
export class StoragePausedError extends Error {
    constructor(
        readonly reason: PauseReason,
        readonly cause: unknown,
    ) {
        super(`Storing paused: ${reason} [${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}]`)
        this.name = 'StoragePausedError'
    }
}

/** Little free space by estimate(): Chrome reports a full disk as UnknownError (§1.6.1). */
export const isLowSpace = ({ usage, quota }: { usage?: number; quota?: number }) =>
    usage !== undefined &&
    quota !== undefined &&
    quota > 0 &&
    (quota - usage < 32 * 1024 * 1024 || (quota - usage) / quota < 0.05)

const isConnectionError = (error: unknown) =>
    ['InvalidStateError', 'UnknownError'].includes(errorName(error) ?? '')

/** A call's progress count (§1.6.5): bumped by each step of work done for it. */
export type Progress = { tick?: () => void }

export type WriteOptions = { durability?: Durability } & Progress

export class StorageCore {
    private db: KvDatabase | undefined
    private current: StorageStatus = { mode: 'memory' }
    private lost = false
    private retryBlocked: (() => Promise<Opened>) | undefined
    private upgradeAnswer: { onMessage: (message: unknown) => void } | undefined
    private trying: Promise<StorageStatus> | undefined
    /** Set while Try Again moves the in-memory rows: writes wait, so none lands behind it. */
    private moving: Promise<void> | undefined
    private readonly memoryWrites = new Set<Promise<unknown>>()
    /** Media whose read-back failed, until one succeeds: reported beside the status. */
    private readonly mediaPending = new Set<string>()
    /** The progress of calls waiting on Try Again's move: the move's steps count as theirs. */
    private readonly behindMove = new Set<() => void>()
    private readonly listeners = new Set<(status: StorageStatus) => void>()
    private readonly timers: Timers
    private readonly flags: TestFlags
    private readonly version: number

    constructor(private readonly deps: CoreDeps) {
        this.timers = deps.timers ?? realTimers
        this.flags = deps.flags ?? {}
        this.version = this.flags.dbVersion ?? DB_VERSION
        deps.channel.onmessage = (message) => {
            this.upgradeAnswer?.onMessage(message)
        }
    }

    get status(): StorageStatus {
        return this.current
    }

    onStatus(listener: (status: StorageStatus) => void) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    /** A media item that didn't read back right: pending until `mediaStored`. */
    mediaFailed(hash: string) {
        if (this.mediaPending.has(hash)) return
        this.mediaPending.add(hash)
        this.setStatus(this.current)
    }

    mediaStored(hash: string) {
        if (this.mediaPending.delete(hash)) this.setStatus(this.current)
    }

    /** Sets the mode and reason; the pending media are added from the core's own list. */
    private setStatus({ mode, reason }: StorageStatus) {
        const pending = [...this.mediaPending]
        const status: StorageStatus = {
            mode,
            ...(reason ? { reason } : {}),
            ...(pending.length ? { mediaPending: pending } : {}),
        }
        const same = (a: StorageStatus, b: StorageStatus) =>
            a.mode === b.mode &&
            a.reason === b.reason &&
            (a.mediaPending ?? []).join() === (b.mediaPending ?? []).join()
        if (same(status, this.current)) return
        this.current = status
        for (const listener of [...this.listeners]) listener(status)
    }

    private get upgrade() {
        return upgradeDatabase({
            appVersion: this.deps.appVersion,
            deviceId: this.deps.deviceId,
            randomId: this.deps.randomId,
        })
    }

    /** Opens storage at load through the handshake. */
    async start(): Promise<StorageStatus> {
        if (this.flags.noStorage || !this.deps.factory) {
            await this.useMemory()
            return this.current
        }
        await this.apply(await this.handshake())
        return this.current
    }

    private handshake() {
        const { factory } = this.deps
        if (!factory) return Promise.resolve<Opened>({ kind: 'failed', error: undefined })
        return openWithHandshake({
            factory,
            channel: this.deps.channel,
            locks: this.deps.locks,
            version: this.version,
            upgrade: this.upgrade,
            timers: this.timers,
            blockedMs: this.deps.blockedMs,
            upgradeMs: this.deps.upgradeMs,
        })
    }

    private async apply(opened: Opened) {
        switch (opened.kind) {
            case 'stored':
                this.adopt(opened.db)
                this.setStatus({ mode: 'stored' })
                return
            case 'readOnly':
                this.adopt(opened.db)
                this.setStatus({ mode: 'readOnly' })
                return
            case 'blocked':
                this.retryBlocked = opened.retry
                await this.useMemory('olderTabs')
                return
            case 'failed':
                await this.useMemory()
                return
        }
    }

    private adopt(db: KvDatabase) {
        this.db = db
        this.lost = false
        db.onclose = () => {
            this.lost = true
        }
        if (this.flags.ignoreVersionChange) {
            db.onversionchange = undefined
            this.upgradeAnswer = undefined
            return
        }
        this.upgradeAnswer = answerUpgrades(db, () => {
            this.db = undefined
            this.upgradeAnswer = undefined
            this.setStatus({ mode: this.current.mode, reason: 'upgrading' })
        })
    }

    private async useMemory(reason?: PauseReason) {
        if (this.current.mode !== 'memory' || !this.db)
            this.db = await this.deps
                .memory()
                .open(DB_NAME, this.version, { upgrade: this.upgrade })
        this.setStatus({ mode: 'memory', reason })
    }

    /** Runs a test point: the named crash hook ends the worker here, mid-operation. */
    testPoint(name: string) {
        if (this.flags.crashAt === name) this.deps.crash?.(name)
    }

    /** A read: the stored, read-only or in-memory database alike. */
    async read<T>(
        stores: readonly string[],
        fn: (tx: KvTx) => Promise<T>,
        { tick }: Progress = {},
    ): Promise<T> {
        tick?.()
        if (this.lost) await this.reopen()
        const db = this.db
        if (!db) throw new StorageRefusedError(this.current.reason ?? 'failed')
        try {
            return await db.transaction(stores, 'readonly', fn)
        } catch (error) {
            if (!isConnectionError(error) || this.current.mode !== 'stored') throw error
            await this.reopen()
            if (!this.db) throw error
            return await this.db.transaction(stores, 'readonly', fn)
        } finally {
            tick?.()
        }
    }

    /**
     * A write in one transaction. Stored writes hold `nse-maint` shared only around it (a 3 s wait
     * at most) and retry once on a lost connection. A failure pauses storing with its reason and
     * throws StoragePausedError; the next successful write resumes. fn may run twice.
     */
    async write<T>(
        stores: readonly string[],
        fn: (tx: KvTx) => Promise<T>,
        options: WriteOptions = {},
    ): Promise<T> {
        const { tick } = options
        tick?.()
        // Try Again's move holds writes until it has switched, so none lands in memory behind it.
        while (this.moving) await this.behind(this.moving, tick)
        const { mode, reason } = this.current
        if (mode === 'readOnly') throw new StorageRefusedError('readOnly')
        if (reason === 'upgrading') throw new StorageRefusedError('upgrading')
        const db = this.db
        if (mode === 'memory') {
            if (!db) throw new StorageRefusedError('failed')
            const writing = db.transaction(stores, 'readwrite', fn, options)
            this.memoryWrites.add(writing)
            const done = () => {
                this.memoryWrites.delete(writing)
                tick?.()
            }
            writing.then(done, done)
            return writing
        }
        let result: T
        try {
            result = await withMaintShared(
                this.deps.locks,
                () => this.attempt(stores, fn, options),
                {
                    waitMs: this.deps.maintWaitMs ?? MAINT_WAIT_MS,
                    timers: this.timers,
                },
            )
        } catch (error) {
            if (error instanceof StorageRefusedError) throw error
            const paused = await this.pauseReason(error)
            if (this.current.reason !== 'upgrading')
                this.setStatus({ mode: 'stored', reason: paused })
            throw new StoragePausedError(paused, error)
        }
        if (this.current.mode === 'stored' && this.current.reason !== 'upgrading')
            this.setStatus({ mode: 'stored' })
        tick?.()
        return result
    }

    private async attempt<T>(
        stores: readonly string[],
        fn: (tx: KvTx) => Promise<T>,
        options: WriteOptions,
    ): Promise<T> {
        if (this.lost) await this.reopen()
        try {
            return await this.transact(stores, fn, options)
        } catch (error) {
            if (!isConnectionError(error)) throw error
            await this.reopen()
            return this.transact(stores, fn, options)
        }
    }

    private transact<T>(
        stores: readonly string[],
        fn: (tx: KvTx) => Promise<T>,
        options: WriteOptions,
    ) {
        // A reopen can find a newer database (§1.6.1): never write what this build doesn't know.
        if (this.current.mode !== 'stored') throw new StorageRefusedError('readOnly')
        if (this.current.reason === 'upgrading') throw new StorageRefusedError('upgrading')
        const db = this.db
        if (!db) throw domError('InvalidStateError', 'No connection')
        if (db.version !== this.version) throw new StorageRefusedError('readOnly')
        if (this.flags.forceQuota) throw domError('QuotaExceededError', 'Forced by a test')
        if (this.flags.forceUnknownError) throw domError('UnknownError', 'Forced by a test')
        return db.transaction(stores, 'readwrite', fn, options)
    }

    private async pauseReason(error: unknown): Promise<PauseReason> {
        const name = errorName(error)
        if (name === 'QuotaExceededError') return 'full'
        if (name === 'UnknownError' && this.deps.estimate) {
            try {
                if (isLowSpace(await this.deps.estimate())) return 'full'
            } catch {
                // No estimate.
            }
        }
        return 'failed'
    }

    /** Reopens after a lost connection: the versionless open again. */
    private async reopen() {
        const { factory } = this.deps
        if (!factory || this.current.mode !== 'stored') return
        this.db = undefined
        const opened = await openWithHandshake({
            factory,
            channel: this.deps.channel,
            locks: this.deps.locks,
            version: this.version,
            upgrade: this.upgrade,
            timers: this.timers,
            blockedMs: this.deps.blockedMs,
            upgradeMs: this.deps.upgradeMs,
        })
        if (opened.kind === 'stored') this.adopt(opened.db)
        else if (opened.kind === 'readOnly') {
            this.adopt(opened.db)
            this.setStatus({ mode: 'readOnly' })
        } else if (opened.kind === 'blocked') this.retryBlocked = opened.retry
    }

    /** pageshow or resume: reopens a connection the browser dropped. */
    async resume(): Promise<StorageStatus> {
        if (this.lost && this.current.mode === 'stored') {
            try {
                await this.reopen()
            } catch {
                // The next write pauses with its reason.
            }
        }
        return this.current
    }

    /**
     * Try Again: behind a blocked upgrade, asks again and on success moves what this tab stored
     * in memory into the database; otherwise reopens a dropped connection.
     */
    tryAgain({ tick }: Progress = {}): Promise<StorageStatus> {
        if (this.trying) return this.behind(this.trying, tick)
        this.trying = this.askAgain(tick).finally(() => {
            this.trying = undefined
        })
        return this.trying
    }

    /** Waits on Try Again's work, its steps counting as the waiting call's progress. */
    private async behind<T>(work: Promise<T>, tick: (() => void) | undefined): Promise<T> {
        if (!tick) return work
        this.behindMove.add(tick)
        try {
            return await work
        } finally {
            this.behindMove.delete(tick)
        }
    }

    private moveTick(tick: (() => void) | undefined) {
        tick?.()
        for (const each of this.behindMove) each()
    }

    private async askAgain(tick: (() => void) | undefined): Promise<StorageStatus> {
        if (this.current.mode === 'memory' && this.current.reason === 'olderTabs') {
            const retry = this.retryBlocked ?? (() => this.handshake())
            const opened = await retry()
            if (opened.kind === 'blocked') {
                this.retryBlocked = opened.retry
                return this.current
            }
            this.retryBlocked = undefined
            if (opened.kind === 'stored') {
                try {
                    await this.moveIntoStorage(opened.db, tick)
                } catch (error) {
                    // Still in memory; the next Try Again opens afresh.
                    opened.db.close()
                    throw error
                }
            } else if (opened.kind === 'readOnly') {
                this.adopt(opened.db)
                this.setStatus({ mode: 'readOnly' })
            }
            return this.current
        }
        return this.resume()
    }

    /**
     * Copies the in-memory rows into the database in one strict transaction, then switches. Writes
     * wait meanwhile, so an acknowledged flush can't land in memory behind the copy.
     */
    private async moveIntoStorage(target: KvDatabase, tick: (() => void) | undefined) {
        let release!: () => void
        this.moving = new Promise<void>((resolve) => {
            release = resolve
        })
        // A newer tab asking meanwhile is answered at once, as a stored tab answers it.
        const asked = { aside: false }
        this.upgradeAnswer = answerUpgrades(target, () => {
            asked.aside = true
        })
        try {
            await this.copyIntoStorage(target, tick)
            if (asked.aside) {
                this.db = undefined
                this.upgradeAnswer = undefined
                this.setStatus({ mode: 'stored', reason: 'upgrading' })
                return
            }
            this.adopt(target)
            this.setStatus({ mode: 'stored' })
        } catch (error) {
            this.upgradeAnswer = undefined
            throw error
        } finally {
            this.moving = undefined
            release()
        }
    }

    private async copyIntoStorage(target: KvDatabase, tick: (() => void) | undefined) {
        // Writes already sent to memory commit first; the gate holds any later one.
        await Promise.allSettled([...this.memoryWrites])
        this.moveTick(tick)
        const source = this.db
        const rows = new Map<string, { key: unknown; value: unknown }[]>()
        if (source)
            await source.transaction(STORE_NAMES, 'readonly', async (tx) => {
                for (const store of STORE_NAMES) {
                    if (store === 'meta') continue
                    const entries = await tx.entries(store)
                    rows.set(
                        store,
                        entries.map((entry) => ({ key: entry.primaryKey, value: entry.value })),
                    )
                }
            })
        const memoryTime = source
            ? await source.transaction(['meta'], 'readonly', (tx) => readMeta(tx, 'maxSeenTime'))
            : undefined
        const run = () =>
            target.transaction(
                STORE_NAMES,
                'readwrite',
                async (tx) => {
                    const stored = (await readMeta(tx, 'maxSeenTime')) ?? 0
                    const seen = Math.max(stored, memoryTime ?? 0)
                    // Moved rows take this database's day of use, not the memory store's (§1.6.8.7).
                    const day = await countDayOfUse(tx, nextTime(seen, Date.now()))
                    for (const [store, list] of rows) {
                        const inline = tx.describe(store).keyPath !== null
                        for (const { key, value } of list) {
                            this.moveTick(tick)
                            const moved = withDay(value, day)
                            if (inline) {
                                await tx.put(store, moved)
                                continue
                            }
                            // Content-addressed rows already there keep their first day.
                            const hash = key as ArrayBuffer
                            if ((await tx.getKey(store, hash)) === undefined)
                                await tx.put(store, moved, hash)
                        }
                    }
                    if (seen > stored) await writeMeta(tx, 'maxSeenTime', seen)
                },
                { durability: 'strict' },
            )
        await withMaintShared(this.deps.locks, run, {
            waitMs: this.deps.maintWaitMs ?? MAINT_WAIT_MS,
            timers: this.timers,
        })
    }
}

/** A row with its `day` set, when it has one. */
const withDay = (value: unknown, day: number) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { day?: unknown }).day === 'number'
        ? { ...value, day }
        : value
