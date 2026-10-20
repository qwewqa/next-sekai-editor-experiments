import { inflateStrict } from '../chunkVerify'
import { countDayOfUse } from '../days'
import { hashKey, readMeta } from '../db'
import {
    FLUSH_STORES,
    FlushBatchError,
    mediaRow,
    prepareFlush,
    writeFlush,
    type BatchMedia,
    type FlushBatch,
    type FlushResult,
    type PreparedFlush,
} from '../flushWrite'
import { prepareForeign, writeForeign, type ForeignBatch, type ForeignResult } from '../foreign'
import { equalBytes, fromHex16, sha256, toHex } from '../hash'
import { nodeJsonFromRow, rootJsonFromRow, type NodesRow } from '../records/rows'
import { directWaiter, type Waiter } from '../scheduler'
import { nextTime } from '../time'
import type { Progress, StorageCore } from './core'
import { runFlushHooks } from './flushHooks'
import type { WorkerContext } from './handlers'
import type { CallScope } from './rpc'

// The storage worker's flush methods (Part 1 §1.6.4, §1.6.8.4): the flush itself, media read
// back once after it is sent, the day of use at load, and the dev console's snapshot reader.

type MediaRow = { blob: Blob; sha256: Uint8Array } & Record<string, unknown>

/** Carried media by hash, with the full SHA-256 of its bytes. */
type CarriedMedia = ReadonlyMap<string, BatchMedia & { sha256: Uint8Array }>

let readBackHook: ((bytes: Uint8Array, attempt: number) => Uint8Array) | undefined

/** A test hook that changes what a media read-back sees, as WebKit's unreadable Blobs did. */
export const setMediaReadBackHookForTests = (hook: typeof readBackHook) => {
    readBackHook = hook
}

/**
 * Reads back each media row just written and re-hashes it (§1.6.8.4). On a mismatch it's written
 * again from memory; a second mismatch removes the row, which reads as not held. A row that can't
 * be read is kept: the error may pass. Either way the item is reported in the status's
 * `mediaPending` until a read-back of it succeeds, and the page stores it again on its own;
 * storing isn't paused, so the history goes on. Returns the hashes that failed.
 */
export const readBackMedia = async (
    core: Pick<StorageCore, 'read' | 'write' | 'mediaFailed' | 'mediaStored'>,
    hashes: readonly string[],
    media: CarriedMedia,
    waiter: Waiter = directWaiter,
    progress: Progress = {},
): Promise<string[]> => {
    const failed: string[] = []
    for (const hex of hashes) {
        const key = hashKey(fromHex16(hex))
        const item = media.get(hex)
        for (let attempt = 0; ; attempt++) {
            let outcome: 'intact' | 'wrong' | 'unread' = 'unread'
            let row: MediaRow | undefined
            try {
                row = (await core.read(['media'], (tx) => tx.get('media', key), progress)) as
                    MediaRow | undefined
                if (row) {
                    let bytes: Uint8Array = new Uint8Array(
                        await waiter.wait(row.blob.arrayBuffer()),
                    )
                    if (readBackHook) bytes = readBackHook(bytes, attempt)
                    const digest = await waiter.wait(sha256(bytes))
                    outcome = equalBytes(digest, row.sha256) ? 'intact' : 'wrong'
                }
            } catch {
                outcome = 'unread'
            }
            if (outcome === 'intact') {
                core.mediaStored(hex)
                break
            }
            if (outcome === 'wrong' && row && item && attempt === 0) {
                const blob = new Blob([item.bytes], item.type ? { type: item.type } : {})
                const rewritten = { ...row, blob }
                const written = await core
                    .write(['media'], (tx) => tx.put('media', rewritten, key), {
                        durability: 'strict',
                        ...progress,
                    })
                    .then(
                        () => true,
                        () => false,
                    )
                if (written) continue
            } else if (outcome === 'wrong') {
                // Only bytes read and found wrong are removed. No epoch bump: every flush checks
                // the media it names by key, and the epoch guards only the chunk memo (§1.6.6).
                await core
                    .write(['media'], (tx) => tx.delete('media', key), progress)
                    .catch(() => undefined)
            }
            core.mediaFailed(hex)
            failed.push(hex)
            break
        }
    }
    return failed
}

/** Pauses storing through the core's one failure path; the next stored flush resumes it. */
const pauseWith = (core: Pick<StorageCore, 'write'>, error: unknown) =>
    core
        .write(['meta'], () =>
            Promise.reject(error instanceof Error ? error : new Error(String(error))),
        )
        .catch(() => undefined)

/** A snapshot's parts as parsed JSON forms by hex hash, for `inspectSnapshot`. */
export type SnapshotParts = {
    root: unknown
    nodes: Record<string, unknown>
    chunks: Record<string, unknown>
}

const decoder = new TextDecoder()

export const flushHandlers = (context: WorkerContext, outside: Waiter = directWaiter) => {
    let armed: string | undefined
    // Each wait outside IndexedDB (hashing, a Blob read) counts as the call's progress (§1.6.5).
    const waiterOf = (progress: Progress): Waiter => ({
        wait: async (promise) => {
            try {
                return await outside.wait(promise)
            } finally {
                progress.tick?.()
            }
        },
    })
    const testOnly = () => {
        if (!context.test) throw new Error('Test hooks need a test flag')
    }
    return {
        /** One flush: prepared first, then one transaction; the reply is the acknowledgement. */
        flush: async (batch: FlushBatch, scope?: CallScope): Promise<FlushResult> => {
            const core = context.core
            const progress: Progress = scope ?? {}
            const waiter = waiterOf(progress)
            let prepared: PreparedFlush
            try {
                prepared = await prepareFlush(batch, waiter)
            } catch (error) {
                // Verify on write failed, or the batch is malformed: a bug. Nothing is put, and
                // storing pauses as for any failed flush (§1.6.11.2).
                console.error('A flush was refused before writing', error)
                await pauseWith(core, error)
                throw error
            }
            const result = await core.write(
                FLUSH_STORES,
                (tx) =>
                    writeFlush(tx, batch, prepared, {
                        testPoint: (name) => {
                            if (armed !== name) return
                            armed = undefined
                            core.testPoint(name)
                        },
                    }),
                { durability: batch.durability, ...progress },
            )
            if (result.kind !== 'stored') return result
            // In memory, the page keeps the entries: a restarted worker's store is new (§1.6.5).
            const memory = core.status.mode === 'memory'
            const noDatabase = memory && core.status.reason !== 'olderTabs'
            const { committed, mediaFailed: refused = [], ...reply } = result
            for (const hex of refused) core.mediaFailed(hex)
            // Media that reads back wrong never fails the entries: they're committed (§1.6.8.4).
            const mediaFailed = [
                ...refused,
                ...(await readBackMedia(core, result.readBack, prepared.media, waiter, progress)),
            ]
            if (committed) void runFlushHooks(committed)
            return {
                ...reply,
                ...(mediaFailed.length ? { mediaFailed } : {}),
                ...(memory ? { memory } : {}),
                ...(noDatabase ? { noDatabase } : {}),
            }
        },

        /**
         * A media item stored on its own, after its flush's read-back failed (§1.6.8.4): put
         * when it's missing, then read back. Resolves whether it's stored right now.
         */
        storeMedia: async (item: BatchMedia, scope?: CallScope): Promise<boolean> => {
            const core = context.core
            const progress: Progress = scope ?? {}
            const waiter = waiterOf(progress)
            const digest = await waiter.wait(sha256(new Uint8Array(item.bytes)))
            if (toHex(digest.subarray(0, 16)) !== item.hash)
                throw new FlushBatchError('Media bytes do not hash to their hash')
            const carried = { ...item, sha256: digest }
            const key = hashKey(fromHex16(item.hash))
            const put = await core.write(
                ['media', 'meta'],
                async (tx) => {
                    if ((await tx.getKey('media', key)) !== undefined) return true
                    const now = nextTime((await readMeta(tx, 'maxSeenTime')) ?? 0, Date.now())
                    const row = mediaRow(carried, await countDayOfUse(tx, now))
                    return tx.tryPut('media', row, key)
                },
                { durability: 'strict', ...progress },
            )
            // Refused (WebKit's private windows): storing goes on, and the page tries again later.
            if (!put) {
                core.mediaFailed(item.hash)
                return false
            }
            const failed = await readBackMedia(
                core,
                [item.hash],
                new Map([[item.hash, carried]]),
                waiter,
                progress,
            )
            return failed.length === 0
        },

        /**
         * Foreign data with its closure check (§1.6.4 step 4), committed strictly. A planned seam
         * for a later step's import of another device's data: only the specs call it until then.
         */
        importForeign: async (batch: ForeignBatch, scope?: CallScope): Promise<ForeignResult> => {
            const progress: Progress = scope ?? {}
            const prepared = await prepareForeign(batch, waiterOf(progress))
            const result = await context.core.write(
                ['nodes', 'chunks', 'media', 'meta'],
                async (tx) =>
                    writeForeign(
                        tx,
                        prepared,
                        batch.roots,
                        await countDayOfUse(
                            tx,
                            nextTime((await readMeta(tx, 'maxSeenTime')) ?? 0, Date.now()),
                        ),
                    ),
                { durability: 'strict', ...progress },
            )
            if (result.kind === 'stored')
                for (const hash of result.mediaFailed ?? []) context.core.mediaFailed(hash)
            return result
        },

        /** Counts today as a day of use at load (§1.6.8.7). */
        countDay: () =>
            context.core.write(['meta'], async (tx) =>
                countDayOfUse(tx, nextTime((await readMeta(tx, 'maxSeenTime')) ?? 0, Date.now())),
            ),

        /** A stored snapshot's root, nodes and chunks, for the dev console's inspector. */
        readSnapshot: (hex: string) =>
            context.core.read(['nodes', 'chunks'], async (tx) => {
                const parts: SnapshotParts = { root: undefined, nodes: {}, chunks: {} }
                const rootRow = (await tx.get('nodes', hashKey(fromHex16(hex)))) as
                    NodesRow | undefined
                if (rootRow?.t !== 'root') return parts
                const root = rootJsonFromRow(rootRow)
                parts.root = root
                const [, header, kinds] = root as [number, string, [string, string][]]
                const chunk = async (h: string) => {
                    const row = (await tx.get('chunks', hashKey(fromHex16(h)))) as
                        { bytes: Uint8Array } | undefined
                    if (row) parts.chunks[h] = JSON.parse(decoder.decode(inflateStrict(row.bytes)))
                }
                const node = async (h: string) => {
                    const row = (await tx.get('nodes', hashKey(fromHex16(h)))) as
                        NodesRow | undefined
                    if (row?.t !== 'node') return
                    const json = nodeJsonFromRow(row)
                    parts.nodes[h] = json
                    for (const child of json[2] as string[])
                        await (row.depth === 1 ? node(child) : chunk(child))
                }
                await chunk(header)
                for (const [, top] of kinds) await node(top)
                return parts
            }),

        /** Test: the next flush's transaction kills the worker at this point, once. */
        testArmCrash: (point: string) => {
            testOnly()
            armed = point
            return true
        },

        /** Test: every row of some stores, for the specs' checks. */
        testRows: (stores: string[]) => {
            testOnly()
            return context.core.read(stores, async (tx) => {
                const rows: Record<string, { key: unknown; value: unknown }[]> = {}
                for (const store of stores)
                    rows[store] = (await tx.entries(store)).map(({ primaryKey, value }) => ({
                        key: primaryKey,
                        value,
                    }))
                return rows
            })
        },
    }
}

export type FlushHandlers = ReturnType<typeof flushHandlers>
