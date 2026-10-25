import { inflateStrict } from '../chunkVerify'
import { hashKey } from '../db'
import { equalBytes, fromHex16, hash16, isHash16Hex, toHex } from '../hash'
import { snapshotFromOpened } from '../open/opened'
import { canonicalBytes, type RecordValue } from '../records/canonical'
import { nodeJsonFromRow, rootJsonFromRow, type NodesRow } from '../records/rows'
import { isNewerRootVersion, isReadableRootVersion } from '../records/unknownValues'
import type { SnapshotParts } from './flushHandlers'
import type { WorkerContext } from './handlers'

// Peek's reads: a History entry's row, and a snapshot verified, so the
// page can build the entry's state. Rows are read in one transaction; hashing waits until it
// has ended, since an await on anything else would end it early.

/** An entry's row as peek reads it. */
export type EntryInfo = { time: number; snapshot: string; kept: boolean }

/**
 * A snapshot read for peek: `missing` when its root is gone, `damaged` when a part is, `newer`
 * when a newer build wrote its root (a `v` above this build's: never damage).
 */
export type SnapshotRead =
    | { kind: 'missing' }
    | { kind: 'damaged' }
    | { kind: 'newer' }
    | { kind: 'found'; parts: SnapshotParts }

type EntryRow = { time?: unknown; snapshot?: unknown; kept?: unknown }

const decoder = new TextDecoder()

/** A row's parsed form; undefined when it's malformed, so the read reports `damaged`. */
const parsed = <T>(parse: () => T) => {
    try {
        return parse()
    } catch {
        return undefined
    }
}

export const peekHandlers = (context: WorkerContext) => ({
    /** An entry's time and snapshot; undefined when there's no such entry. */
    readEntry: ({ sessionId, seq }: { sessionId: string; seq: number }) =>
        context.core.read(['entries'], async (tx): Promise<EntryInfo | undefined> => {
            const row = (await tx.get('entries', [sessionId, seq])) as EntryRow | undefined
            if (!row || !(row.snapshot instanceof Uint8Array) || typeof row.time !== 'number')
                return
            return { time: row.time, snapshot: toHex(row.snapshot), kept: row.kept !== false }
        }),

    /**
     * A snapshot's root, nodes and chunks, each checked against its hash; one an open's import
     * hasn't stored whole yet is read from the file this worker opened.
     */
    readSnapshotVerified: async (hex: string): Promise<SnapshotRead> => {
        const stored = await readVerified(context, hex)
        if (stored.kind === 'found') return stored
        const parts = await snapshotFromOpened(hex)
        return parts ? { kind: 'found', parts } : stored
    },
})

/** A stored snapshot, verified. */
const readVerified = async (context: WorkerContext, hex: string): Promise<SnapshotRead> => {
    if (!isHash16Hex(hex)) return { kind: 'missing' }
    const read = await context.core.read(['nodes', 'chunks'], async (tx) => {
        const rootRow = (await tx.get('nodes', hashKey(fromHex16(hex)))) as NodesRow | undefined
        if (rootRow?.t !== 'root') return
        // Before it is decoded: a root of a newer `v` fails the schema, but it is not damaged.
        if (!isReadableRootVersion(rootRow.v))
            return isNewerRootVersion(rootRow.v) ? 'newer' : 'damaged'
        const root = parsed(() => rootJsonFromRow(rootRow))
        const header = root?.[1]
        const kinds = root?.[2]
        if (
            !root ||
            !isHash16Hex(header) ||
            !Array.isArray(kinds) ||
            !kinds.every((kind) => Array.isArray(kind) && isHash16Hex(kind[1]))
        )
            return 'damaged'
        const nodes: Record<string, RecordValue[]> = {}
        const chunks: Record<string, Uint8Array> = {}
        let complete = true
        const chunk = async (key: string) => {
            const found = (await tx.get('chunks', hashKey(fromHex16(key)))) as
                { bytes?: unknown } | undefined
            if (found?.bytes instanceof Uint8Array) chunks[key] = found.bytes
            else complete = false
        }
        const node = async (key: string) => {
            const found = (await tx.get('nodes', hashKey(fromHex16(key)))) as NodesRow | undefined
            const json = found?.t === 'node' ? parsed(() => nodeJsonFromRow(found)) : undefined
            const children = json?.[2]
            if (
                found?.t !== 'node' ||
                !json ||
                !Array.isArray(children) ||
                !children.every(isHash16Hex)
            ) {
                complete = false
                return
            }
            nodes[key] = json
            for (const child of children) await (found.depth === 1 ? node(child) : chunk(child))
        }
        await chunk(header)
        for (const [, top] of kinds as [unknown, string][]) await node(top)
        return { root, nodes, chunks, complete }
    })
    if (!read) return { kind: 'missing' }
    if (read === 'newer') return { kind: 'newer' }
    if (read === 'damaged' || !read.complete) return { kind: 'damaged' }
    // Every part hashes to its key: the root and nodes by their JSON form, chunks inflated.
    try {
        if (!equalBytes(await hash16(canonicalBytes(read.root)), fromHex16(hex)))
            return { kind: 'damaged' }
        for (const [key, json] of Object.entries(read.nodes))
            if (!equalBytes(await hash16(canonicalBytes(json)), fromHex16(key)))
                return { kind: 'damaged' }
        const parts: SnapshotParts = { root: read.root, nodes: read.nodes, chunks: {} }
        for (const [key, bytes] of Object.entries(read.chunks)) {
            const inflated = inflateStrict(bytes)
            if (!equalBytes(await hash16(inflated), fromHex16(key))) return { kind: 'damaged' }
            parts.chunks[key] = JSON.parse(decoder.decode(inflated))
        }
        return { kind: 'found', parts }
    } catch {
        return { kind: 'damaged' }
    }
}
