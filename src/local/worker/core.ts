import type { LockService } from '../../platform/types'
import type { Channel } from '../channel'
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
        super(`Storing paused: ${reason}`)
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

export type WriteOptions = { durability?: Durability }

export class StorageCore {
    private db: KvDatabase | undefined
    private current: StorageStatus = { mode: 'memory' }
    private lost = false
    private retryBlocked: (() => Promise<Opened>) | undefined
    private upgradeAnswer: { onMessage: (message: unknown) => void } | undefined
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

    private setStatus(status: StorageStatus) {
        if (status.mode === this.current.mode && status.reason === this.current.reason) return
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
    async read<T>(stores: readonly string[], fn: (tx: KvTx) => Promise<T>): Promise<T> {
        if (this.lost) await this.reopen()
        const db = this.db
        if (!db) throw new StorageRefusedError(this.current.reason ?? 'failed')
        try {
            return await db.transaction(stores, 'readonly', fn)
        } catch (error) {
            if (!isConnectionError(error) || this.current.mode !== 'stored') throw error
            await this.reopen()
            if (!this.db) throw error
            return this.db.transaction(stores, 'readonly', fn)
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
        const { mode, reason } = this.current
        if (mode === 'readOnly') throw new StorageRefusedError('readOnly')
        if (reason === 'upgrading') throw new StorageRefusedError('upgrading')
        const db = this.db
        if (mode === 'memory') {
            if (!db) throw new StorageRefusedError('failed')
            return db.transaction(stores, 'readwrite', fn, options)
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
        if (this.current.reason === 'upgrading') throw new StorageRefusedError('upgrading')
        const db = this.db
        if (!db) throw domError('InvalidStateError', 'No connection')
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
    async tryAgain(): Promise<StorageStatus> {
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
                    await this.moveIntoStorage(opened.db)
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

    /** Copies the in-memory rows into the database in one strict transaction, then switches. */
    private async moveIntoStorage(target: KvDatabase) {
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
                    for (const [store, list] of rows) {
                        const inline = tx.describe(store).keyPath !== null
                        for (const { key, value } of list) {
                            if (inline) {
                                await tx.put(store, value)
                                continue
                            }
                            // Content-addressed rows already there keep their first day.
                            const hash = key as ArrayBuffer
                            if ((await tx.getKey(store, hash)) === undefined)
                                await tx.put(store, value, hash)
                        }
                    }
                    const stored = (await readMeta(tx, 'maxSeenTime')) ?? 0
                    if (memoryTime !== undefined && memoryTime > stored)
                        await writeMeta(tx, 'maxSeenTime', memoryTime)
                },
                { durability: 'strict' },
            )
        await withMaintShared(this.deps.locks, run, {
            waitMs: this.deps.maintWaitMs ?? MAINT_WAIT_MS,
            timers: this.timers,
        })
        this.adopt(target)
        this.setStatus({ mode: 'stored' })
    }
}
