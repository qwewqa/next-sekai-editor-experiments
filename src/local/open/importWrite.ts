import {
    captureEntryDescription,
    captureStep,
    type EntryDescription,
    type JsonValue,
} from '../../history/operations'
import { ChunkVerifyError, verifyChunk, type VerifiedChunk } from '../chunkVerify'
import { countDayOfUse } from '../days'
import { hashKey, readMeta, writeMeta } from '../db'
import type { BatchMedia, ChainSummary, PreparedFlush } from '../flushWrite'
import { prepareForeign, writeForeign, type PreparedForeign } from '../foreign'
import { deleteHandleRow, splitHandles } from '../handleRows'
import { fromHex16, sha256, toHex } from '../hash'
import { KeyRange, type KvTx } from '../kv/types'
import type { ReadHistory } from '../nxsp'
import type { EntryForm } from '../nxsp/manifest'
import { putChunk } from '../putChunk'
import { canonicalBytes, type RecordValue } from '../records/canonical'
import {
    isChunkRowIntact,
    nodeRow,
    packHashes,
    rootRow,
    unpackHashes,
    type ChunkRow,
    type NodeRow,
    type NodesRow,
    type RootRow,
} from '../records/rows'
import type { KindName } from '../records/schema'
import { headerMedia } from '../records/snapshot'
import { SESSION_V } from '../records/version'
import { directWaiter, type Waiter } from '../scheduler'
import type { StateBatch } from '../stateBatch'
import { nextTime } from '../time'
import { BLOCK_SLOTS, blockOf, blockRow, storedWindow, type ReplaySlot } from '../timeline'
import { lackingRoots, type OpenedFile } from './opened'
import { BATCH_ROWS, chunksOfRoot, nodesOfRoot, stackOrder, type ImportBatch } from './plan'

// The open's transactions (Part 1 §1.5.4): the first, which stores the new chain and session
// with the head's parts, the stack and the media, strictly; the background batches; the unlink
// when the file turns out damaged (§1.6.11.8); and the end of an import that can't go on, which
// marks the rows whose states never arrived `kept: false`.

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** The binding's cut (§1.3.2): the last row the file holds, its session's start and its counts. */
export type FileCut = {
    sessionId: string
    seq: number
    startedAt: number
    count: number
    notKept: number
}

export type OpenStoreRequest = {
    /** The opened file (`readOpened`'s id). */
    id: string
    ids: { chainId: string; sessionId: string; docId: string; lineageId: string }
    /**
     * Chain fields: names, `extra`, `revision`, `partialImport`, and the binding without its
     * `hash` and `entry`, which this transaction fills in.
     */
    chain: Row
    /** The live state when it isn't the history's head: the file's level, or no history. */
    level?: StateBatch
    /** The live state's summary, when it's the history's head. */
    summary?: ChainSummary
    operations: { opened: JsonValue; changedOutside: JsonValue }
    wall: number
    appVersion: string
    /** `replaced`: the version on disk Replace keeps first, an ordinary unbound session (§1.4.7). */
    origin?: 'replaced'
}

export type OpenStoreResult = {
    mediaFailed?: string[]
    kind: 'stored'
    /** The live state's root: the binding's `hash`. */
    head: Uint8Array
    lastSeq: number
    /** The chain record as written. */
    chain: Row
    importPending: boolean
}

/** A root or node row from its JSON form, which the reader hashed to its key (§1.6.11.5). */
const recordRow = (
    json: RecordValue[],
    media: readonly Uint8Array[],
    day: number,
): RootRow | NodeRow => {
    const size = canonicalBytes(json).length
    if (typeof json[0] === 'number') {
        const [v, header, kinds, noteCount] = json as [number, string, [KindName, string][], number]
        return {
            t: 'root',
            v,
            kinds: kinds.map(([name]) => name),
            noteCount,
            refs: packHashes([
                fromHex16(header),
                ...kinds.map(([, hash]) => fromHex16(hash)),
                ...media,
            ]),
            size,
            day,
        }
    }
    return {
        t: 'node',
        kind: json[0] as string,
        depth: json[1] as 0 | 1,
        refs: packHashes((json[2] as string[]).map(fromHex16)),
        size,
        day,
    }
}

const decoder = new TextDecoder()

/** A root's media, from its header chunk read from the file. */
const mediaOfRoot = async (history: ReadHistory, json: RecordValue[]) => {
    const header = JSON.parse(
        decoder.decode(await history.chunks.read(json[1] as string)),
    ) as RecordValue[]
    return headerMedia(header)
}

/** Records ready to put: rows by hex key. */
type PreparedRecords = Map<string, Row>

const prepareRecords = async (history: ReadHistory, keys: Iterable<string>, day: number) => {
    const rows: PreparedRecords = new Map()
    for (const key of keys) {
        const root = history.roots.get(key)
        if (root) {
            rows.set(key, recordRow(root, await mediaOfRoot(history, root), day))
            continue
        }
        const node = history.nodes.get(key)
        if (node) rows.set(key, recordRow(node, [], day))
    }
    return rows
}

/** The file's entry form as a row of the session (§1.6.11.5's "On import"). */
const entryRow = (
    history: ReadHistory,
    sessionId: string,
    seq: number,
    entry: EntryForm,
    day: number,
): Row => {
    const root = history.roots.get(entry.snapshot)
    return {
        sessionId,
        seq,
        // Imported rows keep their time, and it never feeds `maxSeenTime` (r11g-format M10).
        time: entry.time,
        day,
        ...captureEntryDescription(entry),
        snapshot: fromHex16(entry.snapshot),
        noteCount: root ? root[3] : entry.noteCount,
        dirty: entry.dirty === true,
        kept: entry.kept !== false,
        ...(entry.revisionId === undefined ? {} : { revisionId: entry.revisionId }),
        ...(entry.device === undefined ? {} : { device: { ...entry.device } }),
        ...(entry.appVersion === undefined ? {} : { appVersion: entry.appVersion }),
        ...(entry.stack === undefined
            ? {}
            : {
                  stack: {
                      keep: entry.stack.keep,
                      push: entry.stack.push.map(({ snapshot, step }) => ({
                          snapshot: fromHex16(snapshot),
                          step: captureStep(step),
                      })),
                      index: entry.stack.index,
                  },
              }),
        ...(entry.x === undefined ? {} : { x: entry.x }),
    }
}

export type PreparedOpen = {
    foreign?: PreparedForeign
    /** The stack's other roots and nodes, without their chunks: Undo and a flush find them. */
    records: PreparedRecords
    level?: PreparedFlush
    /** Hex keys this transaction stores, which the import then skips. */
    stored: Set<string>
    /** The file's rows, when few enough for the first transaction: no import waits for them. */
    entries?: Row[]
}

const mediaOf = async (opened: OpenedFile): Promise<BatchMedia[]> => {
    const out: BatchMedia[] = []
    for (const [kind, item] of Object.entries(opened.read.media)) {
        const bytes = await item.bytes.arrayBuffer()
        const digest = await sha256(new Uint8Array(bytes))
        out.push({
            hash: toHex(digest.subarray(0, 16)),
            bytes,
            type: item.form.type,
            ...(item.form.filename === undefined ? {} : { filename: item.form.filename }),
            kind: kind as BatchMedia['kind'],
        })
    }
    return out
}

/** Everything the first transaction needs that awaits something other than IndexedDB. */
export const prepareOpenHead = async (
    opened: OpenedFile,
    request: OpenStoreRequest,
    prepareLevel: (batch: StateBatch) => Promise<PreparedFlush>,
    waiter: Waiter = directWaiter,
): Promise<PreparedOpen> => {
    const history = opened.read.history
    const stored = new Set<string>()
    const media = await mediaOf(opened)
    let foreign: PreparedForeign | undefined
    const records: PreparedRecords = new Map()
    if (history) {
        const head = history.head
        const root = history.roots.get(head)
        if (!root) throw new Error(`No head root ${head}`)
        const nodes = nodesOfRoot(history, head)
        const chunks = chunksOfRoot(history, head)
        foreign = await prepareForeign(
            {
                roots: [fromHex16(head)],
                nodes: [
                    { hash: fromHex16(head), bytes: canonicalBytes(root) },
                    ...nodes.map((hash) => ({
                        hash: fromHex16(hash),
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        bytes: canonicalBytes(history.nodes.get(hash)!),
                    })),
                ],
                chunks: await Promise.all(
                    [...new Set(chunks)].map(async (hash) => ({
                        hash: fromHex16(hash),
                        stored: await history.chunks.stored(hash),
                    })),
                ),
                media,
            },
            waiter,
        )
        for (const key of [head, ...nodes, ...chunks]) stored.add(key)
        const others: string[] = []
        for (const slotRoot of stackOrder(history)) {
            if (stored.has(slotRoot)) continue
            for (const key of [slotRoot, ...nodesOfRoot(history, slotRoot)])
                if (!stored.has(key)) {
                    stored.add(key)
                    others.push(key)
                }
        }
        for (const [key, row] of await prepareRecords(history, others, 0)) records.set(key, row)
    } else if (media.length) {
        foreign = await prepareForeign({ roots: [], nodes: [], chunks: [], media }, waiter)
    }
    const level = request.level ? await prepareLevel(request.level) : undefined
    // A short history's rows come in the first transaction, so a tab that ends before the first
    // batch still has every row the file held (§1.5.4's batches are for long histories).
    const entries =
        history && history.entries.length <= BATCH_ROWS
            ? history.entries.map((entry, i) =>
                  entryRow(history, request.ids.sessionId, i + 1, entry, 0),
              )
            : undefined
    return {
        ...(foreign ? { foreign } : {}),
        records,
        ...(level ? { level } : {}),
        stored,
        ...(entries ? { entries } : {}),
    }
}

/** The stored window of a stack given by absolute slots from `base`, and its block rows. */
const stackRows = (
    sessionId: string,
    base: number,
    slots: readonly ReplaySlot[],
    index: number,
) => {
    const window = storedWindow(base + slots.length, index, base)
    const inWindow = slots.slice(window.base - base, window.base - base + window.length)
    const blocks = []
    for (let at = 0; at < inWindow.length;) {
        const slot = window.base + at
        const count = Math.min(BLOCK_SLOTS - (slot % BLOCK_SLOTS), inWindow.length - at)
        blocks.push(blockRow(sessionId, blockOf(slot), slot, inWindow.slice(at, at + count)))
        at += count
    }
    return { window, blocks }
}

const putRecords = async (tx: KvTx, records: PreparedRecords, day: number) => {
    let bytes = 0
    for (const [key, row] of records) {
        const hashed = hashKey(fromHex16(key))
        if ((await tx.getKey('nodes', hashed)) !== undefined) continue
        await tx.put('nodes', { ...row, day }, hashed)
        bytes += row.size as number
    }
    return bytes
}

/**
 * The open's first transaction, strict (§1.5.4 step 3): the chain record with its binding, the
 * session row with `importPending`, the head's root, nodes and chunks with the closure check,
 * the stack's other roots and nodes, its blocks, the media, and the session's own entries: the
 * "Changed outside the editor" edit when the live state isn't the history's head, then the
 * `continue` entry "Opened coconut.nxsp". The file's rows follow in the batches, as seq 1 … n.
 */
export const writeOpenHead = async (
    tx: KvTx,
    opened: OpenedFile,
    request: OpenStoreRequest,
    prepared: PreparedOpen,
): Promise<OpenStoreResult> => {
    const history = opened.read.history
    const { chainId, sessionId, docId, lineageId } = request.ids
    let maxSeen = (await readMeta(tx, 'maxSeenTime')) ?? 0
    const now = (maxSeen = nextTime(maxSeen, request.wall))
    const day = await countDayOfUse(tx, now)

    let ownBytes = 0
    let mediaFailed: string[] | undefined
    if (prepared.foreign) {
        const roots = history ? [fromHex16(history.head)] : []
        const result = await writeForeign(tx, prepared.foreign, roots, day)
        // The reader resolved every part of the head, so nothing can be missing but by a bug.
        if (result.kind !== 'stored')
            throw new Error(`The opened file’s head lacks ${result.hashes.join(', ')}`)
        mediaFailed = result.mediaFailed
        for (const chunk of prepared.foreign.chunks.values()) ownBytes += chunk.stored.length
    }
    ownBytes += await putRecords(tx, prepared.records, day)

    let levelRoot: Uint8Array | undefined
    let levelNotes = 0
    if (prepared.level) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const root = prepared.level.roots[0]!
        for (const chunk of prepared.level.chunks) {
            const row = await putChunk(tx, chunk, day)
            if (row) ownBytes += row.bytes.length
        }
        for (const node of [...prepared.level.nodes, root]) {
            if ((await tx.getKey('nodes', hashKey(node.hash))) !== undefined) continue
            const row = node === root ? rootRow(root, day) : nodeRow(node as never, day)
            await tx.put('nodes', row, hashKey(node.hash))
            ownBytes += row.size
        }
        levelRoot = root.hash.slice()
        levelNotes = root.noteCount
    }

    // The stack: the file's as it is (§1.6.11.5), with the file's level pushed when it differs.
    const count = history?.entries.length ?? 0
    let base = 0
    let slots: ReplaySlot[] = []
    let index = 0
    if (history) {
        base = history.undoStack.base
        slots = history.undoStack.slots.map(({ snapshot, step }) => ({
            snapshot: fromHex16(snapshot),
            step: captureStep(step),
        }))
        index = history.undoStack.index
    }
    const ownEntries: Row[] = []
    let seq = count
    const entry = (description: EntryDescription, snapshot: Uint8Array, noteCount: number) => {
        ownEntries.push({
            sessionId,
            seq: ++seq,
            time: now,
            day,
            ...captureEntryDescription(description),
            snapshot,
            noteCount,
            // The file holds this state: not changed since the file event.
            dirty: false,
            kept: true,
        })
    }
    let head: Uint8Array
    if (levelRoot && history) {
        slots.length = index - base + 1
        const step = captureStep({ kind: 'edit', operation: request.operations.changedOutside })
        slots.push({ snapshot: levelRoot, step })
        index++
        entry({ kind: 'edit', step }, levelRoot, levelNotes)
        head = levelRoot
    } else if (levelRoot) {
        slots = [
            {
                snapshot: levelRoot,
                step: captureStep({ kind: 'init', operation: request.operations.opened }),
            },
        ]
        head = levelRoot
    } else if (history) {
        head = fromHex16(history.head)
    } else throw new Error('An open with neither history nor a level')
    const headNotes = levelRoot
        ? levelNotes
        : ((history?.roots.get(history.head)?.[3] as number | undefined) ?? 0)
    entry({ kind: 'continue', operation: request.operations.opened }, head, headNotes)
    for (const row of prepared.entries ?? []) await tx.put('entries', { ...row, day })
    for (const row of ownEntries) await tx.put('entries', row)

    const { window, blocks } = stackRows(sessionId, base, slots, index)
    for (const row of blocks) await tx.put('stackBlocks', row)

    const importPending = !!history
    await tx.put('sessions', {
        id: sessionId,
        v: SESSION_V,
        chainId,
        startedAt: now,
        updatedAt: now,
        day,
        origin: request.origin ?? 'nxsp',
        stack: { base: window.base, length: window.length, index: window.index },
        lastSeq: seq,
        entryCount: ownEntries.length + (prepared.entries?.length ?? 0),
        activeMs: 0,
        ownBytes,
        appVersion: request.appVersion,
        ...(importPending ? { importPending: true } : {}),
    })

    const fields: Row = { ...request.chain }
    const file = isRow(fields.file) ? fields.file : undefined
    if (file) {
        const cut: FileCut = {
            sessionId,
            seq: count,
            startedAt: now,
            count,
            notKept: history ? lackingRoots(history) : 0,
        }
        fields.file = { ...file, at: now, hash: head.slice(), entry: cut }
    }
    // The binding's handle goes in its own store (D24).
    const chain: Row = {
        ...(await splitHandles(tx, chainId, fields)),
        chainId,
        head: sessionId,
        docId,
        lineageId,
        // Rows copied from a file never make the chain edited (§1.6.11.2).
        hasContent: true,
        updatedAt: now,
        day,
        ...(request.level
            ? { summary: request.level.summary }
            : request.summary
              ? { summary: request.summary }
              : {}),
        appVersion: request.appVersion,
    }
    await tx.put('chains', chain)
    await writeMeta(tx, 'maxSeenTime', maxSeen)
    return {
        kind: 'stored',
        head: head.slice(),
        lastSeq: seq,
        chain,
        importPending,
        ...(mediaFailed ? { mediaFailed } : {}),
    }
}

export type BatchOutcome =
    | { kind: 'done' }
    /** Chunks that failed their hash; the rest of the batch is stored. */
    | { kind: 'damaged'; hashes: string[] }
    /** The file couldn't be read: changed, or gone. The import stops. */
    | { kind: 'readError' }
    /** The session's import was ended elsewhere (deleted, or abandoned): stop. */
    | { kind: 'gone' }

export type PreparedBatch =
    | { kind: 'entries'; rows: Row[] }
    | { kind: 'records'; rows: PreparedRecords }
    | { kind: 'chunks'; chunks: VerifiedChunk[]; damaged: string[] }
    | { kind: 'finish' }

/** Whether a read failed on the file itself: Chromium's `NotReadableError` after a change. */
const isReadError = (error: unknown) =>
    error instanceof DOMException ||
    (error instanceof Error &&
        (error.name === 'NotReadableError' || error.name === 'NotFoundError'))

/**
 * A batch's work outside the transaction. Chunks already stored aren't read or inflated again
 * (`stored` from a read before it), so reopening your own file costs almost nothing (r11f fit S4).
 */
export const prepareBatch = async (
    history: ReadHistory,
    sessionId: string,
    batch: ImportBatch,
    storedChunks: ReadonlySet<string>,
    waiter: Waiter = directWaiter,
): Promise<PreparedBatch | { kind: 'readError' }> => {
    try {
        switch (batch.kind) {
            case 'entries': {
                const rows: Row[] = []
                for (let i = batch.from; i < batch.to; i++)
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    rows.push(entryRow(history, sessionId, i + 1, history.entries[i]!, 0))
                return { kind: 'entries', rows }
            }
            case 'records':
                return { kind: 'records', rows: await prepareRecords(history, batch.keys, 0) }
            case 'chunks': {
                const chunks: VerifiedChunk[] = []
                const damaged: string[] = []
                for (const hash of batch.hashes) {
                    if (storedChunks.has(hash)) continue
                    const stored = await history.chunks.stored(hash)
                    try {
                        chunks.push(
                            await waiter.wait(verifyChunk({ hash: fromHex16(hash), stored })),
                        )
                    } catch (error) {
                        if (!(error instanceof ChunkVerifyError) && !isInflateError(error))
                            throw error
                        damaged.push(hash)
                    }
                }
                return { kind: 'chunks', chunks, damaged }
            }
            case 'finish':
                return { kind: 'finish' }
        }
    } catch (error) {
        if (isReadError(error)) return { kind: 'readError' }
        throw error
    }
}

/** A stored form that won't inflate within its cap is damage too, never a read error. */
const isInflateError = (error: unknown) => error instanceof Error && error.name === 'DeflateError'

/** Which of these chunks storage holds intact: a read before a chunks batch. */
export const readStoredChunks = async (tx: KvTx, hashes: readonly string[]) => {
    const found = new Set<string>()
    for (const hash of hashes) {
        const key = fromHex16(hash)
        const row = (await tx.get('chunks', hashKey(key))) as ChunkRow | undefined
        if (row?.bytes instanceof Uint8Array && isChunkRowIntact(key, row)) found.add(hash)
    }
    return found
}

/** One background batch, its own transaction; stops when the session's import was ended. */
export const writeBatch = async (
    tx: KvTx,
    sessionId: string,
    prepared: PreparedBatch,
    wall: number,
): Promise<BatchOutcome> => {
    const session = await tx.get('sessions', sessionId)
    if (!isRow(session) || session.importPending !== true) return { kind: 'gone' }
    const maxSeen = (await readMeta(tx, 'maxSeenTime')) ?? 0
    const day = await countDayOfUse(tx, nextTime(maxSeen, wall))
    switch (prepared.kind) {
        case 'entries': {
            let written = 0
            for (const row of prepared.rows) {
                if ((await tx.getKey('entries', [sessionId, row.seq as number])) !== undefined)
                    continue
                await tx.put('entries', { ...row, day })
                written++
            }
            if (written)
                await tx.put('sessions', {
                    ...session,
                    entryCount:
                        (typeof session.entryCount === 'number' ? session.entryCount : 0) + written,
                })
            return { kind: 'done' }
        }
        case 'records': {
            const bytes = await putRecords(tx, prepared.rows, day)
            if (bytes)
                await tx.put('sessions', { ...session, ownBytes: ownBytesOf(session) + bytes })
            return { kind: 'done' }
        }
        case 'chunks': {
            let bytes = 0
            for (const chunk of prepared.chunks) {
                const row = await putChunk(tx, chunk, day)
                if (row) bytes += row.bytes.length
            }
            if (bytes)
                await tx.put('sessions', { ...session, ownBytes: ownBytesOf(session) + bytes })
            return prepared.damaged.length
                ? { kind: 'damaged', hashes: prepared.damaged }
                : { kind: 'done' }
        }
        case 'finish': {
            const { importPending: _done, ...rest } = session
            await tx.put('sessions', rest)
            return { kind: 'done' }
        }
    }
}

const ownBytesOf = (session: Row) => (typeof session.ownBytes === 'number' ? session.ownBytes : 0)

/** The roots of a file's history that reach any of these chunks. */
export const rootsReaching = (history: ReadHistory, chunks: ReadonlySet<string>) => {
    const out = new Set<string>()
    for (const key of history.roots.keys())
        if (chunksOfRoot(history, key).some((hash) => chunks.has(hash))) out.add(key)
    return out
}

export type UnlinkRequest = {
    sessionId: string
    chainId: string
    /** The chain's new identity: a new `docId`, with no `revision` and no binding. */
    docId: string
    /** The chunks found bad. */
    hashes: string[]
    /** Roots whose states need them: their rows become `kept: false` (r12-freeze item 1). */
    roots: string[]
    appVersion: string
}

/**
 * Damage in the chain's own file found after its open (§1.6.11.8): in one transaction the chain
 * gets a new `docId` and loses `revision` and `file`, its `badChunks` gain the hashes, and the
 * session's rows whose states need them become `kept: false`. Returns the record as written, or
 * undefined when the chain is gone.
 */
export const writeUnlink = async (tx: KvTx, request: UnlinkRequest) => {
    const chain = await tx.get('chains', request.chainId)
    if (!isRow(chain)) return
    const roots = new Set(request.roots)
    const rows = (await tx.getAll(
        'entries',
        KeyRange.bound([request.sessionId, -Infinity], [request.sessionId, Infinity]),
    )) as Row[]
    for (const row of rows)
        if (
            row.kept !== false &&
            row.snapshot instanceof Uint8Array &&
            roots.has(toHex(row.snapshot))
        )
            await tx.put('entries', { ...row, kept: false })
    const old =
        chain.badChunks instanceof Uint8Array ? unpackHashes(chain.badChunks).map(toHex) : []
    const bad = [...new Set([...old, ...request.hashes])].map(fromHex16)
    const { revision: _revision, file: _file, ...rest } = chain
    await deleteHandleRow(tx, request.chainId, 'file')
    const record: Row = {
        ...rest,
        docId: request.docId,
        partialImport: true,
        badChunks: packHashes(bad),
        appVersion: request.appVersion,
    }
    await tx.put('chains', record)
    return record
}

/**
 * Ends an import that can't go on (§1.5.4: the tab ended, the file changed or can't be read):
 * the session's rows whose states storage doesn't hold whole become `kept: false`, and
 * `importPending` goes. False when there was nothing to end.
 */
export const writeAbandon = async (tx: KvTx, sessionId: string): Promise<boolean> => {
    const session = await tx.get('sessions', sessionId)
    if (!isRow(session) || session.importPending !== true) return false
    const complete = new Map<string, boolean>()
    const chunkHeld = async (hash: Uint8Array) => {
        const row = (await tx.get('chunks', hashKey(hash))) as ChunkRow | undefined
        return row?.bytes instanceof Uint8Array && isChunkRowIntact(hash, row)
    }
    const whole = async (hash: Uint8Array): Promise<boolean> => {
        const hex = toHex(hash)
        const known = complete.get(hex)
        if (known !== undefined) return known
        complete.set(hex, false)
        const row = (await tx.get('nodes', hashKey(hash))) as NodesRow | undefined
        let ok = false
        if (row?.t === 'root' || row?.t === 'node') {
            const refs = unpackHashes(row.refs)
            ok = true
            if (row.t === 'root') {
                // The header, then the kind nodes; media aren't part of a state's records.
                const [header, ...kinds] = refs
                if (!header || !(await chunkHeld(header))) ok = false
                for (const kind of kinds.slice(0, row.kinds.length))
                    if (ok && !(await whole(kind))) ok = false
            } else
                for (const child of refs)
                    if (ok && !(row.depth === 1 ? await whole(child) : await chunkHeld(child)))
                        ok = false
        }
        complete.set(hex, ok)
        return ok
    }
    const rows = (await tx.getAll(
        'entries',
        KeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]),
    )) as Row[]
    for (const row of rows)
        if (
            row.kept !== false &&
            row.snapshot instanceof Uint8Array &&
            !(await whole(row.snapshot))
        )
            await tx.put('entries', { ...row, kept: false })
    const { importPending: _ended, ...rest } = session
    await tx.put('sessions', rest)
    return true
}
