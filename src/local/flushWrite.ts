import {
    captureEntryDescription,
    captureStep,
    type EntryDescription,
    type HistoryEntryKind,
    type UndoableStep,
} from '../history/operations'
import { forkRecord } from './chainFields'
import { deflateChunk, verifyChunk, type VerifiedChunk } from './chunkVerify'
import { countDayOfUse } from './days'
import { hashKey, readEpoch, readMeta, writeMeta } from './db'
import { splitHandles } from './handleRows'
import { equalBytes, fromHex16, hash16, sha256, toHex } from './hash'
import { KeyRange, type KvTx } from './kv/types'
import { putChunk } from './putChunk'
import { nodeRow, rootRow, type NodesRow } from './records/rows'
import type { KindName } from './records/schema'
import { buildKindNodes, buildRoot, type EncodedNode, type EncodedRoot } from './records/snapshot'
import { isReadableSessionVersion } from './records/unknownValues'
import { SESSION_V } from './records/version'
import {
    clearIdentityExport,
    marksHaveSupportedSessions,
    sessionVersionReader,
    storeMarks,
    unitApplies,
    type IdentityUnit,
} from './save/commit'
import { directWaiter, type Waiter } from './scheduler'
import { clampTime, nextTime } from './time'
import {
    blockRow,
    EDITING_KINDS as TIMELINE_EDITING_KINDS,
    windowBlocks,
    type ReplaySlot,
    type StackWindow,
} from './timeline'
import type { FlushCommitted } from './worker/flushHooks'

export { forkRecord } from './chainFields'

// The storage worker's half of a flush (Part 1 §1.6.2's order of work, §1.6.4 step 2): deflate,
// verify and hash first, then one transaction holding `nse-maint` shared: the epoch and the
// closure check, the head check against the chain record, the puts, the entries, and field-level
// updates of the session row and the chain record. Every read comes before the first write, so
// a flush that finds something missing or its session no longer the head writes nothing.

/** How a session began (§1.6.11.2): Step 3 writes new and import. */
export type SessionOrigin =
    'new' | 'import' | 'nxsp' | 'continued' | 'migrated' | 'journal' | 'replaced'

export type EntryKind = HistoryEntryKind

/** Entries that make a chain edited (§1.6.11.2's `edited`). */
export const EDITING_KINDS = TIMELINE_EDITING_KINDS as readonly EntryKind[]

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

export type BatchEntry = EntryDescription & {
    seq: number
    /** Wall-clock time of the action; stored strictly increasing (§1.6.8.7). */
    wall: number
    /** Index into the batch's snapshots, or a stored root: an undo or redo onto a slot not loaded. */
    snapshot: number | Uint8Array
    dirty: boolean
    stack?: {
        keep: number
        push: { snapshot: number | Uint8Array; step: UndoableStep }[]
        index: number
    }
    /** A `save` entry's revision, device and writer's app version (§1.6.11.2). */
    revisionId?: string
    device?: { id: string; label: string }
    appVersion?: string
}

/** A stack block a batch rewrites (§1.6.4 #6): each slot a snapshot of the batch or a stored root. */
export type BatchBlock = {
    block: number
    first: number
    slots: (number | Uint8Array)[]
    steps: UndoableStep[]
}

/**
 * The stack after the batch's last entry: its window and the blocks that changed, or with `full`
 * every block of the window. `at` is where the page's stored slots and blocks were stored.
 */
export type BatchStack = StackWindow & { blocks: BatchBlock[]; full: boolean; at?: KnownAt }

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
    session: {
        id: string
        chainId: string
        origin: SessionOrigin
        startedAt: number
        /** The stored session this one continues, written with its first flush (D10). */
        parent?: { id: string; uptoSeq: number }
    }
    chain: {
        docId: string
        lineageId: string
        sourceName?: string
        /** A fork's old chain: its record is copied by exclusion (§1.6.11.2). */
        forkOf?: string
        /** A fork's name, "<name> (2)" (§1.3.1), set on the record it makes. */
        name?: string
        /**
         * Chain fields this session set before its first write (a rename, Export's target):
         * written with the record, `null` removing a field.
         */
        set?: Record<string, unknown>
    }
    appVersion: string
    /** The new chunks' canonical bytes, one after another; `ends` gives each one's end. */
    text: Uint8Array
    ends: number[]
    snapshots: BatchSnapshot[]
    /** Stored hashes this batch reuses, each with where it was last known stored (§1.6.6). */
    reused: { hash: Uint8Array; known?: KnownAt }[]
    entries: BatchEntry[]
    media: BatchMedia[]
    /** Media this tab holds but didn't send (§1.6.8.4's "held"), as hex. */
    held: string[]
    /** Carried media an earlier flush sent without a reply: read back even when found stored. */
    unconfirmed?: string[]
    view?: SessionView
    /** Absent when the head isn't one of the batch's states (an undo onto a slot not loaded). */
    summary?: ChainSummary
    /** The stack after the last entry; absent when the page couldn't follow its entries. */
    stack?: BatchStack
    /**
     * A Save's identity unit (§1.3.2), committed with its marks after the entries, the `save`
     * entry among them or stored before (`storeMarks`); left in memory when a mark can't be stored.
     */
    identity?: IdentityUnit
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

/**
 * Where a hash was last known stored: the database (`meta.dbInstanceId`) and its epoch. A hash
 * known in another database, as after Try Again's move or a worker restart over a new in-memory
 * store, is checked again like one known at an older epoch.
 */
export type KnownAt = { db: string; epoch: number }

export type FlushResult =
    | {
          kind: 'stored'
          known: KnownAt
          /** Each new chunk's hash, by id. */
          chunks: Uint8Array[]
          /** Each snapshot's root. */
          roots: Uint8Array[]
          lastSeq: number
          /** Carried media put now, or found there after an unanswered flush: each read back. */
          readBack: string[]
          /**
           * False when the batch didn't write the session's last entry (a re-send of stored
           * entries), which left the stored stack alone, or when its stack couldn't be used.
           */
          stackWritten: boolean
          /**
           * The batch wrote the session's last entry without a stack it could use: the stored
           * stack was removed rather than left behind `lastSeq` (§1.3.9: replay rebuilds it).
           */
          stackRemoved?: boolean
          /** The chain record as written, for the journal's descriptor (§1.6.11.3). */
          chain: Record<string, unknown>
          /** Whether the batch's identity unit was stored. */
          identity?: boolean
          /** The batch's identity unit was dropped: its binding was taken over meanwhile. */
          staleIdentity?: true
          /**
           * Media refused by the put or that didn't read back right: the entries are stored, the
           * media is not (§1.6.8.4).
           */
          mediaFailed?: string[]
          stats: WriteStats
          /** Stored in memory only (storage unavailable): set by the worker's reply. */
          memory?: boolean
          /** In memory, and no database will answer in this tab: Try Again has nothing to ask. */
          noDatabase?: boolean
          /** For the post-flush hook, in the worker only: stripped before the reply. */
          committed?: FlushCommitted
      }
    | {
          kind: 'missing'
          known: KnownAt
          /** Reused chunk hashes no store holds: re-send those windows. */
          chunks: string[]
          /** Media the tab holds that the store lacks: re-send with the bytes. */
          media: string[]
      }
    | {
          /**
           * The batch's stack leaves blocks alone that the page knows stored in another store
           * (after Try Again's move, or a restart): nothing is written, and the page plans the
           * whole window again.
           */
          kind: 'stackWhole'
          known: KnownAt
      }
    | {
          kind: 'notHead'
          chainId: string
          head: string
          /** The stored session's last entry; undefined when nothing of it is stored. */
          lastSeq?: number
      }

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
    'stackBlocks',
    'nodes',
    'chunks',
    'media',
    'meta',
    'handles',
] as const

/**
 * Deflates, verifies and hashes a batch's new chunks, then builds its kind nodes and roots
 * (§1.6.2's order of work): everything that awaits anything but IndexedDB.
 */
export const prepareFlush = async (
    batch: FlushBatch,
    waiter: Waiter = directWaiter,
): Promise<PreparedFlush> => {
    for (const entry of batch.entries) {
        captureEntryDescription(entry)
        if (entry.kind === 'recovered') {
            if (entry.stack?.keep !== 0 || entry.stack.index !== 0 || entry.stack.push.length !== 1)
                throw new FlushBatchError('Invalid pending recovery baseline')
            const pushed = entry.stack.push[0]
            if (!pushed) throw new FlushBatchError('Missing recovery baseline slot')
            if (
                typeof entry.snapshot === 'number'
                    ? pushed.snapshot !== entry.snapshot
                    : !(pushed.snapshot instanceof Uint8Array) ||
                      !equalBytes(pushed.snapshot, entry.snapshot)
            )
                throw new FlushBatchError('Recovery baseline differs from current state')
            captureStep(pushed.step)
        } else if (entry.stack) throw new FlushBatchError('Unexpected entry stack')
    }
    for (const block of batch.stack?.blocks ?? []) {
        if (block.steps.length !== block.slots.length)
            throw new FlushBatchError('Stack metadata length differs')
        for (const step of block.steps) captureStep(step)
    }
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

/** A media row (§1.6.11.2): a new Blob of the bytes, never a `File`. */
export const mediaRow = (item: BatchMedia & { sha256: Uint8Array }, day: number) => ({
    blob: new Blob([item.bytes], item.type ? { type: item.type } : {}),
    sha256: item.sha256,
    size: item.bytes.byteLength,
    type: item.type,
    ...(item.filename === undefined ? {} : { filename: item.filename }),
    kind: item.kind,
    day,
})

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
    const known: KnownAt = { db: (await readMeta(tx, 'dbInstanceId')) ?? '', epoch }
    const sessionRow = await tx.get('sessions', batch.session.id)
    const session = isRow(sessionRow) ? sessionRow : undefined
    if (session && !isReadableSessionVersion(session.v))
        throw new FlushBatchError('Unsupported session generation')
    const chainId = batch.session.chainId
    // A stored session never changes chain (D10): a fork is a new session.
    if (session !== undefined && session.chainId !== chainId)
        throw new FlushBatchError('The session belongs to another chain')
    const chainRow = await tx.get('chains', chainId)
    const chain = isRow(chainRow) ? chainRow : undefined
    // A continuation's first write moves the head from its parent, only if it's still the parent
    // (§1.3.1's compare-and-set); another tab's continuation that moved it first makes this a fork.
    const continuing =
        !session && batch.session.parent !== undefined && chain?.head === batch.session.parent.id
    // The head check (r12-arch-web L4): another tab continued the chain meanwhile.
    if (chain && chain.head !== batch.session.id && !continuing)
        return {
            kind: 'notHead',
            chainId,
            head: String(chain.head),
            ...(typeof session?.lastSeq === 'number' ? { lastSeq: session.lastSeq } : {}),
        }
    const parentRow =
        !session && batch.session.parent
            ? await tx.get('sessions', batch.session.parent.id)
            : undefined
    if (parentRow !== undefined && (!isRow(parentRow) || !isReadableSessionVersion(parentRow.v)))
        throw new FlushBatchError('Unsupported parent session generation')

    // The closure check (§1.6.6): only hashes not known stored in this database at this epoch.
    const missingChunks: string[] = []
    for (const { hash, known: at } of batch.reused)
        if (
            (at?.db !== known.db || at.epoch !== epoch) &&
            (await tx.getKey('chunks', hashKey(hash))) === undefined
        )
            missingChunks.push(toHex(hash))
    const missingMedia: string[] = []
    const mediaToPut: (BatchMedia & { sha256: Uint8Array })[] = []
    const readBack: string[] = []
    const referenced = new Set(prepared.roots.flatMap((root) => root.media.map(toHex)))
    for (const hex of referenced) {
        const carried = prepared.media.get(hex)
        if ((await tx.getKey('media', hashKey(fromHex16(hex)))) !== undefined) {
            // Found there after a flush with no reply: a kill may have skipped its read-back.
            if (carried && batch.unconfirmed?.includes(hex)) readBack.push(hex)
            continue
        }
        if (carried) {
            mediaToPut.push(carried)
            readBack.push(hex)
        }
        // Held but not sent: the head's media went missing, so it's stored again (§1.6.4).
        else if (batch.held.includes(hex)) missingMedia.push(hex)
    }
    if (missingChunks.length || missingMedia.length)
        return { kind: 'missing', known, chunks: missingChunks, media: missingMedia }

    // The stack after the batch's last entry (§1.6.4 #6), only when the batch writes the session's
    // last entry: a re-send of stored entries (a lost reply, or a journal replayed since, §1.6.6)
    // leaves the stored stack alone.
    const lastSeq = typeof session?.lastSeq === 'number' ? session.lastSeq : 0
    // Entries at or below `lastSeq` are stored, or covered by the `recovered` entry a replayed
    // journal wrote over them (§1.6.6), so a re-send skips them. One with neither is stored now:
    // no entry is acknowledged without being stored.
    const missing = new Set<number>()
    if (session)
        for (const entry of batch.entries)
            if (
                entry.seq <= lastSeq &&
                (await tx.getKey('entries', [batch.session.id, entry.seq])) === undefined
            )
                missing.add(entry.seq)
    if (missing.size) {
        const from = Math.min(...missing)
        const later = await tx.getAll(
            'entries',
            KeyRange.bound([batch.session.id, from], [batch.session.id, lastSeq]),
        )
        const recovered = later
            .filter((row) => isRow(row) && row.kind === 'recovered')
            .map((row) => (row as Row).seq as number)
        for (const seq of missing) if (recovered.some((at) => at > seq)) missing.delete(seq)
    }
    const last = batch.entries.at(-1)?.seq ?? 0
    // The stored stack is the one after `lastSeq`: an entry stored below it leaves that stack
    // behind the entries, so it goes (replay rebuilds it, §1.3.9) unless the batch reaches it.
    const ownsStack = last > lastSeq || (missing.size > 0 && last === lastSeq)
    const behind = missing.size > 0 && last < lastSeq
    let stack = ownsStack ? batch.stack : undefined
    // A late flush reaching past a replayed journal (§1.6.6): its stack is the dead page's, which
    // never saw the recovered entry, so none is kept rather than one that isn't replay's.
    const first = batch.entries[0]?.seq ?? 0
    if (stack && session && first <= lastSeq) {
        const stored = await tx.get('entries', [batch.session.id, lastSeq])
        if (isRow(stored) && stored.kind === 'recovered') stack = undefined
    }
    // Slots and blocks the page knows stored elsewhere (a fork's parent, another store) are checked:
    // a block left alone may not be here, so the page sends the whole window; a stored slot must be.
    if (stack && stack.at?.db !== known.db) {
        if (!stack.full) return { kind: 'stackWhole', known }
        const refs = stack.blocks.flatMap((block) =>
            block.slots.filter((ref): ref is Uint8Array => typeof ref !== 'number'),
        )
        for (const ref of refs)
            if ((await tx.getKey('nodes', hashKey(ref))) === undefined) {
                stack = undefined
                break
            }
    }

    const forkSource =
        !chain && batch.chain.forkOf !== undefined
            ? await tx.get('chains', batch.chain.forkOf)
            : undefined

    // Entries landing on a stored slot (an undo or redo onto one not loaded) take its root's count.
    const storedRoots = new Map<string, { hash: Uint8Array; noteCount: number }>()
    for (const entry of batch.entries) {
        if (typeof entry.snapshot === 'number') continue
        const hex = toHex(entry.snapshot)
        if (storedRoots.has(hex)) continue
        const row = (await tx.get('nodes', hashKey(entry.snapshot))) as NodesRow | undefined
        // Open sessions' stacks are kept data (§1.6.8), so their roots are never removed.
        if (row?.t !== 'root') throw new FlushBatchError(`No stored root ${hex}`)
        storedRoots.set(hex, { hash: entry.snapshot.slice(), noteCount: row.noteCount })
    }
    const rootOf = (ref: number | Uint8Array) => {
        const root = typeof ref === 'number' ? prepared.roots[ref] : storedRoots.get(toHex(ref))
        if (!root) throw new FlushBatchError(`No snapshot ${String(ref)}`)
        return root
    }

    const nodesToPut: EncodedNode[] = []
    for (const node of prepared.nodes)
        if ((await tx.getKey('nodes', hashKey(node.hash))) === undefined) nodesToPut.push(node)
    const rootsToPut = new Map<string, EncodedRoot>()
    for (const root of prepared.roots) {
        const hex = toHex(root.hash)
        if (rootsToPut.has(hex)) continue
        if ((await tx.getKey('nodes', hashKey(root.hash))) === undefined) rootsToPut.set(hex, root)
    }

    const versionRows: [string, unknown][] = [[batch.session.id, session ?? { v: SESSION_V }]]
    if (batch.session.parent && parentRow !== undefined)
        versionRows.push([batch.session.parent.id, parentRow])
    const readVersion = sessionVersionReader(tx, versionRows)
    const identitySupported =
        !batch.identity || (await marksHaveSupportedSessions(batch.identity.marks, readVersion))

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
    // A Blob the browser refuses (WebKit's private windows) never fails the entries (§1.6.8.4).
    const refused: string[] = []
    for (const item of mediaToPut) {
        const row = mediaRow(item, day)
        if (!(await tx.tryPut('media', row, hashKey(fromHex16(item.hash))))) {
            refused.push(item.hash)
            continue
        }
        ownBytes += row.size
        count('media', row, item.hash)
    }

    // Entries a kill after commit already stored, or a `recovered` entry covers, are skipped:
    // re-sends are idempotent.
    // A continuation starts after its parent's last entry (§1.6.11.2).
    const parentUpdated =
        isRow(parentRow) && typeof parentRow.updatedAt === 'number' ? parentRow.updatedAt : 0
    const startedAt =
        typeof session?.startedAt === 'number'
            ? session.startedAt
            : stamp(Math.max(batch.session.startedAt, parentUpdated + 1))
    let updatedAt = typeof session?.updatedAt === 'number' ? session.updatedAt : startedAt
    let newLastSeq = lastSeq
    let written = 0
    let activeMs = typeof session?.activeMs === 'number' ? session.activeMs : 0
    let edited = false
    for (const entry of batch.entries) {
        if (entry.seq <= lastSeq ? !missing.has(entry.seq) : entry.seq <= newLastSeq) continue
        const root = rootOf(entry.snapshot)
        const time = stamp(entry.wall)
        if (written || session) activeMs += Math.min(Math.max(time - updatedAt, 0), ACTIVE_GAP_MS)
        const row = {
            sessionId: batch.session.id,
            seq: entry.seq,
            time,
            day,
            ...captureEntryDescription(entry),
            snapshot: root.hash.slice(),
            noteCount: root.noteCount,
            dirty: entry.dirty,
            ...(entry.stack
                ? {
                      stack: {
                          keep: entry.stack.keep,
                          push: entry.stack.push.map((slot) => ({
                              snapshot: rootOf(slot.snapshot).hash.slice(),
                              step: captureStep(slot.step),
                          })),
                          index: entry.stack.index,
                      },
                  }
                : {}),
            kept: true,
            ...(entry.revisionId === undefined ? {} : { revisionId: entry.revisionId }),
            ...(entry.device ? { device: { id: entry.device.id, label: entry.device.label } } : {}),
            ...(entry.appVersion === undefined ? {} : { appVersion: entry.appVersion }),
        }
        await tx.put('entries', row)
        entryRows.push(row)
        stats.entries++
        count('entries', row)
        updatedAt = time
        newLastSeq = Math.max(newLastSeq, entry.seq)
        written++
        if (EDITING_KINDS.includes(entry.kind)) edited = true
    }

    // A stack that can't be used leaves none rather than one behind `lastSeq`.
    const stackRemoved = (ownsStack && !stack) || behind
    const blockRows: unknown[] = []
    if (stack) {
        const { first, last } = windowBlocks(stack)
        for (const block of stack.blocks) {
            const slots: ReplaySlot[] = block.slots.map((ref, i) => ({
                snapshot: typeof ref === 'number' ? rootOf(ref).hash : ref,
                step: captureStep(block.steps[i]),
            }))
            const row = blockRow(batch.session.id, block.block, block.first, slots)
            blockRows.push(row)
            const added = (await tx.getKey('stackBlocks', [row.sessionId, row.block])) === undefined
            await tx.put('stackBlocks', row)
            count('stackBlocks', row, undefined, added)
        }
        // Blocks outside the window go: whole blocks past the cap, and the cut redo end.
        const id = batch.session.id
        await tx.delete('stackBlocks', KeyRange.bound([id, -Infinity], [id, first], false, true))
        await tx.delete('stackBlocks', KeyRange.bound([id, last], [id, Infinity], true, false))
    } else if (stackRemoved) {
        const id = batch.session.id
        await tx.delete('stackBlocks', KeyRange.bound([id, -Infinity], [id, Infinity]))
    }

    const sessionFields: Row = {
        updatedAt,
        day,
        lastSeq: newLastSeq,
        ...(stack ? { stack: { base: stack.base, length: stack.length, index: stack.index } } : {}),
        entryCount: (typeof session?.entryCount === 'number' ? session.entryCount : 0) + written,
        activeMs,
        ownBytes: (typeof session?.ownBytes === 'number' ? session.ownBytes : 0) + ownBytes,
        appVersion: batch.appVersion,
        // A re-send of stored entries leaves the newer view.
        ...(batch.view && (written || !session) ? { view: batch.view } : {}),
    }
    const sessionValue: Row = session
        ? updated(session, sessionFields)
        : {
              id: batch.session.id,
              v: SESSION_V,
              chainId,
              startedAt,
              origin: batch.session.origin,
              ...(batch.session.parent ? { parent: batch.session.parent } : {}),
              ...sessionFields,
          }
    if (stackRemoved) delete sessionValue.stack
    await tx.put('sessions', sessionValue)
    count('sessions', sessionValue, undefined, !session)

    const hasContentAtStart = batch.session.origin !== 'new' && batch.session.origin !== 'continued'
    const chainFields: Row = {
        updatedAt,
        day,
        // A re-send of stored entries leaves the newer head's summary (a kill after commit); a
        // batch whose head isn't one of its states has none.
        ...(batch.summary && (written || !chain) ? { summary: batch.summary } : {}),
        appVersion: batch.appVersion,
        ...(edited ? { edited: true, hasContent: true } : {}),
    }
    const old = isRow(forkSource) ? forkSource : undefined
    const chainValue = chain
        ? updated(chain, { ...chainFields, ...(continuing ? { head: batch.session.id } : {}) })
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
              ...(batch.chain.name === undefined ? {} : { name: batch.chain.name }),
              ...chainFields,
          }
    // Fields the session set before its first write: written field by field, `null` removing; a
    // handle goes in its own store (D24).
    for (const [key, value] of Object.entries(
        await splitHandles(tx, chainId, batch.chain.set ?? {}),
    ))
        if (value === null) Reflect.deleteProperty(chainValue, key)
        else chainValue[key] = value
    // A Save's identity unit, after its entry and with its marks (§1.3.2): the binding replaces a
    // taken-over one's `replaced`.
    let identity: boolean | undefined
    // A unit whose binding was taken over since its Save is dropped, never stored (R5).
    const stale = !!batch.identity && !!chain && !unitApplies(chain, batch.identity)
    if (batch.identity && !stale) {
        identity = identitySupported && (await storeMarks(tx, batch.identity.marks, readVersion))
        if (identity) {
            // The cut's session start as stored, which the page may not know.
            const file = { ...batch.identity.file }
            if (isRow(file.entry) && file.entry.sessionId === batch.session.id)
                file.entry = { ...file.entry, startedAt }
            const own = await splitHandles(tx, chainId, { file })
            chainValue.docId = batch.identity.docId
            chainValue.revision = batch.identity.revision
            chainValue.file = own.file
            await clearIdentityExport(tx, chainId, chainValue, batch.identity)
            delete chainValue.replaced
        }
    }
    await tx.put('chains', chainValue)
    count('chains', chainValue, undefined, !chain)

    await writeMeta(tx, 'maxSeenTime', maxSeen)
    testPoint?.('flush:beforeCommit')

    return {
        kind: 'stored',
        known,
        chunks: prepared.chunks.map((chunk) => chunk.hash),
        roots: prepared.roots.map((root) => root.hash),
        lastSeq: newLastSeq,
        readBack: readBack.filter((hex) => !refused.includes(hex)),
        ...(refused.length ? { mediaFailed: refused } : {}),
        stackWritten: stack !== undefined,
        ...(stackRemoved ? { stackRemoved } : {}),
        chain: chainValue,
        ...(identity === undefined ? {} : { identity }),
        ...(stale ? { staleIdentity: true } : {}),
        stats,
        committed: {
            session: { id: batch.session.id, chainId },
            entries: entryRows,
            stackBlocks: blockRows,
            records,
            media: mediaToPut
                .filter((item) => !refused.includes(item.hash))
                .map((item) => fromHex16(item.hash)),
            descriptorChanged: !chain,
        },
    }
}
