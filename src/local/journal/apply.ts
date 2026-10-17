import { forkRecord } from '../chainFields'
import { countDayOfUse } from '../days'
import { hashKey, readMeta, writeMeta } from '../db'
import {
    FLUSH_STORES,
    prepareFlush,
    type BatchSnapshot,
    type ChainSummary,
    type FlushBatch,
    type PreparedFlush,
} from '../flushWrite'
import { fromHex16, isHash16Hex, toHex } from '../hash'
import { KeyRange, type KvTx } from '../kv/types'
import { putChunk } from '../putChunk'
import { nodeRow, rootRow } from '../records/rows'
import { isKnownEntryKind, isReadableSessionVersion } from '../records/unknownValues'
import { directWaiter, type Waiter } from '../scheduler'
import { clampTime, nextTime } from '../time'
import {
    BLOCK_SLOTS,
    blockOf,
    blockRow,
    blockSlot,
    chainFlagsAtCreation,
    storedWindow,
    type ReplaySlot,
    type StackBlockRow,
    type StackWindow,
} from '../timeline'
import type { JournalDescriptor, JournalStack } from './format'

// Journal replay's transaction (Part 1 §1.6.4 #7 steps 3–4), in the storage worker: under the
// session lock the page holds, one strict transaction checks the session and applies the
// journal to it, or, when it can't be applied there, makes a recovery session in a new chain.
// Every read comes before the first write.

/** A journal's state as a batch, prepared on the page as a flush's are, with its decisions. */
export type JournalApplyBatch = {
    sessionId: string
    seq: number
    descriptor: JournalDescriptor
    stack: JournalStack
    text: Uint8Array
    ends: number[]
    snapshot: BatchSnapshot
    summary: ChainSummary
    /** The `recovered` entry's label: "Recovered last change", with the dropped steps. */
    label: string
    /** A recovery chain's and session's ids, derived from the journal: used if one is made. */
    recovery: { chainId: string; docId: string; sessionId: string }
    appVersion: string
    wall: number
}

export type JournalApplyResult =
    /** Applied to its session, which keeps its ids (and was made from the descriptor if missing). */
    | { kind: 'applied'; created: boolean }
    /** A flush already covered it. */
    | { kind: 'covered' }
    /** Kept as a separate session in a new chain (§1.6.4: "could not be applied"). */
    | { kind: 'recovery'; sessionId: string; chainId: string; why: string }
    /** Its chain needs a newer version, or is being deleted: left in place. */
    | { kind: 'later'; why: string }

export const JOURNAL_STORES = [...FLUSH_STORES, 'tombstones'] as const

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** Session fields a descriptor carries that aren't the chain's. */
const SESSION_FIELDS = new Set(['v', 'origin', 'parent', 'startedAt'])

/** The descriptor's chain fields as a record stores them: hashes back to bytes. */
const chainFieldsOf = (descriptor: JournalDescriptor): Row => {
    const fields: Row = {}
    for (const [key, value] of Object.entries(descriptor)) {
        if (SESSION_FIELDS.has(key)) continue
        if (key === 'file' && isRow(value))
            fields[key] = isHash16Hex(value.hash)
                ? { ...value, hash: fromHex16(value.hash) }
                : value
        else if (
            key === 'badChunks' &&
            typeof value === 'string' &&
            /^([0-9a-f]{32})*$/.test(value)
        )
            fields[key] = Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16))
        else fields[key] = value
    }
    return fields
}

/** `revision.id` of the record is among the descriptor revision's ancestors (§1.6.4 step 4). */
const descends = (next: unknown, base: unknown) => {
    if (!isRow(next) || !isRow(base) || typeof base.id !== 'string') return false
    return Array.isArray(next.ancestors) && next.ancestors.includes(base.id)
}

/** The record has no `replaced`, or the binding's `at` is above `replaced.at` (D5). */
const afterReplaced = (file: unknown, replaced: unknown) => {
    if (replaced === undefined) return true
    if (!isRow(file) || !isRow(replaced)) return false
    return typeof file.at === 'number' && typeof replaced.at === 'number' && file.at > replaced.at
}

/** Reads the snapshot's work before the transaction: chunks verified, nodes and root hashed. */
export const prepareJournal = (batch: JournalApplyBatch, waiter: Waiter = directWaiter) =>
    prepareFlush(
        {
            text: batch.text,
            ends: batch.ends,
            snapshots: [batch.snapshot],
            media: [],
        } as unknown as FlushBatch,
        waiter,
    )

/** Why a journal's stack can't be laid over its session's, or undefined when it can. */
const stackProblem = async (
    tx: KvTx,
    sessionId: string,
    session: Row | undefined,
    stack: JournalStack,
): Promise<string | undefined> => {
    if (stack.keep === 0) return
    const window = session?.stack as StackWindow | undefined
    if (!window) return 'no stored stack to keep'
    if (stack.keep > window.base + window.length || stack.keep - 1 < window.base)
        return 'kept slots outside the stored window'
    if (!stack.head && stack.index < window.base) return 'its index outside the stored window'
    const row = (await tx.get('stackBlocks', [sessionId, blockOf(stack.keep - 1)])) as
        StackBlockRow | undefined
    const slot = blockSlot(row, stack.keep - 1)
    if (!slot || toHex(slot.snapshot) !== stack.lastKept) return 'its last kept slot differs'
}

/** The stored slots `first … end − 1` of a session's blocks, or undefined when one is missing. */
const readSlots = async (tx: KvTx, sessionId: string, first: number, end: number) => {
    const slots: ReplaySlot[] = []
    const rows = new Map<number, StackBlockRow | undefined>()
    for (let slot = first; slot < end; slot++) {
        const block = blockOf(slot)
        if (!rows.has(block))
            rows.set(block, (await tx.get('stackBlocks', [sessionId, block])) as StackBlockRow)
        const found = blockSlot(rows.get(block), slot)
        if (!found) return
        slots.push(found)
    }
    return slots
}

let applyHook: ((force: string | undefined) => void) | undefined

/** A test hook run in the apply's write phase: it can throw, as a bug or a disk would. */
export const setJournalApplyHookForTests = (hook: typeof applyHook) => {
    applyHook = hook
}

export const writeJournalApply = async (
    tx: KvTx,
    batch: JournalApplyBatch,
    prepared: PreparedFlush,
    /** Why an apply failed: then it's kept as a recovery session (§1.6.4). */
    { force }: { force?: string } = {},
): Promise<JournalApplyResult> => {
    const { sessionId, seq, descriptor, stack } = batch
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const root = prepared.roots[0]!

    // Reads.
    const sessionRow = await tx.get('sessions', sessionId)
    const session = isRow(sessionRow) ? sessionRow : undefined
    const tombstone = await tx.get('tombstones', sessionId)
    const chainId = typeof session?.chainId === 'string' ? session.chainId : descriptor.chainId
    const chainRow = await tx.get('chains', chainId)
    const chain = isRow(chainRow) ? chainRow : undefined
    // Kept as a recovery session by an earlier load killed before the key went: it's there.
    const { recovery } = batch
    if (
        (await tx.getKey('sessions', recovery.sessionId)) !== undefined ||
        (await tx.getKey('tombstones', recovery.sessionId)) !== undefined
    )
        return {
            kind: 'recovery',
            sessionId: recovery.sessionId,
            chainId: recovery.chainId,
            why: 'kept at an earlier load',
        }

    // Never a recovered entry in a chain this build can't fully read (§1.6.4 step 2).
    if (session && !isReadableSessionVersion(session.v))
        return { kind: 'later', why: 'its session needs a newer version' }
    if (chain) {
        const sessions = await tx.index('sessions', 'chainId').getAll(chainId)
        if (sessions.some((row) => !isRow(row) || !isReadableSessionVersion(row.v)))
            return { kind: 'later', why: 'its chain needs a newer version' }
        if (chain.deleting !== undefined)
            return { kind: 'later', why: 'its chain is being deleted' }
    }
    if (session) {
        const range = KeyRange.bound([sessionId, -Infinity], [sessionId, Infinity])
        const entries = await tx.getAll('entries', range)
        if (entries.some((row) => !isRow(row) || !isKnownEntryKind(row.kind)))
            return { kind: 'later', why: 'its session needs a newer version' }
        // A flush already covered it (§1.6.4 step 3).
        if (typeof session.lastSeq === 'number' && session.lastSeq >= seq)
            return { kind: 'covered' }
    }

    let recoveryWhy: string | undefined
    if (tombstone !== undefined) recoveryWhy = 'its session was removed'
    else if (chain && chain.head !== sessionId) recoveryWhy = 'its session was continued'
    else if (session && !chain) recoveryWhy = 'its chain is missing'
    else if (force) recoveryWhy = force
    else recoveryWhy = await stackProblem(tx, sessionId, session, stack)

    // The stored slots an applied stack keeps in the block it changes.
    const window = session?.stack as StackWindow | undefined
    let kept: ReplaySlot[] = []
    let next: StackWindow = { base: 0, length: 1, index: 0 }
    if (!recoveryWhy && stack.keep > 0 && window) {
        const end = stack.head ? stack.keep + 1 : stack.keep
        next = storedWindow(end, stack.index, window.base)
        // The last block is rewritten: its kept slots, then the new head.
        const from = Math.max(next.base, blockOf(end - 1) * BLOCK_SLOTS)
        const slots = await readSlots(tx, sessionId, from, stack.keep)
        if (!slots) recoveryWhy = 'a kept block is missing'
        else kept = slots
    }

    const nodesToPut = []
    for (const node of [...prepared.nodes, root])
        if ((await tx.getKey('nodes', hashKey(node.hash))) === undefined) nodesToPut.push(node)

    // Writes: the snapshot first, as a flush stores it.
    let maxSeen = (await readMeta(tx, 'maxSeenTime')) ?? 0
    const now = nextTime(maxSeen, batch.wall)
    const stamp = (time: number) => (maxSeen = nextTime(maxSeen, clampTime(time, now)))
    const day = await countDayOfUse(tx, now)
    let ownBytes = 0
    for (const chunk of prepared.chunks) {
        const row = await putChunk(tx, chunk, day)
        if (row) ownBytes += row.bytes.length
    }
    for (const node of nodesToPut) {
        const row = node === root ? rootRow(root, day) : nodeRow(node as never, day)
        await tx.put('nodes', row, hashKey(node.hash))
        ownBytes += row.size
    }
    const time = stamp(now)
    applyHook?.(force)
    const headLabel = stack.head?.label ?? batch.label

    if (recoveryWhy) {
        // A new chain copied from the descriptor as a fork is (§1.6.11.2), with no binding.
        const { chainId: newChain, docId, sessionId: newSession } = batch.recovery
        const record = forkRecord(chainFieldsOf(descriptor))
        await tx.put('chains', {
            ...record,
            chainId: newChain,
            head: newSession,
            docId,
            lineageId: descriptor.lineageId,
            ...chainFlagsAtCreation('journal'),
            updatedAt: time,
            day,
            summary: batch.summary,
            appVersion: batch.appVersion,
        })
        await tx.put('sessions', {
            id: newSession,
            chainId: newChain,
            startedAt: time,
            updatedAt: time,
            day,
            origin: 'journal',
            stack: { base: 0, length: 1, index: 0 },
            lastSeq: 1,
            entryCount: 1,
            activeMs: 0,
            ownBytes,
            appVersion: batch.appVersion,
        })
        const snapshot = root.hash.slice()
        await tx.put('entries', {
            sessionId: newSession,
            seq: 1,
            time,
            day,
            kind: 'recovered',
            label: batch.label,
            snapshot,
            noteCount: root.noteCount,
            dirty: true,
            kept: true,
            stack: { keep: 0, push: [{ snapshot, label: headLabel }], index: 0 },
        })
        await tx.put('stackBlocks', blockRow(newSession, 0, 0, [{ snapshot, label: headLabel }]))
        await writeMeta(tx, 'maxSeenTime', maxSeen)
        return { kind: 'recovery', sessionId: newSession, chainId: newChain, why: recoveryWhy }
    }

    // Applied: a `recovered` entry carrying the stack, and the session's stack set to it.
    const snapshot = root.hash.slice()
    const push = stack.head ? [{ snapshot, label: headLabel }] : []
    await tx.put('entries', {
        sessionId,
        seq,
        time,
        day,
        kind: 'recovered',
        label: batch.label,
        snapshot,
        noteCount: root.noteCount,
        dirty: true,
        kept: true,
        stack: { keep: stack.keep, push, index: stack.index },
    })
    if (stack.keep === 0) next = { base: 0, length: 1, index: 0 }
    const end = next.base + next.length
    const lastBlock = blockOf(end - 1)
    const slots = [...kept, ...push]
    if (slots.length) {
        const first = end - slots.length
        await tx.put('stackBlocks', blockRow(sessionId, lastBlock, first, slots))
    }
    await tx.delete(
        'stackBlocks',
        KeyRange.bound([sessionId, lastBlock], [sessionId, Infinity], true, false),
    )
    await tx.delete(
        'stackBlocks',
        KeyRange.bound([sessionId, -Infinity], [sessionId, blockOf(next.base)], false, true),
    )

    const sessionFields = {
        updatedAt: time,
        day,
        lastSeq: seq,
        stack: next,
        appVersion: batch.appVersion,
    }
    // A session that never flushed is made with its own ids (§1.6.4 step 3); its `v` is kept.
    await tx.put(
        'sessions',
        session
            ? {
                  ...session,
                  ...sessionFields,
                  entryCount: (typeof session.entryCount === 'number' ? session.entryCount : 0) + 1,
                  ownBytes:
                      (typeof session.ownBytes === 'number' ? session.ownBytes : 0) + ownBytes,
              }
            : {
                  id: sessionId,
                  chainId,
                  ...(descriptor.v === undefined ? {} : { v: descriptor.v }),
                  // Its own start, clamped as times from outside are, never after its entry.
                  startedAt: Math.min(clampTime(descriptor.startedAt, now), time),
                  origin: descriptor.origin,
                  ...(descriptor.parent ? { parent: descriptor.parent } : {}),
                  ...sessionFields,
                  entryCount: 1,
                  activeMs: 0,
                  ownBytes,
              },
    )

    const flags = { edited: true, hasContent: true }
    const common = {
        updatedAt: time,
        day,
        summary: batch.summary,
        appVersion: batch.appVersion,
        ...flags,
    }
    if (!chain) {
        // A missing chain is made from the descriptor, with its ids, this session its head.
        await tx.put('chains', {
            ...chainFieldsOf(descriptor),
            chainId,
            head: sessionId,
            ...common,
        })
    } else {
        const fields: Row = { ...common }
        // The identity fields only as one unit, and only when safe (§1.6.4 step 4): a write-back
        // whose binding flush the tab didn't live to commit, or a first Save's on a record with
        // no binding yet (D15), never over a binding a save picker took over since (D5).
        if (
            descriptor.docId === chain.docId &&
            (descends(descriptor.revision, chain.revision) ||
                (chain.revision === undefined && chain.file === undefined)) &&
            afterReplaced(descriptor.file, chain.replaced)
        ) {
            const own = chainFieldsOf(descriptor)
            const handle = isRow(chain.file) ? chain.file.handle : undefined
            fields.revision = own.revision
            if (own.file === undefined) fields.file = undefined
            else
                fields.file = {
                    ...(own.file as Row),
                    ...(handle && isRow(own.file) && own.file.name === (chain.file as Row).name
                        ? { handle }
                        : {}),
                }
        }
        // Other known chain fields, the session being the head.
        for (const key of ['name', 'renames'] as const)
            if (descriptor[key] !== undefined) fields[key] = descriptor[key]
        const record: Row = { ...chain, ...fields }
        if (record.file === undefined) delete record.file
        await tx.put('chains', record)
    }
    await writeMeta(tx, 'maxSeenTime', maxSeen)
    return { kind: 'applied', created: !session }
}
