import { deflateChunk, verifyChunk, type VerifiedChunk } from './chunkVerify'
import { countDayOfUse } from './days'
import { hashKey, readEpoch, readMeta, writeMeta } from './db'
import { fromHex16, hash16, sha256, toHex } from './hash'
import type { KvTx } from './kv/types'
import { putChunk } from './putChunk'
import { nodeRow, rootRow } from './records/rows'
import type { KindName } from './records/schema'
import { buildKindNodes, buildRoot, type EncodedNode, type EncodedRoot } from './records/snapshot'
import { directWaiter, type Waiter } from './scheduler'
import { clampTime, nextTime } from './time'
import type { FlushCommitted } from './worker/flushHooks'

// The storage worker's half of a flush (Part 1 §1.6.2's order of work, §1.6.4 step 2): deflate,
// verify and hash first, then one transaction holding `nse-maint` shared: the epoch and the
// closure check, the head check against the chain record, the puts, the entries, and field-level
// updates of the session row and the chain record. Every read comes before the first write, so
// a flush that finds something missing or its session no longer the head writes nothing.

/** How a session began (§1.6.11.2): Step 3 writes new and import. */
export type SessionOrigin =
    'new' | 'import' | 'nxsp' | 'continued' | 'migrated' | 'journal' | 'replaced'

export type EntryKind =
    'init' | 'continue' | 'edit' | 'undo' | 'redo' | 'restore' | 'save' | 'export' | 'recovered'

/** Entries that make a chain edited (§1.6.11.2's `edited`). */
export const EDITING_KINDS: readonly EntryKind[] = ['edit', 'undo', 'redo', 'restore', 'recovered']

export type SessionView = { scroll: number; zoom: number; group?: number; stage?: number }

export type ChainSummary = {
    title?: string
    artists?: string
    author?: string
    rating?: number
    tags?: string[]
    noteCount: number
}

export type MediaKind = 'bgm' | 'cover' | 'preview'

/** A media item a batch carries: picked or held bytes, stored with the entry first naming it. */
export type BatchMedia = {
    /** The first 16 bytes of `sha256`, as hex: the key and the state's `hash`. */
    hash: string
    bytes: ArrayBuffer
    type: string
    filename?: string
    kind: MediaKind
}

export type BatchEntry = {
    seq: number
    /** Wall-clock time of the action; stored strictly increasing (§1.6.8.7). */
    wall: number
    kind: EntryKind
    label: string
    /** Index into the batch's snapshots. */
    snapshot: number
    dirty: boolean
}

export type BatchSnapshot = {
    /** The header chunk's id in this batch. */
    header: number
    /** Each kind's chunks: an id in this batch, or a stored hash. */
    kinds: { kind: KindName; chunks: (number | Uint8Array)[] }[]
    noteCount: number
    /** The media the header references, as hex: cover, preview and BGM. */
    media: string[]
}

export type FlushBatch = {
    session: { id: string; chainId: string; origin: SessionOrigin; startedAt: number }
    chain: {
        docId: string
        lineageId: string
        sourceName?: string
        /** A fork's old chain: its record is copied by exclusion (§1.6.11.2). */
        forkOf?: string
    }
    appVersion: string
    /** The new chunks' canonical bytes, one after another; `ends` gives each one's end. */
    text: Uint8Array
    ends: number[]
    snapshots: BatchSnapshot[]
    /** Stored hashes this batch reuses, each with the epoch it was last known stored at. */
    reused: { hash: Uint8Array; epoch: number }[]
    entries: BatchEntry[]
    media: BatchMedia[]
    /** Media this tab holds but didn't send (§1.6.8.4's "held"), as hex. */
    held: string[]
    view?: SessionView
    summary: ChainSummary
    durability: 'relaxed' | 'strict'
}

/** What a flush wrote, by row kind, with about 50 bytes of IndexedDB overhead a row (§1.6.8.1). */
export type WriteStats = {
    rows: number
    /** Bytes written, overwrites of the session row and chain record included. */
    bytes: number
    /** Bytes of rows added: the database's growth (§1.9.3). */
    growth: number
    growthByStore: Record<string, number>
    chunks: number
    nodes: number
    entries: number
    rowsByStore: Record<string, number>
    bytesByStore: Record<string, number>
}

export type FlushResult =
    | {
          kind: 'stored'
          epoch: number
          /** Each new chunk's hash, by id. */
          chunks: Uint8Array[]
          /** Each snapshot's root. */
          roots: Uint8Array[]
          lastSeq: number
          /** The media rows this flush put, to read back once committed. */
          putMedia: string[]
          stats: WriteStats
          /** For the post-flush hook, in the worker only: stripped before the reply. */
          committed?: FlushCommitted
      }
    | {
          kind: 'missing'
          epoch: number
          /** Reused chunk hashes no store holds: re-send those windows. */
          chunks: string[]
          /** Media the tab holds that the store lacks: re-send with the bytes. */
          media: string[]
      }
    | { kind: 'notHead'; chainId: string; head: string }

/** A batch's work done before the transaction: chunks verified, nodes and roots hashed. */
export type PreparedFlush = {
    chunks: VerifiedChunk[]
    nodes: EncodedNode[]
    roots: EncodedRoot[]
    /** Carried media by hash, with the full SHA-256 of its bytes. */
    media: Map<string, BatchMedia & { sha256: Uint8Array }>
}

/** A batch the worker refused before writing: a bug in the page's half. */
export class FlushBatchError extends Error {
    override name = 'FlushBatchError'
}

export const FLUSH_STORES = [
    'chains',
    'sessions',
    'entries',
    'nodes',
    'chunks',
    'media',
    'meta',
] as const

/**
 * Deflates, verifies and hashes a batch's new chunks, then builds its kind nodes and roots
 * (§1.6.2's order of work): everything that awaits anything but IndexedDB.
 */
export const prepareFlush = async (
    batch: FlushBatch,
    waiter: Waiter = directWaiter,
): Promise<PreparedFlush> => {
    const chunks: VerifiedChunk[] = []
    let start = 0
    for (const end of batch.ends) {
        const canonical = batch.text.subarray(start, end)
        start = end
        const hash = await waiter.wait(hash16(canonical))
        const stored = deflateChunk(canonical)
        chunks.push(await waiter.wait(verifyChunk({ hash, stored, canonical })))
    }
    const hashOf = (ref: number | Uint8Array) => {
        if (typeof ref !== 'number') return ref
        const chunk = chunks[ref]
        if (!chunk) throw new FlushBatchError(`No chunk ${ref}`)
        return chunk.hash
    }

    const nodes = new Map<string, EncodedNode>()
    const roots: EncodedRoot[] = []
    for (const snapshot of batch.snapshots) {
        const kinds: [KindName, Uint8Array][] = []
        for (const { kind, chunks: refs } of snapshot.kinds) {
            const kindNodes = buildKindNodes(kind, refs.map(hashOf))
            for (const node of kindNodes) nodes.set(toHex(node.hash), node)
            // buildKindNodes returns the top last, and at least one node.
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            kinds.push([kind, kindNodes.at(-1)!.hash])
        }
        roots.push(
            buildRoot(
                hashOf(snapshot.header),
                kinds,
                snapshot.noteCount,
                snapshot.media.map(fromHex16),
            ),
        )
    }

    const media = new Map<string, BatchMedia & { sha256: Uint8Array }>()
    for (const item of batch.media) {
        // Hashed on the page before decoding; checked again here before it can be stored.
        const digest = await waiter.wait(sha256(new Uint8Array(item.bytes)))
        if (toHex(digest.subarray(0, 16)) !== item.hash)
            throw new FlushBatchError('Media bytes do not hash to their hash')
        media.set(item.hash, { ...item, sha256: digest })
    }
    return { chunks, nodes: [...nodes.values()], roots, media }
}

/** Rough bytes of a stored value: its strings, byte arrays, numbers and field names. */
export const rowBytes = (value: unknown): number => {
    if (value === null || value === undefined) return 1
    if (typeof value === 'string') return value.length
    if (typeof value === 'number') return 8
    if (typeof value === 'boolean') return 1
    if (value instanceof Uint8Array) return value.byteLength
    if (value instanceof ArrayBuffer) return value.byteLength
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size
    if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + rowBytes(item), 0)
    if (typeof value === 'object')
        return Object.entries(value).reduce(
            (sum, [key, item]) => sum + key.length + rowBytes(item),
            0,
        )
    return 0
}

/** IndexedDB's own overhead per row, as §1.6.8.1 estimates it. */
export const ROW_OVERHEAD = 50

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** Field-level update: the row as read, with these fields set, unknown fields kept. */
const updated = (row: Row, fields: Row): Row => ({ ...row, ...fields })

/** Gaps between a session's entries counted as active editing. */
export const ACTIVE_GAP_MS = 5 * 60 * 1000

const CHAIN_OWN_FIELDS = ['chainId', 'head', 'updatedAt', 'day', 'deleting', 'appVersion']
const FORK_DROPS = ['file', 'exportTarget', 'exportName', 'edited']

/**
 * A fork's chain record (§1.6.11.2): the old record copied by exclusion, so fields a newer build
 * added carry, without the binding, the Export target, the export name or `edited`.
 */
export const forkRecord = (old: Row | undefined): Row => {
    const record: Row = {}
    if (old)
        for (const [key, value] of Object.entries(old))
            if (!CHAIN_OWN_FIELDS.includes(key) && !FORK_DROPS.includes(key)) record[key] = value
    return record
}

/**
 * The flush's transaction. Reads first: the epoch, the session and its chain (the head check),
 * the closure check over reused hashes when the epoch moved, and the media; any problem returns
 * with nothing written. Then the puts and field-level writes.
 */
export const writeFlush = async (
    tx: KvTx,
    batch: FlushBatch,
    prepared: PreparedFlush,
    { wall = Date.now(), testPoint }: { wall?: number; testPoint?: (name: string) => void } = {},
): Promise<FlushResult> => {
    const epoch = await readEpoch(tx)
    const sessionRow = await tx.get('sessions', batch.session.id)
    const session = isRow(sessionRow) ? sessionRow : undefined
    const chainId = batch.session.chainId
    // A fork moves its stored session to a new chain, made from the old record (§1.3.1).
    const forking = session !== undefined && session.chainId !== chainId
    if (forking && session.chainId !== batch.chain.forkOf)
        throw new FlushBatchError('The session belongs to another chain')
    const chainRow = await tx.get('chains', chainId)
    const chain = isRow(chainRow) ? chainRow : undefined
    // The head check (r12-arch-web L4): another tab continued the chain meanwhile.
    if (chain && chain.head !== batch.session.id)
        return { kind: 'notHead', chainId, head: String(chain.head) }

    // The closure check (§1.6.6): only hashes not known stored at this epoch.
    const missingChunks: string[] = []
    for (const { hash, epoch: known } of batch.reused)
        if (known !== epoch && (await tx.getKey('chunks', hashKey(hash))) === undefined)
            missingChunks.push(toHex(hash))
    const missingMedia: string[] = []
    const mediaToPut: (BatchMedia & { sha256: Uint8Array })[] = []
    const referenced = new Set(prepared.roots.flatMap((root) => root.media.map(toHex)))
    for (const hex of referenced) {
        if ((await tx.getKey('media', hashKey(fromHex16(hex)))) !== undefined) continue
        const carried = prepared.media.get(hex)
        if (carried) mediaToPut.push(carried)
        // Held but not sent: the head's media went missing, so it's stored again (§1.6.4).
        else if (batch.held.includes(hex)) missingMedia.push(hex)
    }
    if (missingChunks.length || missingMedia.length)
        return { kind: 'missing', epoch, chunks: missingChunks, media: missingMedia }

    const forkSource =
        !chain && batch.chain.forkOf !== undefined
            ? await tx.get('chains', batch.chain.forkOf)
            : undefined

    const nodesToPut: EncodedNode[] = []
    for (const node of prepared.nodes)
        if ((await tx.getKey('nodes', hashKey(node.hash))) === undefined) nodesToPut.push(node)
    const rootsToPut = new Map<string, EncodedRoot>()
    for (const root of prepared.roots) {
        const hex = toHex(root.hash)
        if (rootsToPut.has(hex)) continue
        if ((await tx.getKey('nodes', hashKey(root.hash))) === undefined) rootsToPut.set(hex, root)
    }

    // Writes from here on.
    let maxSeen = (await readMeta(tx, 'maxSeenTime')) ?? 0
    const now = nextTime(maxSeen, wall)
    // Times from the page are clamped when more than a day ahead, then made strictly increasing.
    const stamp = (time: number) => (maxSeen = nextTime(maxSeen, clampTime(time, now)))
    const day = await countDayOfUse(tx, now)

    const stats: WriteStats = {
        rows: 0,
        bytes: 0,
        growth: 0,
        growthByStore: {},
        chunks: 0,
        nodes: 0,
        entries: 0,
        rowsByStore: {},
        bytesByStore: {},
    }
    const count = (store: string, value: unknown, key?: unknown, added = true) => {
        const bytes = rowBytes(value) + rowBytes(key) + ROW_OVERHEAD
        stats.rows++
        stats.bytes += bytes
        if (added) {
            stats.growth += bytes
            stats.growthByStore[store] = (stats.growthByStore[store] ?? 0) + bytes
        }
        stats.rowsByStore[store] = (stats.rowsByStore[store] ?? 0) + 1
        stats.bytesByStore[store] = (stats.bytesByStore[store] ?? 0) + bytes
    }

    let ownBytes = 0
    const records: Uint8Array[] = []
    const entryRows: unknown[] = []
    for (const chunk of prepared.chunks) {
        const row = await putChunk(tx, chunk, day)
        if (!row) continue
        records.push(chunk.hash)
        ownBytes += row.bytes.length
        stats.chunks++
        count('chunks', row, chunk.hash)
    }
    for (const node of nodesToPut) {
        const row = nodeRow(node, day)
        await tx.put('nodes', row, hashKey(node.hash))
        records.push(node.hash)
        ownBytes += row.size
        stats.nodes++
        count('nodes', row, node.hash)
    }
    for (const root of rootsToPut.values()) {
        const row = rootRow(root, day)
        await tx.put('nodes', row, hashKey(root.hash))
        records.push(root.hash)
        ownBytes += row.size
        stats.nodes++
        count('nodes', row, root.hash)
    }
    for (const item of mediaToPut) {
        const row = {
            blob: new Blob([item.bytes], item.type ? { type: item.type } : {}),
            sha256: item.sha256,
            size: item.bytes.byteLength,
            type: item.type,
            ...(item.filename === undefined ? {} : { filename: item.filename }),
            kind: item.kind,
            day,
        }
        await tx.put('media', row, hashKey(fromHex16(item.hash)))
        ownBytes += row.size
        count('media', row, item.hash)
    }

    // Entries a kill after commit already stored are skipped: re-sends are idempotent.
    const lastSeq = typeof session?.lastSeq === 'number' ? session.lastSeq : 0
    const startedAt =
        typeof session?.startedAt === 'number' ? session.startedAt : stamp(batch.session.startedAt)
    let updatedAt = typeof session?.updatedAt === 'number' ? session.updatedAt : startedAt
    let newLastSeq = lastSeq
    let written = 0
    let activeMs = typeof session?.activeMs === 'number' ? session.activeMs : 0
    let edited = false
    for (const entry of batch.entries) {
        if (entry.seq <= newLastSeq) continue
        const root = prepared.roots[entry.snapshot]
        if (!root) throw new FlushBatchError(`No snapshot ${entry.snapshot}`)
        const time = stamp(entry.wall)
        if (written || session) activeMs += Math.min(Math.max(time - updatedAt, 0), ACTIVE_GAP_MS)
        const row = {
            sessionId: batch.session.id,
            seq: entry.seq,
            time,
            day,
            kind: entry.kind,
            label: entry.label,
            snapshot: root.hash.slice(),
            noteCount: root.noteCount,
            dirty: entry.dirty,
            kept: true,
        }
        await tx.put('entries', row)
        entryRows.push(row)
        stats.entries++
        count('entries', row)
        updatedAt = time
        newLastSeq = entry.seq
        written++
        if (EDITING_KINDS.includes(entry.kind)) edited = true
    }

    const sessionFields: Row = {
        updatedAt,
        day,
        lastSeq: newLastSeq,
        entryCount: (typeof session?.entryCount === 'number' ? session.entryCount : 0) + written,
        activeMs,
        ownBytes: (typeof session?.ownBytes === 'number' ? session.ownBytes : 0) + ownBytes,
        appVersion: batch.appVersion,
        ...(batch.view ? { view: batch.view } : {}),
    }
    const sessionValue = session
        ? updated(session, { ...sessionFields, ...(forking ? { chainId } : {}) })
        : {
              id: batch.session.id,
              chainId,
              startedAt,
              origin: batch.session.origin,
              ...sessionFields,
          }
    await tx.put('sessions', sessionValue)
    count('sessions', sessionValue, undefined, !session)

    const hasContentAtStart = batch.session.origin !== 'new' && batch.session.origin !== 'continued'
    const chainFields: Row = {
        updatedAt,
        day,
        summary: batch.summary,
        appVersion: batch.appVersion,
        ...(edited ? { edited: true, hasContent: true } : {}),
    }
    const old = isRow(forkSource) ? forkSource : undefined
    const chainValue = chain
        ? updated(chain, chainFields)
        : {
              ...forkRecord(old),
              chainId,
              head: batch.session.id,
              docId: batch.chain.docId,
              lineageId: typeof old?.lineageId === 'string' ? old.lineageId : batch.chain.lineageId,
              ...(batch.chain.sourceName === undefined
                  ? {}
                  : { sourceName: batch.chain.sourceName }),
              ...(hasContentAtStart ? { hasContent: true } : {}),
              ...chainFields,
          }
    await tx.put('chains', chainValue)
    count('chains', chainValue, undefined, !chain)

    await writeMeta(tx, 'maxSeenTime', maxSeen)
    testPoint?.('flush:beforeCommit')

    return {
        kind: 'stored',
        epoch,
        chunks: prepared.chunks.map((chunk) => chunk.hash),
        roots: prepared.roots.map((root) => root.hash),
        lastSeq: newLastSeq,
        putMedia: mediaToPut.map((item) => item.hash),
        stats,
        committed: {
            session: { id: batch.session.id, chainId },
            entries: entryRows,
            stackBlocks: [],
            records,
            media: mediaToPut.map((item) => fromHex16(item.hash)),
            descriptorChanged: !chain,
        },
    }
}
