import { captureOperation, captureStep, type JsonValue } from '../../history/operations'
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
import { deleteHandleRow } from '../handleRows'
import { fromHex16, isHash16Hex, toHex } from '../hash'
import { KeyRange, type KvTx } from '../kv/types'
import { putChunk } from '../putChunk'
import { nodeRow, rootRow } from '../records/rows'
import {
    isKnownEntryKind,
    isNewerSessionVersion,
    isReadableSessionVersion,
} from '../records/unknownValues'
import { SESSION_V } from '../records/version'
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

// Journal replay's transaction, in the storage worker: under the
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
    /** The captured recovery operation; descriptive context is carried separately. */
    operation: JsonValue
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
    /** Kept as a separate session in a new chain. */
    | { kind: 'recovery'; sessionId: string; chainId: string; why: string }
    /** Its chain needs a newer version: left in place. */
    | { kind: 'later'; why: string }

export const JOURNAL_STORES = FLUSH_STORES

/** Why a journal of a chain marked for Delete is kept as a recovery session, never swept unseen. */
export const CHAIN_DELETING = 'its chain is being deleted'

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

/** `revision.id` of the record is among the descriptor revision's ancestors. */
const descends = (next: unknown, base: unknown) => {
    if (!isRow(next) || !isRow(base) || typeof base.id !== 'string') return false
    return Array.isArray(next.ancestors) && next.ancestors.includes(base.id)
}

/** The record has no `replaced`, or the binding's `at` is above `replaced.at`. */
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
            entries: [],
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

/** A continuation starts after its parent's last entry. */
const continuedAfter = (parent: Row | undefined) =>
    typeof parent?.updatedAt === 'number' ? parent.updatedAt + 1 : -Infinity

export const writeJournalApply = async (
    tx: KvTx,
    batch: JournalApplyBatch,
    prepared: PreparedFlush,
    /** Why an apply failed: then it's kept as a recovery session. */
    { force }: { force?: string } = {},
): Promise<JournalApplyResult> => {
    const { sessionId, seq, descriptor, stack } = batch
    const recoveredStep = captureStep({
        kind: 'edit',
        operation: batch.operation,
        recoveryContext: stack.context,
    })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const root = prepared.roots[0]!

    // Reads.
    const sessionRow = await tx.get('sessions', sessionId)
    const session = isRow(sessionRow) ? sessionRow : undefined
    const chainId = typeof session?.chainId === 'string' ? session.chainId : descriptor.chainId
    const chainRow = await tx.get('chains', chainId)
    const chain = isRow(chainRow) ? chainRow : undefined
    // Kept as a recovery session by an earlier load killed before the key went: it's there.
    const { recovery } = batch
    if ((await tx.getKey('sessions', recovery.sessionId)) !== undefined)
        return {
            kind: 'recovery',
            sessionId: recovery.sessionId,
            chainId: recovery.chainId,
            why: 'kept at an earlier load',
        }

    // Never a recovered entry in a chain this build can't fully read. A newer
    // generation is left for a newer build. A malformed one is not newer: the journal is kept as a
    // separate session through the ordinary recovery write below, never dropped before it.
    let unsupportedWhy: string | undefined
    if (session && !isReadableSessionVersion(session.v)) {
        if (isNewerSessionVersion(session.v))
            return { kind: 'later', why: 'its session needs a newer version' }
        unsupportedWhy = 'its session has an unsupported version'
    }
    if (chain) {
        const sessions = await tx.index('sessions', 'chainId').getAll(chainId)
        if (sessions.some((row) => isRow(row) && isNewerSessionVersion(row.v)))
            return { kind: 'later', why: 'its chain needs a newer version' }
        if (
            !unsupportedWhy &&
            sessions.some((row) => !isRow(row) || !isReadableSessionVersion(row.v))
        )
            unsupportedWhy = 'its chain has a session with an unsupported version'
    }
    if (session) {
        const range = KeyRange.bound([sessionId, -Infinity], [sessionId, Infinity])
        const entries = await tx.getAll('entries', range)
        if (entries.some((row) => !isRow(row) || !isKnownEntryKind(row.kind)))
            return { kind: 'later', why: 'its session needs a newer version' }
        // A flush already covered it.
        if (typeof session.lastSeq === 'number' && session.lastSeq >= seq)
            return { kind: 'covered' }
    }

    // An unstored continuation's journal: applied as its first write would be, moving
    // the head from its parent while the parent is still the head as it was continued.
    const parentRow =
        !session && chain && descriptor.origin === 'continued' && descriptor.parent
            ? await tx.get('sessions', descriptor.parent.id)
            : undefined
    const parent = isRow(parentRow) ? parentRow : undefined
    const continuing =
        parent !== undefined &&
        descriptor.parent !== undefined &&
        chain?.head === descriptor.parent.id &&
        parent.chainId === chainId &&
        parent.lastSeq === descriptor.parent.uptoSeq &&
        isReadableSessionVersion(parent.v)
    // Its stack keeps slots of the parent's stored stack, copied as the first write copies them.
    const source = continuing ? (descriptor.parent?.id ?? sessionId) : sessionId
    const based = continuing ? parent : session

    let recoveryWhy: string | undefined
    if (unsupportedWhy) recoveryWhy = unsupportedWhy
    else if (chain?.deleting !== undefined) recoveryWhy = CHAIN_DELETING
    else if (chain && chain.head !== sessionId && !continuing)
        recoveryWhy = 'its session was continued'
    else if (session && !chain) recoveryWhy = 'its chain is missing'
    else if (force) recoveryWhy = force
    else recoveryWhy = await stackProblem(tx, source, based, stack)

    // The stored slots an applied stack keeps in the block it changes.
    const window = based?.stack as StackWindow | undefined
    let kept: ReplaySlot[] = []
    let copied: ReplaySlot[] = []
    let next: StackWindow = { base: 0, length: 1, index: 0 }
    if (!recoveryWhy && stack.keep > 0 && window) {
        const end = stack.head ? stack.keep + 1 : stack.keep
        next = storedWindow(end, stack.index, window.base)
        // The last block is rewritten: its kept slots, then the new head.
        const from = Math.max(next.base, blockOf(end - 1) * BLOCK_SLOTS)
        const slots = await readSlots(tx, source, from, stack.keep)
        // A continuation has no blocks of its own: the window's earlier ones are copied too.
        const before = continuing ? await readSlots(tx, source, next.base, from) : []
        if (!slots || !before) recoveryWhy = 'a kept block is missing'
        else {
            kept = slots
            copied = before
        }
    }

    const nodesToPut = []
    for (const node of [...prepared.nodes, root])
        if ((await tx.getKey('nodes', hashKey(node.hash))) === undefined) nodesToPut.push(node)

    // Writes: the snapshot first, as a flush stores it.
    let maxSeen = (await readMeta(tx, 'maxSeenTime')) ?? 0
    const now = nextTime(maxSeen, batch.wall)
    const stamp = (time: number) => (maxSeen = nextTime(maxSeen, clampTime(time, now)))
    const day = await countDayOfUse(tx, now)
    for (const chunk of prepared.chunks) await putChunk(tx, chunk, day)
    for (const node of nodesToPut) {
        const row = node === root ? rootRow(root, day) : nodeRow(node as never, day)
        await tx.put('nodes', row, hashKey(node.hash))
    }
    const time = stamp(now)
    applyHook?.(force)
    if (recoveryWhy) {
        // A new chain copied from the descriptor as a fork is, with no binding.
        const { chainId: newChain, docId, sessionId: newSession } = batch.recovery
        const record = forkRecord(chainFieldsOf(descriptor))
        await tx.put('chains', {
            ...record,
            chainId: newChain,
            head: newSession,
            docId,
            lineageId: descriptor.lineageId,
            ...chainFlagsAtCreation('journal'),
            startedAt: time,
            updatedAt: time,
            day,
            summary: batch.summary,
            appVersion: batch.appVersion,
        })
        await tx.put('sessions', {
            id: newSession,
            v: SESSION_V,
            chainId: newChain,
            startedAt: time,
            updatedAt: time,
            day,
            origin: 'journal',
            stack: { base: 0, length: 1, index: 0 },
            lastSeq: 1,
            entryCount: 1,
            activeMs: 0,
            appVersion: batch.appVersion,
        })
        const snapshot = root.hash.slice()
        await tx.put('entries', {
            sessionId: newSession,
            seq: 1,
            time,
            day,
            kind: 'recovered',
            operation: captureOperation(batch.operation),
            recoveryContext: recoveredStep.recoveryContext,
            snapshot,
            noteCount: root.noteCount,
            dirty: true,
            kept: true,
            stack: { keep: 0, push: [{ snapshot, step: recoveredStep }], index: 0 },
        })
        await tx.put('stackBlocks', blockRow(newSession, 0, 0, [{ snapshot, step: recoveredStep }]))
        await writeMeta(tx, 'maxSeenTime', maxSeen)
        return { kind: 'recovery', sessionId: newSession, chainId: newChain, why: recoveryWhy }
    }

    // Applied: a `recovered` entry carrying the stack, and the session's stack set to it.
    const snapshot = root.hash.slice()
    const push = stack.head ? [{ snapshot, step: recoveredStep }] : []
    await tx.put('entries', {
        sessionId,
        seq,
        time,
        day,
        kind: 'recovered',
        operation: captureOperation(batch.operation),
        recoveryContext: recoveredStep.recoveryContext,
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
    for (let at = 0; at < copied.length;) {
        const slot = next.base + at
        const count = Math.min(BLOCK_SLOTS - (slot % BLOCK_SLOTS), copied.length - at)
        await tx.put(
            'stackBlocks',
            blockRow(sessionId, blockOf(slot), slot, copied.slice(at, at + count)),
        )
        at += count
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
    // Its own start, clamped as times from outside are, never after its entry.
    const startedAt = Math.min(
        Math.max(clampTime(descriptor.startedAt, now), continuedAfter(parent)),
        time,
    )
    // A session that never flushed is made with its own ids; its `v` is kept.
    await tx.put(
        'sessions',
        session
            ? {
                  ...session,
                  ...sessionFields,
                  entryCount: (typeof session.entryCount === 'number' ? session.entryCount : 0) + 1,
              }
            : {
                  id: sessionId,
                  chainId,
                  v: SESSION_V,
                  startedAt,
                  origin: descriptor.origin,
                  ...(descriptor.parent ? { parent: descriptor.parent } : {}),
                  ...sessionFields,
                  entryCount: 1,
                  activeMs: 0,
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
            // The session never flushed, so it is the chain's first.
            startedAt:
                session && typeof session.startedAt === 'number' ? session.startedAt : startedAt,
            ...common,
        })
    } else {
        // A continuation's first write moves the head to it.
        const fields: Row = { ...common, ...(continuing ? { head: sessionId } : {}) }
        // The identity fields only as one unit, and only when safe: a write-back
        // whose binding flush the tab didn't live to commit, or a first Save's on a record with
        // no binding yet, never over a binding a save picker took over since.
        if (
            descriptor.docId === chain.docId &&
            (descends(descriptor.revision, chain.revision) ||
                (chain.revision === undefined && chain.file === undefined)) &&
            afterReplaced(descriptor.file, chain.replaced)
        ) {
            const own = chainFieldsOf(descriptor)
            fields.revision = own.revision
            fields.file = own.file
            // The stored handle stays for the same file only.
            if (!isRow(own.file) || !isRow(chain.file) || own.file.name !== chain.file.name)
                await deleteHandleRow(tx, chainId, 'file')
        }
        // Other known chain fields, the session being the head.
        for (const key of ['name', 'renames'] as const)
            if (descriptor[key] !== undefined) fields[key] = descriptor[key]
        const record: Row = { ...chain, ...fields }
        // The identity unit taken without a binding or revision leaves no such field (v1's shape).
        if (record.file === undefined) delete record.file
        if (record.revision === undefined) delete record.revision
        await tx.put('chains', record)
    }
    await writeMeta(tx, 'maxSeenTime', maxSeen)
    return { kind: 'applied', created: !session }
}
