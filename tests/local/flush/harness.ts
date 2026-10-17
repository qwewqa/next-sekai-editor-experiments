import { CHANNEL_NAME } from '../../../src/local/channel'
import { runToEnd } from '../../../src/local/chunks'
import { inflateStrict } from '../../../src/local/chunkVerify'
import { DB_NAME, hashKey } from '../../../src/local/db'
import { Flusher, type FlushDeps, type FlushReport } from '../../../src/local/flush'
import type { FlushBatch, FlushResult } from '../../../src/local/flushWrite'
import { fromHex16, toHex } from '../../../src/local/hash'
import { keyText } from '../../../src/local/kv/keys'
import { MemoryKv } from '../../../src/local/kv/memory'
import type { Key } from '../../../src/local/kv/types'
import type { SnapshotRecords } from '../../../src/local/records/encode'
import { nodeJsonFromRow, rootJsonFromRow, type NodesRow } from '../../../src/local/records/rows'
import { decodeSnapshot } from '../../../src/local/records/snapshot'
import type { Tab, World } from '../../../src/local/testing/world'
import { StorageCore, type CoreDeps } from '../../../src/local/worker/core'
import { flushHandlers } from '../../../src/local/worker/flushHandlers'
import type { WorkerContext } from '../../../src/local/worker/handlers'

// A tab's storage worker and page on the test core: a StorageCore over the tab's store, the flush
// handlers, and a Flusher whose transport runs each batch as a task of the tab.

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
    const flusher = new Flusher({
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
    })
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
