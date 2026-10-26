import { deflateChunk, verifyChunk } from '../chunkVerify'
import { hashKey } from '../db'
import { equalBytes, fromHex16, hash16, isHash16Hex, toHex } from '../hash'
import type { KvTx } from '../kv/types'
import type { InputChunk } from '../nxsp/build'
import { canonicalBytes, type RecordValue } from '../records/canonical'
import {
    chunkCrc32,
    isChunkRowIntact,
    nodeJsonFromRow,
    rootJsonFromRow,
    type NodesRow,
} from '../records/rows'
import { isNewerRootVersion, isReadableRootVersion } from '../records/unknownValues'
import { ModelError } from './model'

// The bodies a write takes: this tab's pending records first, then the
// database, then for an append its one pinned source. Every body taken from storage is verified
// by the cheapest check that catches a stored copy gone bad: roots and nodes re-encoded and
// hashed, chunks by their key-bound stored CRC (never inflated). A body that's missing or fails is
// damage in storage: the write goes on without it.

/** The storage a write reads and marks: the storage worker's core, or a test's. */
export type SaveStore = {
    read: <T>(stores: readonly string[], fn: (tx: KvTx) => Promise<T>) => Promise<T>
    write: <T>(
        stores: readonly string[],
        fn: (tx: KvTx) => Promise<T>,
        options?: { durability?: 'strict' | 'relaxed' | 'default'; pauseOnFailure?: boolean },
    ) => Promise<T>
}

/** This tab's records not yet flushed: JSON forms by hex hash, chunks as canonical bytes. */
export type PendingRecords = {
    roots: Record<string, readonly RecordValue[]>
    nodes: Record<string, readonly RecordValue[]>
    chunks: Record<string, Uint8Array>
}

/** What the file already holds, for an append: its parts' keys. */
export type SourceKeys = { roots: Set<string>; nodes: Set<string>; chunks: Set<string> }

export type Bodies = {
    roots: Map<string, readonly RecordValue[]>
    nodes: Map<string, readonly RecordValue[]>
    chunks: Map<string, InputChunk>
    /** Roots whose every node and chunk the write holds (here or in the source). */
    complete: Set<string>
    /** Hashes missing from storage or failing their check: damage in storage. */
    bad: Set<string>
}

/** Keys read in one transaction. */
const BATCH = 512

const readRows = async (store: SaveStore, name: 'nodes' | 'chunks', keys: readonly string[]) => {
    const rows = new Map<string, unknown>()
    for (let at = 0; at < keys.length; at += BATCH) {
        const batch = keys.slice(at, at + BATCH)
        const values = await store.read([name], async (tx) => {
            const out: unknown[] = []
            for (const key of batch) out.push(await tx.get(name, hashKey(fromHex16(key))))
            return out
        })
        batch.forEach((key, i) => rows.set(key, values[i]))
    }
    return rows
}

const hashesTo = async (json: readonly RecordValue[], hex: string) =>
    equalBytes(await hash16(canonicalBytes(json)), fromHex16(hex))

const parse = <T>(fn: () => T) => {
    try {
        return fn()
    } catch {
        return undefined
    }
}

/** Pending records checked as storage's are: roots and nodes hashed, chunks hashed and deflated. */
const verifyPending = async (pending: PendingRecords | undefined, bodies: Bodies) => {
    if (!pending) return
    for (const [hex, json] of Object.entries(pending.roots))
        if (await hashesTo(json, hex)) bodies.roots.set(hex, json)
    for (const [hex, json] of Object.entries(pending.nodes))
        if (await hashesTo(json, hex)) bodies.nodes.set(hex, json)
    for (const [hex, canonical] of Object.entries(pending.chunks)) {
        const hash = fromHex16(hex)
        if (!equalBytes(await hash16(canonical), hash)) continue
        // The same check every chunk put has: the stored form inflates to the bytes hashed.
        const chunk = await verifyChunk({ hash, stored: deflateChunk(canonical), canonical })
        bodies.chunks.set(hex, {
            stored: chunk.stored,
            crc32: chunkCrc32(hash, chunk.stored),
            size: chunk.size,
        })
    }
}

/** A root's nodes and chunks by its JSON form: `[v, header, [[kind, node]…], noteCount]`. */
const rootParts = (json: readonly RecordValue[]) => {
    const header = json[1]
    const kinds = json[2]
    if (!isHash16Hex(header) || !Array.isArray(kinds)) return
    const nodes: string[] = []
    for (const kind of kinds as readonly RecordValue[]) {
        const node = Array.isArray(kind) ? (kind as RecordValue[])[1] : undefined
        if (!isHash16Hex(node)) return
        nodes.push(node)
    }
    return { header, nodes }
}

const nodeChildren = (json: readonly RecordValue[]) => {
    const depth = json[1]
    const children = json[2]
    if ((depth !== 0 && depth !== 1) || !Array.isArray(children)) return
    if (!(children as RecordValue[]).every(isHash16Hex)) return
    return { depth, children: children as string[] }
}

/**
 * Loads and verifies the bodies of `wanted` roots: from `pending`, then storage, skipping what
 * the append source holds. A root `v` above this build's is a refusal (`needsNewer`), never
 * filtered.
 */
export const loadBodies = async (
    store: SaveStore,
    wanted: Iterable<string>,
    { pending, source }: { pending?: PendingRecords; source?: SourceKeys } = {},
): Promise<Bodies> => {
    const bodies: Bodies = {
        roots: new Map(),
        nodes: new Map(),
        chunks: new Map(),
        complete: new Set(),
        bad: new Set(),
    }
    await verifyPending(pending, bodies)
    const inSource = (kind: keyof SourceKeys, hex: string) => source?.[kind].has(hex) ?? false

    const rootList = [...new Set(wanted)].filter(
        (hex) => !inSource('roots', hex) && !bodies.roots.has(hex),
    )
    for (const [hex, row] of await readRows(store, 'nodes', rootList)) {
        const value = row as NodesRow | undefined
        if (value?.t !== 'root') {
            bodies.bad.add(hex)
            continue
        }
        if (!isReadableRootVersion(value.v)) {
            // Newer is "Needs a newer version"; an older or malformed `v` is bad, as open and peek say.
            if (isNewerRootVersion(value.v)) throw new ModelError('needsNewer')
            bodies.bad.add(hex)
            continue
        }
        const json = parse(() => rootJsonFromRow(value))
        if (json && (await hashesTo(json, hex))) bodies.roots.set(hex, json)
        else bodies.bad.add(hex)
    }

    // Nodes, two levels at most, then chunks; each read once.
    const needNode = (hex: string) =>
        !inSource('nodes', hex) && !bodies.nodes.has(hex) && !bodies.bad.has(hex)
    const needChunk = (hex: string) =>
        !inSource('chunks', hex) && !bodies.chunks.has(hex) && !bodies.bad.has(hex)
    const loadNodes = async (keys: Iterable<string>) => {
        const list = [...new Set(keys)].filter(needNode)
        for (const [hex, row] of await readRows(store, 'nodes', list)) {
            const value = row as NodesRow | undefined
            const json = value?.t === 'node' ? parse(() => nodeJsonFromRow(value)) : undefined
            if (json && (await hashesTo(json, hex))) bodies.nodes.set(hex, json)
            else bodies.bad.add(hex)
        }
    }
    const tops: string[] = []
    const chunkKeys: string[] = []
    for (const json of bodies.roots.values()) {
        const parts = rootParts(json)
        if (!parts) continue
        chunkKeys.push(parts.header)
        tops.push(...parts.nodes)
    }
    await loadNodes(tops)
    const leaves: string[] = []
    for (const hex of tops) {
        const json = bodies.nodes.get(hex)
        const node = json && nodeChildren(json)
        if (!node) continue
        if (node.depth === 0) chunkKeys.push(...node.children)
        else leaves.push(...node.children)
    }
    await loadNodes(leaves)
    for (const hex of leaves) {
        const json = bodies.nodes.get(hex)
        const node = json && nodeChildren(json)
        if (node?.depth === 0) chunkKeys.push(...node.children)
    }
    const chunkList = [...new Set(chunkKeys)].filter(needChunk)
    for (const [hex, row] of await readRows(store, 'chunks', chunkList)) {
        const value = row as { bytes?: unknown; crc32?: unknown; size?: unknown } | undefined
        if (
            value?.bytes instanceof Uint8Array &&
            typeof value.crc32 === 'number' &&
            typeof value.size === 'number' &&
            isChunkRowIntact(fromHex16(hex), { bytes: value.bytes, crc32: value.crc32 })
        )
            bodies.chunks.set(hex, { stored: value.bytes, crc32: value.crc32, size: value.size })
        else bodies.bad.add(hex)
    }

    // Which roots are whole: every node and chunk here or in the source.
    const hasNode = (hex: string) => bodies.nodes.has(hex) || inSource('nodes', hex)
    const hasChunk = (hex: string) => bodies.chunks.has(hex) || inSource('chunks', hex)
    const nodeWhole = (hex: string, depth: number): boolean => {
        if (inSource('nodes', hex)) return true
        const json = bodies.nodes.get(hex)
        const node = json && nodeChildren(json)
        if (!node || (depth === 1 && node.depth !== 0)) return false
        return node.depth === 0
            ? node.children.every(hasChunk)
            : node.children.every((child) => hasNode(child) && nodeWhole(child, 1))
    }
    for (const [hex, json] of bodies.roots) {
        const parts = rootParts(json)
        if (parts && hasChunk(parts.header) && parts.nodes.every((node) => nodeWhole(node, 0)))
            bodies.complete.add(hex)
    }
    if (source) for (const hex of source.roots) bodies.complete.add(hex)
    return bodies
}

/**
 * Every node and chunk hash `roots` reach in storage, read from the root and node rows alone (no
 * chunk is read or verified): what a state needs, for a check that names known damage. A
 * root or node that doesn't read reaches nothing further.
 */
export const reachedHashes = async (store: SaveStore, roots: Iterable<string>) => {
    const reached = new Set<string>()
    const rootList = [...new Set(roots)]
    let nodes: string[] = []
    for (const [, row] of await readRows(store, 'nodes', rootList)) {
        const value = row as NodesRow | undefined
        const json = value?.t === 'root' ? parse(() => rootJsonFromRow(value)) : undefined
        const parts = json && rootParts(json)
        if (!parts) continue
        reached.add(parts.header)
        nodes.push(...parts.nodes)
    }
    // Two levels of nodes at most, as `loadBodies` reads them.
    for (let level = 0; level < 2 && nodes.length; level++) {
        const list = [...new Set(nodes)].filter((hex) => !reached.has(hex))
        nodes = []
        for (const hex of list) reached.add(hex)
        for (const [, row] of await readRows(store, 'nodes', list)) {
            const value = row as NodesRow | undefined
            const json = value?.t === 'node' ? parse(() => nodeJsonFromRow(value)) : undefined
            const node = json && nodeChildren(json)
            if (!node) continue
            if (node.depth === 0) for (const child of node.children) reached.add(child)
            else nodes.push(...node.children)
        }
    }
    return reached
}

/**
 * Which of `hashes` storage still holds bad or not at all: a chunk row failing its key-bound CRC,
 * or a root or node row that doesn't hash to its key. A body stored again since is no longer bad.
 */
export const stillBad = async (store: SaveStore, hashes: readonly string[]) => {
    const chunks = await readRows(store, 'chunks', hashes)
    const nodes = await readRows(store, 'nodes', hashes)
    const bad = new Set<string>()
    for (const hex of hashes) {
        const chunk = chunks.get(hex) as
            { bytes?: unknown; crc32?: unknown; size?: unknown } | undefined
        if (
            chunk?.bytes instanceof Uint8Array &&
            typeof chunk.crc32 === 'number' &&
            typeof chunk.size === 'number' &&
            isChunkRowIntact(fromHex16(hex), { bytes: chunk.bytes, crc32: chunk.crc32 })
        )
            continue
        const node = nodes.get(hex) as NodesRow | undefined
        const json =
            node?.t === 'root'
                ? parse(() => rootJsonFromRow(node))
                : node?.t === 'node'
                  ? parse(() => nodeJsonFromRow(node))
                  : undefined
        if (json && (await hashesTo(json, hex))) continue
        bad.add(hex)
    }
    return bad
}

/**
 * Adds to `into` each of `roots` that `from` holds whole, with the nodes and chunks it reaches
 * (those the source holds stay out). The rest are left out, never counted as damage.
 */
export const takeWhole = (into: Bodies, from: Bodies, roots: Iterable<string>) => {
    const takeNode = (hex: string) => {
        const json = from.nodes.get(hex)
        if (!json) return
        into.nodes.set(hex, json)
        const node = nodeChildren(json)
        for (const child of node?.children ?? []) {
            if (node?.depth === 0) {
                const chunk = from.chunks.get(child)
                if (chunk) into.chunks.set(child, chunk)
            } else takeNode(child)
        }
    }
    for (const hex of roots) {
        const json = from.roots.get(hex)
        const parts = json && rootParts(json)
        if (!json || !parts || !from.complete.has(hex) || into.roots.has(hex)) continue
        into.roots.set(hex, json)
        const header = from.chunks.get(parts.header)
        if (header) into.chunks.set(parts.header, header)
        parts.nodes.forEach(takeNode)
        into.complete.add(hex)
    }
}

/** Whether a root is whole for this write, by hex. */
export const isWhole = (bodies: Bodies, snapshot: Uint8Array | string) =>
    bodies.complete.has(typeof snapshot === 'string' ? snapshot : toHex(snapshot))
