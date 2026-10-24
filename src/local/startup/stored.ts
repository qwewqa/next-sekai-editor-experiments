import { hashKey, readEpoch, readMeta } from '../db'
import type { KnownAt } from '../flushWrite'
import { splitHandles } from '../handleRows'
import { KeyRange, type KvTx } from '../kv/types'
import {
    isNewerSessionVersion,
    isReadableSessionVersion,
    sessionReadability,
} from '../records/unknownValues'
import {
    blockOf,
    blockSlot,
    replay,
    storedWindow,
    windowBlocks,
    type ReplayEntry,
    type ReplaySlot,
    type ReplayedStack,
    type StackBlockRow,
    type StackWindow,
} from '../timeline'

// Reading a stored session to open it: its row, its chain record and
// its stored stack, read in one transaction in the storage worker. "Restoring or continuing reads
// one row and its blocks"; a session without a stored stack has it rebuilt by replay.

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** A stored stack's window, its slots `base … base + length − 1`, and each stored block's span. */
export type StackRead = {
    window: StackWindow
    slots: ReplaySlot[]
    /** Blocks read back whole, with the slots each holds; empty when the stack was rebuilt. */
    blocks: { block: number; first: number; end: number }[]
}

export type SessionRead =
    | {
          kind: 'open'
          session: Row
          chain: Row
          /** Whether it's its chain's latest session. */
          isHead: boolean
          stack: StackRead
          /** The head slot's root: the state on screen. */
          head: Uint8Array
          at: KnownAt
      }
    /** No row: a session never stored. */
    | { kind: 'missing' }
    /** Its chain is marked for Delete. */
    | { kind: 'deleted' }
    /** It, or its chain, needs a newer version: never continued. */
    | { kind: 'later'; why: string }
    /** Its rows can't be read as a session: never continued. */
    | { kind: 'damaged'; why: string }

const entriesOf = async (tx: KvTx, sessionId: string, upto = Infinity) =>
    (await tx.getAll(
        'entries',
        KeyRange.bound([sessionId, -Infinity], [sessionId, upto]),
    )) as (ReplayEntry & Row)[]

/** A replayed stack, and its lowest known slot: a stored window's own base. */
type Rebuilt = { stack: ReplayedStack; floor: number }

/**
 * A session's stack by replay of its entries over its parent's at `uptoSeq`. A parent
 * whose stored stack is its stack at `uptoSeq` is taken as stored, so a long chain isn't
 * replayed from its root. Every parent link is followed, however long the chain; a session met
 * twice (a cycle in damaged rows) throws.
 */
const rebuild = async (
    tx: KvTx,
    sessionId: string,
    upto = Infinity,
    /** Whether a parent's stored stack stands for its replay. */
    stored = true,
    /** The sessions on the way up. */
    seen = new Set<string>(),
): Promise<Rebuilt> => {
    if (seen.has(sessionId)) throw new Error(`Parent cycle at ${sessionId}`)
    seen.add(sessionId)
    const session = await tx.get('sessions', sessionId)
    if (!isRow(session)) throw new Error(`No session ${sessionId}`)
    if (!isReadableSessionVersion(session.v)) throw new Error(`Unsupported session ${sessionId}`)
    const parent = session.parent as { id?: unknown; uptoSeq?: unknown } | undefined
    let inherited: Rebuilt | undefined
    if (typeof parent?.id === 'string' && typeof parent.uptoSeq === 'number')
        inherited =
            (stored ? await storedAt(tx, parent.id, parent.uptoSeq) : undefined) ??
            (await rebuild(tx, parent.id, parent.uptoSeq, stored, seen))
    return {
        stack: replay(await entriesOf(tx, sessionId, upto), inherited?.stack),
        floor: inherited?.floor ?? 0,
    }
}

/** A session's stored stack when it's its stack at `upto`; slots below the window unknown. */
const storedAt = async (
    tx: KvTx,
    sessionId: string,
    upto: number,
): Promise<Rebuilt | undefined> => {
    const session = await tx.get('sessions', sessionId)
    if (
        !isRow(session) ||
        !isReadableSessionVersion(session.v) ||
        session.lastSeq !== upto ||
        !isWindow(session.stack)
    )
        return
    const read = await readStored(tx, sessionId, session.stack)
    if (!read) return
    // Holes below the window: an undo onto one fails replay, as a missing slot does.
    const slots: ReplaySlot[] = []
    slots.length = read.window.base
    slots.push(...read.slots)
    return { stack: { slots, index: read.window.index }, floor: read.window.base }
}

/** The stored window's slots and blocks, or undefined when a block lacks one. */
const readStored = async (
    tx: KvTx,
    sessionId: string,
    window: StackWindow,
): Promise<StackRead | undefined> => {
    const { first, last } = windowBlocks(window)
    const rows = new Map<number, StackBlockRow | undefined>()
    for (let block = first; block <= last; block++)
        rows.set(block, (await tx.get('stackBlocks', [sessionId, block])) as StackBlockRow)
    const slots: ReplaySlot[] = []
    for (let slot = window.base; slot < window.base + window.length; slot++) {
        const found = blockSlot(rows.get(blockOf(slot)), slot)
        if (!found) return
        slots.push(found)
    }
    const blocks: StackRead['blocks'] = []
    for (const [block, row] of rows)
        if (row) blocks.push({ block, first: row.first, end: row.first + row.steps.length })
    return { window, slots, blocks }
}

/** A window of replay's stack, as a stored one would be: rewritten whole by the next flush. */
const fromReplay = ({ stack, floor }: Rebuilt): StackRead => {
    const window = storedWindow(stack.slots.length, stack.index, floor)
    return {
        window,
        slots: stack.slots.slice(window.base, window.base + window.length),
        blocks: [],
    }
}

const isWindow = (value: unknown): value is StackWindow =>
    isRow(value) &&
    Number.isSafeInteger(value.base) &&
    Number.isSafeInteger(value.length) &&
    Number.isSafeInteger(value.index) &&
    (value.length as number) > 0 &&
    (value.base as number) <= (value.index as number) &&
    (value.index as number) < (value.base as number) + (value.length as number)

/** Reads a session to open it: continued by a new visit or Reopen, or taken up by a reload. */
export const readSessionForOpen = async (tx: KvTx, sessionId: string): Promise<SessionRead> => {
    const session = await tx.get('sessions', sessionId)
    if (!isRow(session)) return { kind: 'missing' }
    if (typeof session.chainId !== 'string') return { kind: 'damaged', why: 'no chainId' }
    const chain = await tx.get('chains', session.chainId)
    if (!isRow(chain)) return { kind: 'damaged', why: 'no chain record' }
    if (chain.deleting !== undefined) return { kind: 'deleted' }
    // One session this build can't read makes the chain "Needs a newer version".
    // A newer generation is "Needs a newer version"; an older or malformed one is not newer, and
    // is not read either.
    const sessions = await tx.index('sessions', 'chainId').getAll(session.chainId)
    if (sessions.some((row) => isRow(row) && isNewerSessionVersion(row.v)))
        return { kind: 'later', why: 'its chain needs a newer version' }
    if (sessions.some((row) => !isRow(row) || !isReadableSessionVersion(row.v)))
        return { kind: 'damaged', why: 'its chain has a session of an unsupported generation' }
    if (!Number.isSafeInteger(session.updatedAt) || (session.updatedAt as number) < 0)
        return { kind: 'damaged', why: 'invalid last entry time' }
    // Every entry, whoever wrote it: an unknown kind is never continued.
    const entries = await entriesOf(tx, sessionId)
    const entriesRead = sessionReadability({ row: session, entryKinds: entries.map((e) => e.kind) })
    if (entriesRead === 'newer') return { kind: 'later', why: 'its session needs a newer version' }

    let stack: StackRead | undefined
    if (isWindow(session.stack)) stack = await readStored(tx, sessionId, session.stack)
    if (!stack)
        try {
            stack = fromReplay(await rebuild(tx, sessionId))
        } catch {
            // Over a stored parent, a later entry can keep slots below its window: the whole
            // chain's replay then tells.
            try {
                stack = fromReplay(await rebuild(tx, sessionId, Infinity, false))
            } catch (error) {
                return { kind: 'damaged', why: `its stack: ${String(error)}` }
            }
        }
    const head = stack.slots[stack.window.index - stack.window.base]
    if (!head) return { kind: 'damaged', why: 'no head slot' }
    // The head's root `v` is checked before it is decoded: a root a newer build wrote is not damage.
    const headRoot = await tx.get('nodes', hashKey(head.snapshot))
    if (headRoot === undefined) return { kind: 'damaged', why: 'its head is not stored' }
    if (isRow(headRoot) && headRoot.t === 'root') {
        const readability = sessionReadability({ row: session, rootVersions: [headRoot.v] })
        if (readability === 'newer') return { kind: 'later', why: 'its head needs a newer version' }
        if (readability === 'unsupported')
            return { kind: 'damaged', why: 'its head is of an unsupported record version' }
    }
    return {
        kind: 'open',
        session,
        chain,
        isHead: chain.head === sessionId,
        stack,
        head: head.snapshot,
        at: { db: (await readMeta(tx, 'dbInstanceId')) ?? '', epoch: await readEpoch(tx) },
    }
}

/** The most recent session a new visit continues, and why the newest chain was passed over. */
export type NewestRead = {
    read?: SessionRead & { kind: 'open' }
    /** The newest chain's head couldn't be opened: an older one, or none, is continued. */
    skipped?: 'later' | 'damaged'
}

/**
 * The most recent session: the head of the chain record with the newest `updatedAt`,
 * skipping chains being deleted and chains this build can't read or open.
 */
export const readNewestSession = async (tx: KvTx): Promise<NewestRead> => {
    const chains = await tx.entries('chains', { index: 'updatedAt', direction: 'prev' })
    let skipped: NewestRead['skipped']
    for (const { value } of chains) {
        if (!isRow(value) || value.deleting !== undefined || typeof value.head !== 'string')
            continue
        const read = await readSessionForOpen(tx, value.head)
        if (read.kind === 'open') return { read, ...(skipped ? { skipped } : {}) }
        if (!skipped && (read.kind === 'later' || read.kind === 'damaged')) skipped = read.kind
    }
    return skipped ? { skipped } : {}
}

/** What a chain-field write did. */
export type ChainFieldsResult =
    | { kind: 'stored'; chain: Row }
    | { kind: 'notHead'; lastSeq: number; lastTime: number }
    | { kind: 'missing' }

/**
 * Writes chain fields field by field, only from the chain's head session: `null`
 * removes a field, and every other field of the record stays as it is.
 */
export const writeChainFields = async (
    tx: KvTx,
    {
        chainId,
        sessionId,
        fields,
        appVersion,
    }: { chainId: string; sessionId: string; fields: Row; appVersion: string },
): Promise<ChainFieldsResult> => {
    const chain = await tx.get('chains', chainId)
    if (!isRow(chain)) return { kind: 'missing' }
    const session = await tx.get('sessions', sessionId)
    if (!isRow(session) || !isReadableSessionVersion(session.v)) return { kind: 'missing' }
    if (chain.head !== sessionId) {
        if (
            !Number.isSafeInteger(session.lastSeq) ||
            (session.lastSeq as number) < 0 ||
            !Number.isSafeInteger(session.updatedAt) ||
            (session.updatedAt as number) < 0
        )
            return { kind: 'missing' }
        return {
            kind: 'notHead',
            lastSeq: session.lastSeq as number,
            lastTime: session.updatedAt as number,
        }
    }
    const record: Row = { ...chain, appVersion }
    // A binding's or Export target's handle goes in its own store.
    for (const [key, value] of Object.entries(await splitHandles(tx, chainId, fields)))
        if (value === null || value === undefined) Reflect.deleteProperty(record, key)
        else record[key] = value
    await tx.put('chains', record)
    return { kind: 'stored', chain: record }
}

/** Every held session's chain and binding, for the bound-elsewhere check. */
export const readBindings = async (tx: KvTx, sessionIds: readonly string[]) => {
    const found: { sessionId: string; chainId: string; file: Row }[] = []
    for (const sessionId of sessionIds) {
        const session = await tx.get('sessions', sessionId)
        if (!isRow(session) || typeof session.chainId !== 'string') continue
        const chain = await tx.get('chains', session.chainId)
        if (isRow(chain) && isRow(chain.file))
            found.push({ sessionId, chainId: session.chainId, file: chain.file })
    }
    return found
}
