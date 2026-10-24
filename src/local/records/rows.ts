import { crc32 } from '../../zip/crc32'
import type { UseDay } from '../days'
import { toHex } from '../hash'
import type { RecordValue } from './canonical'
import type { EncodedNode, EncodedRoot } from './snapshot'

// The `nodes` and `chunks` rows of `nse-local-data` v1. Hashes are 16 raw bytes:
// `ArrayBuffer` keys, `Uint8Array` values. `refs` lists a row's direct children only, so GC can
// mark from it without understanding the rest.

/** A root's row: its JSON form is rebuilt from `v`, `refs`' first `1 + kinds.length` hashes, `kinds` and `noteCount`. */
export type RootRow = {
    t: 'root'
    v: number
    kinds: string[]
    noteCount: number
    /** The header chunk, the kind nodes in `kinds` order, then the media the header references. */
    refs: Uint8Array
    /** The canonical bytes' length. */
    size: number
    day: UseDay
}

/** A kind node's row: its JSON form's `hashes` are `refs` in order. */
export type NodeRow = {
    t: 'node'
    kind: string
    depth: 0 | 1
    refs: Uint8Array
    size: number
    day: UseDay
}

export type NodesRow = RootRow | NodeRow

/** A chunk's row: the stored form, the canonical length, and the CRC-32 of the key and stored bytes. */
export type ChunkRow = { bytes: Uint8Array; size: number; crc32: number; day: UseDay }

/**
 * The `day` a stored row holds, or `fallback` when it has none: a row's day is a day of use. Only
 * for a value read from a stored row; it takes any value, so it is not a way to make a `UseDay`.
 */
export const storedDay = (value: unknown, fallback: UseDay): UseDay =>
    Number.isSafeInteger(value) ? (value as UseDay) : fallback

/** Hashes packed as one compact array of 16-byte runs. */
export const packHashes = (hashes: readonly Uint8Array[]) => {
    const packed = new Uint8Array(hashes.length * 16)
    for (const [i, hash] of hashes.entries()) {
        if (hash.length !== 16) throw new TypeError('Unexpected hash length')
        packed.set(hash, i * 16)
    }
    return packed
}

/** The hashes of a packed array, each a compact copy. */
export const unpackHashes = (packed: Uint8Array) => {
    if (packed.length % 16) throw new TypeError('Unexpected packed hashes length')
    const hashes: Uint8Array[] = []
    for (let at = 0; at < packed.length; at += 16) hashes.push(packed.slice(at, at + 16))
    return hashes
}

/** A hash as an `ArrayBuffer` key of exactly 16 bytes (never a larger buffer's view). */
export const hashKey = (hash: Uint8Array): ArrayBuffer => {
    if (hash.length !== 16) throw new TypeError('Unexpected hash length')
    return hash.slice().buffer
}

export const rootRow = (root: EncodedRoot, day: UseDay): RootRow => ({
    t: 'root',
    v: root.v,
    kinds: root.kinds.map(([name]) => name),
    noteCount: root.noteCount,
    refs: packHashes([root.header, ...root.kinds.map(([, hash]) => hash), ...root.media]),
    size: root.bytes.length,
    day,
})

export const nodeRow = (node: EncodedNode, day: UseDay): NodeRow => ({
    t: 'node',
    kind: node.kind,
    depth: node.depth,
    refs: packHashes(node.children),
    size: node.bytes.length,
    day,
})

/** A root row's JSON form, which hashes to its key. */
export const rootJsonFromRow = (row: RootRow): RecordValue[] => {
    const [header, ...rest] = unpackHashes(row.refs).map(toHex)
    if (header === undefined || rest.length < row.kinds.length)
        throw new TypeError('Unexpected short refs')
    return [row.v, header, row.kinds.map((name, i) => [name, rest[i] ?? '']), row.noteCount]
}

/** A kind-node row's JSON form, which hashes to its key. */
export const nodeJsonFromRow = (row: NodeRow): RecordValue[] => [
    row.kind,
    row.depth,
    unpackHashes(row.refs).map(toHex),
]

/** A chunk row's CRC-32: over its 16 key bytes, then its stored bytes. */
export const chunkCrc32 = (key: Uint8Array, bytes: Uint8Array) => crc32(bytes, crc32(key))

/** Whether a chunk row holds what its key names, by its CRC: a value moved under another key fails. */
export const isChunkRowIntact = (key: Uint8Array, row: Pick<ChunkRow, 'bytes' | 'crc32'>) =>
    chunkCrc32(key, row.bytes) === row.crc32
