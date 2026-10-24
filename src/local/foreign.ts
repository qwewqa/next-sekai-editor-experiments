import { CHUNK_CAP, inflateStrict, verifyChunk, type VerifiedChunk } from './chunkVerify'
import type { UseDay } from './days'
import { hashKey } from './db'
import type { BatchMedia } from './flushWrite'
import { equalBytes, fromHex16, hash16, sha256, toHex } from './hash'
import type { KvTx } from './kv/types'
import { putChunk } from './putChunk'
import type { RecordValue } from './records/canonical'
import {
    isChunkRowIntact,
    packHashes,
    unpackHashes,
    type ChunkRow,
    type NodeRow,
    type NodesRow,
    type RootRow,
} from './records/rows'
import { checkHeader, type KindName } from './records/schema'
import { checkNode, checkRoot, headerMedia, rootVersion } from './records/snapshot'
import { RECORDS_V } from './records/version'
import { directWaiter, type Waiter } from './scheduler'

// Foreign data: an opened `.nxsp`, the version Replace keeps, a journal
// recovery. Before anything is stored, a closure check walks every root it brings in through
// `refs`: every node and chunk reached must be in the batch or already stored. If something is
// missing the transaction writes nothing (a worker transaction can't wait for the main thread),
// the page sends the missing parts, and it retries, at most twice; then the item fails whole.
// A root's media `refs` come from its header chunk, never from the caller.

/** A root or kind node from outside, as its canonical JSON bytes. */
export type ForeignNode = {
    hash: Uint8Array
    bytes: Uint8Array
    /**
     * A root's media as the caller expects them, as hex: checked against its header,
     * which is what `refs` records.
     */
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

export type ForeignResult =
    { kind: 'stored'; mediaFailed?: string[] } | { kind: 'missing'; hashes: string[] }

/** Bytes from outside that aren't what their hash names: the source's damage. */
export class ForeignDataError extends Error {
    override name = 'ForeignDataError'
}

/** A root above this build's `RECORDS_V`: "Needs a newer version", never damage. */
export class NewerRecordsError extends Error {
    override name = 'NewerRecordsError'
}

/** A root's row before its media are known: `refs` holds the header and kind nodes. */
type PreparedRoot = {
    hash: Uint8Array
    row: Omit<RootRow, 'day'>
    header: Uint8Array
    /** The media its header references, when the header came in the batch. */
    media?: Uint8Array[]
    /** What the caller expected, checked once the header is read. */
    expected?: string[]
}

type PreparedNode = { hash: Uint8Array; row: Omit<NodeRow, 'day'> }

export type PreparedForeign = {
    rows: Map<string, PreparedRoot | PreparedNode>
    chunks: Map<string, VerifiedChunk>
    media: Map<string, BatchMedia & { sha256: Uint8Array }>
}

const decoder = new TextDecoder()

/** The media a header chunk's stored form references, checking the header against v1. */
const mediaOfHeader = (stored: Uint8Array) => {
    const header = JSON.parse(decoder.decode(inflateStrict(stored, CHUNK_CAP))) as unknown
    checkHeader(header)
    return headerMedia(header as RecordValue[])
}

const checkExpected = (root: PreparedRoot, media: readonly Uint8Array[]) => {
    if (root.expected && root.expected.join() !== media.map(toHex).join())
        throw new Error(`Root ${toHex(root.hash)}’s media differ from its header’s`)
}

/** Hashes and checks everything from outside before the transaction. */
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
            const version = rootVersion(json)
            if (version !== undefined && version > RECORDS_V)
                throw new NewerRecordsError(`Root ${toHex(node.hash)} is v${version}`)
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
                    refs: packHashes([header, ...kinds.map(([, hash]) => hash)].map(fromHex16)),
                    size,
                },
                header: fromHex16(header),
                ...(node.media ? { expected: node.media } : {}),
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
    for (const prepared of rows.values()) {
        if (!('header' in prepared)) continue
        const header = chunks.get(toHex(prepared.header))
        if (!header) continue
        prepared.media = mediaOfHeader(header.stored)
        checkExpected(prepared, prepared.media)
    }
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
 * reached from the roots, in the batch or in storage, and the header of each new root, for its
 * media. A stored header whose CRC fails counts as missing, so the page sends it. A root's media
 * may be absent (a BGM the item doesn't carry and storage doesn't hold is normal).
 * Only rows reached from the roots are put.
 */
export const writeForeign = async (
    tx: KvTx,
    prepared: PreparedForeign,
    roots: readonly Uint8Array[],
    day: UseDay,
): Promise<ForeignResult> => {
    const missing: string[] = []
    const seen = new Set<string>()
    const nodeRow = async (hash: Uint8Array) =>
        prepared.rows.get(toHex(hash))?.row ??
        ((await tx.get('nodes', hashKey(hash))) as NodesRow | undefined)
    const hasChunk = async (hash: Uint8Array) =>
        prepared.chunks.has(toHex(hash)) || (await tx.getKey('chunks', hashKey(hash))) !== undefined
    /** A new root's media from its stored header, or undefined when that isn't intact. */
    const storedMedia = async (header: Uint8Array) => {
        const row = (await tx.get('chunks', hashKey(header))) as ChunkRow | undefined
        if (!(row?.bytes instanceof Uint8Array) || !isChunkRowIntact(header, row)) return
        return mediaOfHeader(row.bytes)
    }

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
            const root = prepared.rows.get(hex)
            if (header && root && 'header' in root && !root.media) {
                root.media = await storedMedia(header)
                if (root.media) checkExpected(root, root.media)
                else missing.push(toHex(header))
            } else if (header && !(await hasChunk(header))) missing.push(toHex(header))
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
    for (const [hex, item] of prepared.rows) {
        if (!seen.has(hex)) continue
        const { hash, row } = item
        if ((await tx.getKey('nodes', hashKey(hash))) !== undefined) continue
        let refs = row.refs
        if ('header' in item) {
            // Reached, so its header was read.
            if (!item.media) throw new Error(`Root ${hex} has no media read`)
            refs = packHashes([...unpackHashes(row.refs), ...item.media])
        }
        await tx.put('nodes', { ...row, refs, day }, hashKey(hash))
    }
    const mediaFailed: string[] = []
    for (const item of prepared.media.values()) {
        const key = hashKey(fromHex16(item.hash))
        if ((await tx.getKey('media', key)) !== undefined) continue
        const stored = await tx.tryPut(
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
        if (!stored) mediaFailed.push(item.hash)
    }
    return { kind: 'stored', ...(mediaFailed.length ? { mediaFailed } : {}) }
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
