import { fromHex16, hash16Sync, toHex } from '../hash'
import { canonicalBytes, type RecordValue } from './canonical'
import { noteCountOf, recordKey, type KindRecords, type SnapshotRecords } from './records'
import {
    checkHeader,
    checkRecord,
    checkRefs,
    headerIds,
    kindNames,
    kindRecords,
    SchemaError,
    type KindName,
} from './schema'
import { groupChunks, splitKind } from './split'
import { RECORDS_V } from './version'

// A snapshot is a tree of records: one root, one kind node (or a two-level group)
// per kind with records, one header chunk and the body chunks. A record's hash is SHA-256 of
// its canonical bytes, first 16 bytes; the stored form of chunks is raw DEFLATE (`chunkVerify.ts`).

type Rec = readonly RecordValue[]

/** A record with its canonical bytes and hash. */
export type Encoded = { readonly json: Rec; readonly bytes: Uint8Array; readonly hash: Uint8Array }

/** A chunk: the header chunk, or one of a kind's body chunks. */
export type EncodedChunk = Encoded & { readonly kind: KindName | 'header' }

export type EncodedNode = Encoded & {
    readonly kind: KindName
    readonly depth: 0 | 1
    /** Its chunks (depth 0) or depth-0 nodes (depth 1), in order. */
    readonly children: readonly Uint8Array[]
}

export type EncodedRoot = Encoded & {
    readonly v: number
    readonly header: Uint8Array
    /** Each kind with records and the node its entry names, in the v1 kind order. */
    readonly kinds: readonly (readonly [KindName, Uint8Array])[]
    readonly noteCount: number
    /** The media the header references: cover, preview and BGM, each hash once. */
    readonly media: readonly Uint8Array[]
}

export type EncodedSnapshot = {
    readonly root: EncodedRoot
    readonly header: EncodedChunk
    /** Body chunks, kind by kind in key order. */
    readonly chunks: readonly EncodedChunk[]
    /** Kind nodes, each kind's depth-0 nodes before its depth-1 node. */
    readonly nodes: readonly EncodedNode[]
}

/** Each kind's chunks as JSON forms, before hashing: what the worker deflates and hashes. */
export type ChunkPlan = { header: Rec; kinds: { kind: KindName; chunks: Rec[] }[] }

export const planChunks = (records: SnapshotRecords): ChunkPlan => ({
    header: records.header,
    kinds: records.kinds.map(({ kind, records }) => ({
        kind,
        chunks: splitKind(kind, records).map((chunk) => chunk.map(({ record }) => record)),
    })),
})

const encode = (json: Rec, hash: (bytes: Uint8Array) => Uint8Array) => {
    const bytes = canonicalBytes(json)
    return { json, bytes, hash: hash(bytes) }
}

export const nodeRecord = (kind: KindName, depth: 0 | 1, hashes: readonly Uint8Array[]): Rec => [
    kind,
    depth,
    hashes.map(toHex),
]

export const rootRecord = (
    v: number,
    header: Uint8Array,
    kinds: readonly (readonly [KindName, Uint8Array])[],
    noteCount: number,
): Rec => [v, toHex(header), kinds.map(([name, hash]) => [name, toHex(hash)]), noteCount]

/**
 * A kind's nodes over its chunk hashes: a depth-0 node for at most 16 chunks,
 * otherwise a depth-1 node over depth-0 nodes of 16 consecutive chunks each. The last is the top.
 */
export const buildKindNodes = (
    kind: KindName,
    chunkHashes: readonly Uint8Array[],
    hash: (bytes: Uint8Array) => Uint8Array = hash16Sync,
): EncodedNode[] => {
    const node = (depth: 0 | 1, children: readonly Uint8Array[]): EncodedNode => ({
        ...encode(nodeRecord(kind, depth, children), hash),
        kind,
        depth,
        children,
    })
    if (chunkHashes.length <= 16) return [node(0, chunkHashes)]
    const leaves = groupChunks(chunkHashes).map((group) => node(0, group))
    return [
        ...leaves,
        node(
            1,
            leaves.map((leaf) => leaf.hash),
        ),
    ]
}

const mediaRefHash = (value: RecordValue | undefined) => {
    const hash = (value as Rec | undefined)?.[0]
    return typeof hash === 'string' ? hash : undefined
}

/** The media a header references, in `refs` order: cover, preview and BGM, each hash once. */
export const headerMedia = (header: Rec): Uint8Array[] => {
    const levelInfo = header[7] as Rec
    const hashes = [mediaRefHash(levelInfo[5]), mediaRefHash(levelInfo[6]), mediaRefHash(header[8])]
    return [...new Set(hashes.filter((hash) => hash !== undefined))].map(fromHex16)
}

export const buildRoot = (
    header: Uint8Array,
    kinds: readonly (readonly [KindName, Uint8Array])[],
    noteCount: number,
    media: readonly Uint8Array[],
    hash: (bytes: Uint8Array) => Uint8Array = hash16Sync,
): EncodedRoot => ({
    ...encode(rootRecord(RECORDS_V, header, kinds, noteCount), hash),
    v: RECORDS_V,
    header,
    kinds,
    noteCount,
    media,
})

/** A whole snapshot, hashed synchronously: for tests, goldens and small states. */
export const encodeSnapshot = (records: SnapshotRecords): EncodedSnapshot => {
    const plan = planChunks(records)
    const header: EncodedChunk = { ...encode(plan.header, hash16Sync), kind: 'header' }
    const chunks: EncodedChunk[] = []
    const nodes: EncodedNode[] = []
    const kinds: [KindName, Uint8Array][] = []
    for (const { kind, chunks: forms } of plan.kinds) {
        const encoded = forms.map((json): EncodedChunk => ({ ...encode(json, hash16Sync), kind }))
        chunks.push(...encoded)
        const kindNodes = buildKindNodes(
            kind,
            encoded.map((chunk) => chunk.hash),
        )
        nodes.push(...kindNodes)
        // `buildKindNodes` always returns at least one node, the top last.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        kinds.push([kind, kindNodes.at(-1)!.hash])
    }
    const root = buildRoot(header.hash, kinds, noteCountOf(records.kinds), headerMedia(plan.header))
    return { root, header, chunks, nodes }
}

/** A root's `v`, read before anything else; `undefined` when it has none. */
export const rootVersion = (json: unknown) => {
    const v = Array.isArray(json) ? (json[0] as unknown) : undefined
    return Number.isSafeInteger(v) ? (v as number) : undefined
}

/**
 * Checks a v1 root: its form, and `kinds` in the v1 kind order with no name
 * twice. A root whose `v` is above `RECORDS_V` is newer, never invalid: check `rootVersion` first.
 */
export const checkRoot = (json: unknown): void => {
    checkRecord('root', json)
    const root = json as Rec
    if (root[0] !== RECORDS_V) throw new SchemaError('root.v', `expected ${RECORDS_V}`)
    let last = -1
    for (const [i, [name]] of (root[2] as Rec[]).entries()) {
        const at = kindNames.indexOf(name as KindName)
        if (at <= last) throw new SchemaError(`root.kinds[${i}]`, 'out of the v1 kind order')
        last = at
    }
}

/** Checks a kind node: its form, the kind and depth it must have, and a depth of 0 or 1. */
export const checkNode = (json: unknown, kind: KindName, depth?: 0 | 1): void => {
    checkRecord('node', json)
    const node = json as Rec
    if (node[0] !== kind) throw new SchemaError('node.kind', `expected ${kind}`)
    if (node[1] !== 0 && node[1] !== 1) throw new SchemaError('node.depth', 'expected 0 or 1')
    if (depth !== undefined && node[1] !== depth)
        throw new SchemaError('node.depth', `expected ${depth}`)
}

/** Where a decode reads parsed, verified records by their hashes' hex form. */
export type SnapshotSource = {
    node: (hash: string) => unknown
    chunk: (hash: string) => unknown
}

/**
 * A snapshot's records from its root, checking every root, node and record
 * against the v1 schema, every group, stage and folder a record names against the header,
 * and `noteCount` against the slides. Readers never assume the split; an empty body chunk
 * reads as no records.
 */
export const decodeSnapshot = (rootJson: unknown, source: SnapshotSource): SnapshotRecords => {
    checkRoot(rootJson)
    const [, headerHash, kindRefs, noteCount] = rootJson as [
        number,
        string,
        [KindName, string][],
        number,
    ]
    const header = source.chunk(headerHash)
    checkHeader(header)
    const ids = headerIds(header as Rec)

    const kinds: KindRecords[] = []
    for (const [kind, top] of kindRefs) {
        const topNode = source.node(top)
        checkNode(topNode, kind)
        const [, depth, children] = topNode as [KindName, 0 | 1, string[]]
        const chunkHashes =
            depth === 0
                ? children
                : children.flatMap((hash) => {
                      const leaf = source.node(hash)
                      checkNode(leaf, kind, 0)
                      return (leaf as [KindName, 0, string[]])[2]
                  })
        const form = kindRecords[kind]
        const records = chunkHashes.flatMap((hash, i) => {
            const chunk = source.chunk(hash)
            if (!Array.isArray(chunk)) throw new SchemaError(`${kind}[${i}]`, 'expected an array')
            return (chunk as unknown[]).map((record, j) => {
                checkRecord(form, record, `${kind}[${i}][${j}]`)
                checkRefs(form, record, ids, `${kind}[${i}][${j}]`)
                return { key: recordKey(kind, record as Rec), record: record as Rec }
            })
        })
        kinds.push({ kind, records })
    }

    const records = { header: header as Rec, kinds }
    if (noteCountOf(kinds) !== noteCount)
        throw new SchemaError('root.noteCount', `expected ${noteCountOf(kinds)}`)
    return records
}
