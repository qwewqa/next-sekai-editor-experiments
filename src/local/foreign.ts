import { verifyChunk, type VerifiedChunk } from './chunkVerify'
import { hashKey } from './db'
import type { BatchMedia } from './flushWrite'
import { equalBytes, fromHex16, hash16, sha256, toHex } from './hash'
import type { KvTx } from './kv/types'
import { putChunk } from './putChunk'
import type { RecordValue } from './records/canonical'
import { packHashes, unpackHashes, type NodeRow, type NodesRow, type RootRow } from './records/rows'
import type { KindName } from './records/schema'
import { checkNode, checkRoot } from './records/snapshot'
import { directWaiter, type Waiter } from './scheduler'

// Foreign data (Part 1 §1.6.4 step 4): an opened `.nxsp`, the version Replace keeps, a journal
// recovery. Before anything is stored, a closure check walks every root it brings in through
// `refs`: every node and chunk reached must be in the batch or already stored. If something is
// missing the transaction writes nothing (a worker transaction can't wait for the main thread),
// the page sends the missing parts, and it retries, at most twice; then the item fails whole.

/** A root or kind node from outside, as its canonical JSON bytes. */
export type ForeignNode = {
    hash: Uint8Array
    bytes: Uint8Array
    /** A root's media, as hex: its header's cover, preview and BGM, each once (§1.6.11.2). */
    media?: string[]
}

export type ForeignBatch = {
    /** The roots the item brings in: where the closure check starts. */
    roots: Uint8Array[]
    nodes: ForeignNode[]
    /** Chunks in their stored form, from a file: they must inflate and hash to their hash. */
    chunks: { hash: Uint8Array; stored: Uint8Array }[]
    /** Media the item itself carries. */
    media: BatchMedia[]
}

export type ForeignResult = { kind: 'stored' } | { kind: 'missing'; hashes: string[] }

/** Bytes from outside that aren't what their hash names: the source's damage. */
export class ForeignDataError extends Error {
    override name = 'ForeignDataError'
}

export type PreparedForeign = {
    rows: Map<string, { hash: Uint8Array; row: Omit<RootRow, 'day'> | Omit<NodeRow, 'day'> }>
    chunks: Map<string, VerifiedChunk>
    media: Map<string, BatchMedia & { sha256: Uint8Array }>
}

const decoder = new TextDecoder()

/** Hashes and checks everything from outside before the transaction (§1.6.2's order of work). */
export const prepareForeign = async (
    batch: ForeignBatch,
    waiter: Waiter = directWaiter,
): Promise<PreparedForeign> => {
    const rows: PreparedForeign['rows'] = new Map()
    for (const node of batch.nodes) {
        if (!equalBytes(await waiter.wait(hash16(node.bytes)), node.hash))
            throw new ForeignDataError(`Node ${toHex(node.hash)} does not hash to its hash`)
        const json = JSON.parse(decoder.decode(node.bytes)) as RecordValue[]
        const size = node.bytes.length
        if (Array.isArray(json[2]) && typeof json[0] === 'number') {
            checkRoot(json)
            const [v, header, kinds, noteCount] = json as [
                number,
                string,
                [KindName, string][],
                number,
            ]
            rows.set(toHex(node.hash), {
                hash: node.hash,
                row: {
                    t: 'root',
                    v,
                    kinds: kinds.map(([name]) => name),
                    noteCount,
                    refs: packHashes(
                        [header, ...kinds.map(([, hash]) => hash), ...(node.media ?? [])].map(
                            fromHex16,
                        ),
                    ),
                    size,
                },
            })
        } else {
            const kind = json[0] as KindName
            checkNode(json, kind)
            rows.set(toHex(node.hash), {
                hash: node.hash,
                row: {
                    t: 'node',
                    kind,
                    depth: json[1] as 0 | 1,
                    refs: packHashes((json[2] as string[]).map(fromHex16)),
                    size,
                },
            })
        }
    }
    const chunks: PreparedForeign['chunks'] = new Map()
    for (const chunk of batch.chunks)
        chunks.set(
            toHex(chunk.hash),
            await waiter.wait(verifyChunk({ hash: chunk.hash, stored: chunk.stored })),
        )
    const media: PreparedForeign['media'] = new Map()
    for (const item of batch.media) {
        const digest = await waiter.wait(sha256(new Uint8Array(item.bytes)))
        if (toHex(digest.subarray(0, 16)) !== item.hash)
            throw new ForeignDataError(`Media ${item.hash} does not hash to its hash`)
        media.set(item.hash, { ...item, sha256: digest })
    }
    return { rows, chunks, media }
}

/**
 * The closure check and the puts, in one strict transaction. Reads first: every node and chunk
 * reached from the roots, in the batch or in storage. A root's media may be absent (a BGM the
 * item doesn't carry and storage doesn't hold is normal, §1.6.11.4).
 */
export const writeForeign = async (
    tx: KvTx,
    prepared: PreparedForeign,
    roots: readonly Uint8Array[],
    day: number,
): Promise<ForeignResult> => {
    const missing: string[] = []
    const seen = new Set<string>()
    const nodeRow = async (hash: Uint8Array) =>
        prepared.rows.get(toHex(hash))?.row ??
        ((await tx.get('nodes', hashKey(hash))) as NodesRow | undefined)
    const hasChunk = async (hash: Uint8Array) =>
        prepared.chunks.has(toHex(hash)) || (await tx.getKey('chunks', hashKey(hash))) !== undefined

    const visitNode = async (hash: Uint8Array): Promise<void> => {
        const hex = toHex(hash)
        if (seen.has(hex)) return
        seen.add(hex)
        const row = await nodeRow(hash)
        if (!row) {
            missing.push(hex)
            return
        }
        const refs = unpackHashes(row.refs)
        if (row.t === 'root') {
            const [header, ...rest] = refs
            if (header && !(await hasChunk(header))) missing.push(toHex(header))
            for (const kindNode of rest.slice(0, row.kinds.length)) await visitNode(kindNode)
            return
        }
        for (const child of refs) {
            if (row.depth === 1) await visitNode(child)
            else if (!seen.has(toHex(child))) {
                seen.add(toHex(child))
                if (!(await hasChunk(child))) missing.push(toHex(child))
            }
        }
    }
    for (const root of roots) await visitNode(root)
    if (missing.length) return { kind: 'missing', hashes: missing }

    for (const chunk of prepared.chunks.values()) await putChunk(tx, chunk, day)
    for (const { hash, row } of prepared.rows.values())
        if ((await tx.getKey('nodes', hashKey(hash))) === undefined)
            await tx.put('nodes', { ...row, day }, hashKey(hash))
    for (const item of prepared.media.values()) {
        const key = hashKey(fromHex16(item.hash))
        if ((await tx.getKey('media', key)) !== undefined) continue
        await tx.put(
            'media',
            {
                blob: new Blob([item.bytes], item.type ? { type: item.type } : {}),
                sha256: item.sha256,
                size: item.bytes.byteLength,
                type: item.type,
                ...(item.filename === undefined ? {} : { filename: item.filename }),
                kind: item.kind,
                day,
            },
            key,
        )
    }
    return { kind: 'stored' }
}

/** Attempts of one import: the first, then at most two retries with the missing parts. */
export const FOREIGN_ATTEMPTS = 3

/**
 * The page's side: sends an item, and while the closure check finds parts missing, sends them
 * too, at most twice more. Resolves true once stored; false when parts are still missing, with
 * nothing written.
 */
export const storeForeign = async (
    send: (batch: ForeignBatch) => Promise<ForeignResult>,
    first: ForeignBatch,
    supply: (missing: readonly string[]) => Promise<Omit<ForeignBatch, 'roots'>>,
): Promise<boolean> => {
    let batch = first
    for (let attempt = 0; attempt < FOREIGN_ATTEMPTS; attempt++) {
        const result = await send(batch)
        if (result.kind === 'stored') return true
        if (attempt === FOREIGN_ATTEMPTS - 1) break
        const more = await supply(result.hashes)
        batch = {
            roots: batch.roots,
            nodes: [...batch.nodes, ...more.nodes],
            chunks: [...batch.chunks, ...more.chunks],
            media: [...batch.media, ...more.media],
        }
    }
    return false
}
