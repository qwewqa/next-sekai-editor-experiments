import {
    captureEntryDescription,
    captureStep,
    type EntryDescription,
    type UndoableStep,
} from '../../history/operations'
import { KeyRange, type KvTx } from '../kv/types'
import {
    storedSlots,
    windowBlocks,
    type ReplaySlot,
    type StackBlockRow,
    type StackWindow,
} from '../timeline'

// A build's consistent cut: the chain record, its session rows,
// their entries and the saved session's stack blocks, read in one read-only transaction. Bodies
// are immutable, and no remover touches a chain while a build holds one of its session locks
// (deletion R3), so they can follow in later transactions.

export const CUT_STORES = ['chains', 'sessions', 'entries', 'stackBlocks'] as const

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** A stored entry row as the writer reads it. */
export type EntryRow = EntryDescription & {
    sessionId: string
    seq: number
    time: number
    snapshot: Uint8Array
    /** The state's note count; absent when the row doesn't say (never taken as 0, HS-1). */
    noteCount?: number
    dirty: boolean
    kept: boolean
    revisionId?: string
    device?: { id: string; label: string }
    appVersion?: string
    stack?: { keep: number; push: { snapshot: Uint8Array; step: UndoableStep }[]; index: number }
    x?: Record<string, unknown>
}

export type SessionRow = {
    id: string
    v?: unknown
    chainId: string
    startedAt: number
    parent?: { id: string; uptoSeq: number }
    stack?: StackWindow
    lastSeq: number
    importPending?: true
}

/** The chain's binding as stored, the fields the writer reads. */
export type StoredBinding = {
    name?: string
    event?: string
    entry?: {
        sessionId: string
        seq: number
        startedAt: number
        count: number
        notKept: number
        inexact?: true
    }
    completeFrom?: string
    disk?: { revisionId?: string; fingerprint: string; size: number; lastModified: number }
}

export type ChainRecord = Row & {
    chainId: string
    head?: string
    docId: string
    lineageId: string
    revision?: { id: string; n: number; ancestors: string[] }
    name?: string
    exportName?: string
    file?: StoredBinding
    extra?: Record<string, unknown>
}

/** The saved session's stored stack: its window and slots (undefined when a block lacks one). */
export type StoredStackCut = { window: StackWindow; slots: ReplaySlot[] | undefined }

export type ChainCut = {
    chain: ChainRecord
    sessions: SessionRow[]
    /** Each session's entries by `seq`; an entry that doesn't read is left out and counted. */
    entries: Map<string, EntryRow[]>
    /** Rows that didn't read as entries: the chain is not usable by this build. */
    unreadable: number
    /** The saved session (the head, or Recent Sessions' Save…'s) and its stored stack. */
    sessionId: string | undefined
    stack?: StoredStackCut
}

const isHash = (value: unknown): value is Uint8Array =>
    value instanceof Uint8Array && value.byteLength === 16

const readSlots = (value: unknown) => {
    if (!Array.isArray(value)) return
    const slots: { snapshot: Uint8Array; step: UndoableStep }[] = []
    for (const slot of value as unknown[]) {
        if (!isRow(slot) || !isHash(slot.snapshot)) return
        try {
            slots.push({ snapshot: slot.snapshot, step: captureStep(slot.step) })
        } catch {
            return
        }
    }
    return slots
}

/** An entry row's fields, or undefined when it doesn't read. */
export const readEntryRow = (value: unknown): EntryRow | undefined => {
    if (!isRow(value)) return
    const { sessionId, seq, time, kind, snapshot, noteCount } = value
    if (
        typeof sessionId !== 'string' ||
        !Number.isSafeInteger(seq) ||
        typeof time !== 'number' ||
        typeof kind !== 'string' ||
        !isHash(snapshot)
    )
        return
    let description: EntryDescription
    try {
        description = captureEntryDescription(value)
    } catch {
        return
    }
    const row: EntryRow = {
        sessionId,
        seq: seq as number,
        time,
        ...description,
        snapshot,
        dirty: value.dirty === true,
        kept: value.kept !== false,
    }
    if (Number.isSafeInteger(noteCount) && (noteCount as number) >= 0)
        row.noteCount = noteCount as number
    if (typeof value.revisionId === 'string') row.revisionId = value.revisionId
    const device = value.device
    if (isRow(device) && typeof device.id === 'string' && typeof device.label === 'string')
        row.device = { id: device.id, label: device.label }
    if (typeof value.appVersion === 'string') row.appVersion = value.appVersion
    if (value.stack !== undefined) {
        const stack = value.stack
        const push = isRow(stack) ? readSlots(stack.push) : undefined
        if (
            !isRow(stack) ||
            !push ||
            !Number.isSafeInteger(stack.keep) ||
            !Number.isSafeInteger(stack.index)
        )
            return
        row.stack = { keep: stack.keep as number, push, index: stack.index as number }
    }
    if (isRow(value.x) && !Array.isArray(value.x)) row.x = value.x
    return row
}

const readSession = (value: unknown): SessionRow | undefined => {
    if (!isRow(value)) return
    const { id, chainId, startedAt, lastSeq } = value
    if (typeof id !== 'string' || typeof chainId !== 'string' || typeof startedAt !== 'number')
        return
    const session: SessionRow = {
        id,
        v: value.v,
        chainId,
        startedAt,
        lastSeq: Number.isSafeInteger(lastSeq) ? (lastSeq as number) : 0,
    }
    const parent = value.parent
    if (isRow(parent) && typeof parent.id === 'string' && Number.isSafeInteger(parent.uptoSeq))
        session.parent = { id: parent.id, uptoSeq: parent.uptoSeq as number }
    const stack = value.stack
    if (
        isRow(stack) &&
        Number.isSafeInteger(stack.base) &&
        Number.isSafeInteger(stack.length) &&
        Number.isSafeInteger(stack.index)
    )
        session.stack = {
            base: stack.base as number,
            length: stack.length as number,
            index: stack.index as number,
        }
    if (value.importPending === true) session.importPending = true
    return session
}

/** A session's entry rows, by `seq`. */
const sessionEntries = (tx: KvTx, sessionId: string) =>
    tx.getAll('entries', KeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]))

/**
 * Reads the cut in one read-only transaction (its stores: `CUT_STORES`). `sessionId` is the
 * session whose stack the write takes: the chain's head unless given. Undefined when there's no
 * such chain.
 */
export const readCut = async (
    tx: KvTx,
    chainId: string,
    sessionId?: string,
): Promise<ChainCut | undefined> => {
    const chain = await tx.get('chains', chainId)
    if (!isRow(chain) || typeof chain.docId !== 'string') return
    const sessions: SessionRow[] = []
    const entries = new Map<string, EntryRow[]>()
    let unreadable = 0
    for (const value of await tx.index('sessions', 'chainId').getAll(chainId)) {
        const session = readSession(value)
        if (!session) {
            unreadable++
            continue
        }
        sessions.push(session)
        const rows: EntryRow[] = []
        for (const row of await sessionEntries(tx, session.id)) {
            const entry = readEntryRow(row)
            if (entry) rows.push(entry)
            else unreadable++
        }
        entries.set(session.id, rows)
    }
    const saved = sessionId ?? (typeof chain.head === 'string' ? chain.head : undefined)
    let stack: StoredStackCut | undefined
    const window = sessions.find((session) => session.id === saved)?.stack
    if (saved !== undefined && window && window.length > 0) {
        const blocks = new Map<number, StackBlockRow>()
        const { first, last } = windowBlocks(window)
        for (let block = first; block <= last; block++) {
            const row = await tx.get('stackBlocks', [saved, block])
            if (isRow(row) && row.hashes instanceof Uint8Array && Array.isArray(row.steps))
                blocks.set(block, row as unknown as StackBlockRow)
        }
        stack = { window, slots: storedSlots(window, (block) => blocks.get(block)) }
    }
    return {
        chain: chain as ChainRecord,
        sessions,
        entries,
        unreadable,
        sessionId: saved,
        ...(stack ? { stack } : {}),
    }
}
