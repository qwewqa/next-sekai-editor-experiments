import { freezePublished } from '../../../src/history/freeze'
import { CHANNEL_NAME } from '../../../src/local/channel'
import { runToEnd } from '../../../src/local/chunks'
import { inflateStrict } from '../../../src/local/chunkVerify'
import { DB_NAME, hashKey } from '../../../src/local/db'
import { Flusher, type FlushDeps, type FlushReport } from '../../../src/local/flush'
import type { FlushBatch, FlushResult } from '../../../src/local/flushWrite'
import { fromHex16, toHex } from '../../../src/local/hash'
import { keyText } from '../../../src/local/kv/keys'
import { MemoryKv } from '../../../src/local/kv/memory'
import { asError, type Key } from '../../../src/local/kv/types'
import type { SnapshotRecords } from '../../../src/local/records/encode'
import { nodeJsonFromRow, rootJsonFromRow, type NodesRow } from '../../../src/local/records/rows'
import { decodeSnapshot } from '../../../src/local/records/snapshot'
import type { Tab, World } from '../../../src/local/testing/world'
import {
    StorageCore,
    type CoreDeps,
    type StorageStatus,
    type TestFlags,
} from '../../../src/local/worker/core'
import { flushHandlers } from '../../../src/local/worker/flushHandlers'
import type { WorkerContext } from '../../../src/local/worker/handlers'

// A tab's storage worker and page on the test core: a StorageCore over the tab's store, the flush
// handlers, and a Flusher whose transport runs each batch as a task of the tab. `openSplitPage`
// puts the worker on an actor of its own, with restarts, and timers on the world's clock.

let ids = 0

export const testId = () => `id-${ids++}`

export const workerCore = (world: World, tab: Tab, deps: Partial<CoreDeps> = {}) => {
    const fallback = new MemoryKv(world.scheduler)
    return new StorageCore({
        factory: tab.kv,
        memory: () => fallback.factory(tab.actor),
        channel: tab.channel(CHANNEL_NAME),
        locks: tab.locks,
        appVersion: '0.6.0',
        randomId: testId,
        blockedMs: 40,
        upgradeMs: 80,
        maintWaitMs: 200,
        ...deps,
    })
}

export type Page = {
    tab: Tab
    core: StorageCore
    handlers: ReturnType<typeof flushHandlers>
    flusher: Flusher
    batches: FlushBatch[]
    results: FlushResult[]
    reports: FlushReport[]
    errors: unknown[]
}

/** States a test hands the flusher are frozen, as the undo stack publishes them. */
const freezing = (flusher: Flusher) => {
    const { append, begin } = flusher
    flusher.append = (kind, label, state, dirty) => {
        if (!(state instanceof Uint8Array)) freezePublished(state)
        append.call(flusher, kind, label, state, dirty)
    }
    flusher.begin = (start) => {
        freezePublished(start.state)
        return begin.call(flusher, start)
    }
    return flusher
}

/** A tab with its worker started and a flusher posting to it. */
export const openPage = async (
    world: World,
    tab: Tab,
    deps: Partial<FlushDeps> = {},
    coreDeps: Partial<CoreDeps> = {},
): Promise<Page> => {
    const core = workerCore(world, tab, coreDeps)
    await tab.run(() => core.start())
    const context: WorkerContext = { core, test: true, emit: () => undefined }
    const handlers = flushHandlers(context, tab.waiter)
    const batches: FlushBatch[] = []
    const results: FlushResult[] = []
    const reports: FlushReport[] = []
    const errors: unknown[] = []
    let clock = 1_000_000
    const flusher = freezing(
        new Flusher({
            appVersion: '0.6.0',
            now: () => (clock += 10),
            newId: testId,
            transport: async (batch) => {
                batches.push(batch)
                const result = await tab.run(() => handlers.flush(batch))
                results.push(result)
                return result
            },
            onFlushed: (report) => reports.push(report),
            onError: (error) => errors.push(error),
            // Flushes run when a test asks, and extract in one go: a timer is outside the scheduler.
            runJob: (job) => Promise.resolve(runToEnd(job)),
            setTimer: () => undefined,
            clearTimer: () => undefined,
            ...deps,
        }),
    )
    return { tab, core, handlers, flusher, batches, results, reports, errors }
}

/** The rows of a store in the profile, by key: a string key as it is, others as key text. */
export const rows = (world: World, store: string) =>
    new Map(
        (world.memory.dump(DB_NAME).get(store) ?? []).map((row) => [
            typeof row.key === 'string' ? row.key : keyText(row.key as Key),
            row.value as Record<string, unknown>,
        ]),
    )

/** A stored snapshot's records, read from the rows and checked as a reader would. */
export const storedRecords = (world: World, root: Uint8Array): SnapshotRecords => {
    const nodes = rows(world, 'nodes')
    const chunks = rows(world, 'chunks')
    const key = (hex: string) => keyText(hashKey(fromHex16(hex)))
    const rootRow = nodes.get(keyText(hashKey(root))) as NodesRow | undefined
    if (rootRow?.t !== 'root') throw new Error(`No root ${toHex(root)}`)
    const decoder = new TextDecoder()
    return decodeSnapshot(rootJsonFromRow(rootRow), {
        node: (hex) => {
            const row = nodes.get(key(hex)) as NodesRow | undefined
            if (row?.t !== 'node') throw new Error(`No node ${hex}`)
            return nodeJsonFromRow(row)
        },
        chunk: (hex) => {
            const row = chunks.get(key(hex)) as { bytes: Uint8Array } | undefined
            if (!row) throw new Error(`No chunk ${hex}`)
            return JSON.parse(decoder.decode(inflateStrict(row.bytes))) as unknown
        },
    })
}

/** A worker restart's error, as the page's client gives it. */
const restartedError = () => {
    const error = new Error('The storage worker restarted')
    error.name = 'WorkerRestartedError'
    return error
}

export type WorkerSetup = { flags?: TestFlags; core?: Partial<CoreDeps> }

type Handlers = ReturnType<typeof flushHandlers>

/**
 * A page's storage worker on its own actor, as `StorageWorker` runs it: calls wait through a
 * restart, a killed worker fails the calls in flight and starts again over a new in-memory store,
 * and the restart listeners run before calls go on. Timers are the world's clock.
 */
export class WorkerHost {
    worker!: Tab
    core!: StorageCore
    handlers!: Handlers
    /** Each worker's in-memory store, in start order. */
    readonly memories: MemoryKv[] = []
    private ready: Promise<unknown> = Promise.resolve()
    private generation = 0
    private resolveStarted!: (status: StorageStatus) => void
    private readonly started = new Promise<StorageStatus>((resolve) => {
        this.resolveStarted = resolve
    })
    private readonly inFlight = new Set<(error: Error) => void>()
    private readonly listeners = new Set<() => void>()

    constructor(
        private readonly world: World,
        readonly page: Tab,
        private readonly setup: WorkerSetup = {},
    ) {}

    /** How many workers were started. */
    get starts() {
        return this.generation
    }

    /** The newest worker's in-memory store. */
    get memory() {
        return this.memories.at(-1)!
    }

    /** Starts the first worker, on `first` when given (a sweep's victim); a kill restarts it. */
    start(first?: Tab) {
        this.ready = this.launch(first).catch(() => undefined)
        return this.started
    }

    onRestart(listener: () => void) {
        this.listeners.add(listener)
    }

    private launch(given?: Tab): Promise<StorageStatus> {
        const generation = ++this.generation
        const worker =
            given ?? this.world.tab(`${this.page.name}:worker${generation}`, { owner: this.page })
        const memory = new MemoryKv(this.world.scheduler)
        this.memories.push(memory)
        const core = new StorageCore({
            factory: worker.kv,
            memory: () => memory.factory(worker.actor),
            channel: worker.channel(CHANNEL_NAME),
            locks: worker.locks,
            appVersion: '0.6.0',
            randomId: testId,
            timers: this.world.clock.for(worker.actor),
            ...this.setup.core,
            flags: { ...this.setup.flags },
        })
        this.worker = worker
        this.core = core
        this.handlers = flushHandlers({ core, test: true, emit: () => undefined }, worker.waiter)
        return new Promise<StorageStatus>((resolve, reject) => {
            this.world.scheduler.onKill(worker.actor, () => {
                reject(restartedError())
                if (generation === this.generation) this.restart()
            })
            worker
                .run(() => core.start())
                .then((status) => {
                    this.resolveStarted(status)
                    resolve(status)
                }, reject)
        })
    }

    private restart() {
        if (!this.page.alive) return
        const failed = [...this.inFlight]
        this.inFlight.clear()
        void this.page.run(() => {
            for (const fail of failed) fail(restartedError())
        })
        this.ready = this.page
            .run(async () => {
                await this.launch()
                for (const listener of [...this.listeners]) listener()
            })
            .catch(() => undefined)
    }

    /** Runs fn in the worker, its reply a task of the page; `current` as the client's. */
    async call<T>(
        fn: (handlers: Handlers, core: StorageCore) => Promise<T>,
        current?: () => boolean,
    ): Promise<T> {
        // A restart during a restart replaces `ready`.
        for (let ready = this.ready; ; ready = this.ready) {
            await ready
            if (ready === this.ready) break
        }
        if (current && !current()) throw restartedError()
        const { worker, handlers, core, page } = this
        return new Promise<T>((resolve, reject) => {
            const fail = (error: Error) => {
                reject(error)
            }
            this.inFlight.add(fail)
            worker
                .run(() => fn(handlers, core))
                .then(
                    (value) =>
                        void page.run(() => {
                            if (this.inFlight.delete(fail)) resolve(value)
                        }),
                    (error: unknown) =>
                        void page.run(() => {
                            if (this.inFlight.delete(fail)) reject(asError(error))
                        }),
                )
        })
    }
}

export type SplitPage = Omit<Page, 'tab' | 'core' | 'handlers'> & {
    page: Tab
    host: WorkerHost
    status: StorageStatus
}

/**
 * A page and its worker on separate actors (§1.6.5): the worker can be killed alone while the
 * page keeps its memo and pending entries. The flusher's timers and clock are the world's.
 */
export const openSplitPage = async (
    world: World,
    options: WorkerSetup & { name?: string; first?: Tab; flush?: Partial<FlushDeps> } = {},
): Promise<SplitPage> => {
    const page = world.tab(options.name ?? 'page')
    const host = new WorkerHost(world, page, options)
    const timers = world.clock.for(page.actor)
    const batches: FlushBatch[] = []
    const results: FlushResult[] = []
    const reports: FlushReport[] = []
    const errors: unknown[] = []
    const flusher = freezing(
        new Flusher({
            appVersion: '0.6.0',
            now: timers.now,
            newId: testId,
            transport: (batch, _transfer, current) =>
                host.call(async (handlers) => {
                    batches.push(batch)
                    const result = await handlers.flush(batch)
                    results.push(result)
                    return result
                }, current),
            onFlushed: (report) => reports.push(report),
            onError: (error) => errors.push(error),
            runJob: (job) => Promise.resolve(runToEnd(job)),
            setTimer: timers.setTimeout,
            clearTimer: timers.clearTimeout,
            ...options.flush,
        }),
    )
    host.onRestart(() => {
        void flusher.restarted()
    })
    const status = await host.start(options.first)
    return { page, host, flusher, status, batches, results, reports, errors }
}

/** A store's rows by key, as `rows` gives the profile's. */
export const storeRows = (memory: MemoryKv, store: string) =>
    new Map(
        (memory.dump(DB_NAME).get(store) ?? []).map((row) => [
            typeof row.key === 'string' ? row.key : keyText(row.key as Key),
            row.value as Record<string, unknown>,
        ]),
    )
