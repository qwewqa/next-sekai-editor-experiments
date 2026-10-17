import { inflateStrict } from '../chunkVerify'
import { countDayOfUse } from '../days'
import { hashKey, readMeta } from '../db'
import {
    FLUSH_STORES,
    prepareFlush,
    writeFlush,
    type FlushBatch,
    type FlushResult,
    type PreparedFlush,
} from '../flushWrite'
import { prepareForeign, writeForeign, type ForeignBatch, type ForeignResult } from '../foreign'
import { equalBytes, fromHex16, sha256 } from '../hash'
import { nodeJsonFromRow, rootJsonFromRow, type NodesRow } from '../records/rows'
import { directWaiter, type Waiter } from '../scheduler'
import { nextTime } from '../time'
import type { StorageCore } from './core'
import { runFlushHooks } from './flushHooks'
import type { WorkerContext } from './handlers'

// The storage worker's flush methods (Part 1 §1.6.4, §1.6.8.4): the flush itself, media read
// back once after its first write, the day of use at load, and the dev console's snapshot reader.

/** A media row read back did not hash to its key, twice: storing pauses (§1.6.8.4). */
export class MediaReadBackError extends Error {
    override name = 'MediaReadBackError'
}

type MediaRow = { blob: Blob; sha256: Uint8Array } & Record<string, unknown>

let readBackHook: ((bytes: Uint8Array, attempt: number) => Uint8Array) | undefined

/** A test hook that changes what a media read-back sees, as WebKit's unreadable Blobs did. */
export const setMediaReadBackHookForTests = (hook: typeof readBackHook) => {
    readBackHook = hook
}

/**
 * Reads each media row this flush put back and re-hashes it, once (§1.6.8.4): on a mismatch it's
 * written again from memory, and a second mismatch pauses storing with a reason.
 */
export const readBackMedia = async (
    core: Pick<StorageCore, 'read' | 'write'>,
    hashes: readonly string[],
    prepared: PreparedFlush,
    waiter: Waiter = directWaiter,
) => {
    for (const hex of hashes) {
        const key = hashKey(fromHex16(hex))
        const item = prepared.media.get(hex)
        for (let attempt = 0; ; attempt++) {
            const row = (await core.read(['media'], (tx) => tx.get('media', key))) as
                MediaRow | undefined
            let intact = false
            if (row) {
                try {
                    let bytes: Uint8Array = new Uint8Array(
                        await waiter.wait(row.blob.arrayBuffer()),
                    )
                    if (readBackHook) bytes = readBackHook(bytes, attempt)
                    intact = equalBytes(await waiter.wait(sha256(bytes)), row.sha256)
                } catch {
                    intact = false
                }
            }
            if (intact) break
            if (attempt >= 1 || !item || !row) {
                await pauseWith(core, new MediaReadBackError(hex))
                break
            }
            const blob = new Blob([item.bytes], item.type ? { type: item.type } : {})
            await core.write(['media'], (tx) => tx.put('media', { ...row, blob }, key), {
                durability: 'strict',
            })
        }
    }
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

export const flushHandlers = (context: WorkerContext, waiter: Waiter = directWaiter) => {
    let armed: string | undefined
    const testOnly = () => {
        if (!context.test) throw new Error('Test hooks need a test flag')
    }
    return {
        /** One flush: prepared first, then one transaction; the reply is the acknowledgement. */
        flush: async (batch: FlushBatch): Promise<FlushResult> => {
            const core = context.core
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
                { durability: batch.durability },
            )
            if (result.kind !== 'stored') return result
            const { committed, ...reply } = result
            await readBackMedia(core, result.putMedia, prepared, waiter)
            if (committed) void runFlushHooks(committed)
            return reply
        },

        /** Foreign data with its closure check (§1.6.4 step 4), committed strictly. */
        importForeign: async (batch: ForeignBatch): Promise<ForeignResult> => {
            const prepared = await prepareForeign(batch, waiter)
            return context.core.write(
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
                { durability: 'strict' },
            )
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
