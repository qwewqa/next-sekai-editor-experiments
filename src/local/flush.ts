import {
    captureEntryDescription,
    captureOperation,
    captureStep,
    pushedStep,
    type EntryDescription,
    type JsonValue,
    type RecoveryContext,
    type UndoableStep,
} from '../history/operations'
import type { State } from '../state'
import { forkRecord } from './chainFields'
import {
    ChunkBatch,
    Extractor,
    runSliced,
    runToEnd,
    type ChunkMemo,
    type SnapshotPlan,
} from './chunks'
import type {
    BatchMedia,
    BatchSnapshot,
    BatchStack,
    ChainSummary,
    FlushBatch,
    FlushResult,
    SessionOrigin,
    SessionView,
    WriteStats,
} from './flushWrite'
import { toHex } from './hash'
import type { IdentityUnit } from './save/commit'
import type { LockLease } from './sessions'
import {
    isEditingKind,
    SessionStack,
    SlotStack,
    type ModelSlot,
    type StackPlan,
    type StackWindow,
    type StoredAt,
} from './timeline'

export { onFlushCommitted } from './worker/flushHooks'

// The main thread's flush (Part 1 §1.6.4 step 2): entries are appended synchronously with their
// `State`, and about 1 s after the last change their snapshots are extracted through the identity
// memo, in slices of about 8 ms, and sent to the storage worker as bytes. On hide, before a
// switch and right after a media pick it runs at once and strictly. Entries stay pending until
// the worker acknowledges the transaction that stored them, so a failed or killed flush loses
// nothing: the next one, or the restarted worker, gets them again. Entries an in-memory store
// acknowledged are kept too, until a database holds them, since a restarted worker's memory is new;
// where no database ever will, only the current session's (the journal covers the head).

/** An entry not yet acknowledged by the worker, holding its state. */
export type PendingEntry = EntryDescription & {
    readonly seq: number
    readonly wall: number
    /** The state it produced or landed on; absent for an undo or redo onto a slot not loaded. */
    readonly state?: State
    /** That slot's stored root, when there's no state. */
    readonly snapshot?: Uint8Array
    readonly dirty: boolean
    /** A journal-only reload resets its unavailable stack to this one current-state slot. */
    readonly recoveryBaseline?: UndoableStep
    /** A `save` entry's revision, device and the app version that wrote it (§1.3.3). */
    readonly revisionId?: string
    readonly device?: { readonly id: string; readonly label: string }
    readonly appVersion?: string
}

/** A Save's identity unit waiting for its flush: committed with its `save` entry (§1.3.2). */
export type PendingIdentity = IdentityUnit & {
    /** The `save` entry's `seq`: the unit goes with the batch that stores it, or a later one. */
    readonly seq: number
}

/** What a Save reserved (§1.6.11.6): its `save` entry's `seq` in the current session. */
export type SaveReservation = {
    readonly session: FlushSession
    readonly seq: number
    readonly wall: number
}

/** The `save` entry a Save's end adds: a `PendingEntry` without what the flusher decides. */
export type SaveEntryInput = Omit<PendingEntry, 'seq' | 'kind' | 'dirty' | 'step' | 'operation'> & {
    operation: JsonValue
}

/**
 * What `Flusher.endSave` did: 'added' the `save` entry; 'kept' the `seq` with no entry (a file
 * that may hold it); 'letGo' (a trailing `seq` is handed out again); 'notCurrent' (an entry was
 * given but the session is no longer current: nothing added, the `seq` kept); or 'ended' (not the
 * session's current reservation: nothing changed).
 */
export type EndSaveResult = 'added' | 'kept' | 'letGo' | 'notCurrent' | 'ended'

export type FlushSession = {
    readonly id: string
    chainId: string
    docId: string
    readonly lineageId: string
    readonly origin: SessionOrigin
    readonly startedAt: number
    readonly sourceName?: string
    /** A fork's old chain, whose record it copies (§1.3.1). */
    readonly forkOf?: string
    /** The stored session it continues: a continuation's, or a fork's (D10). */
    readonly parent?: { readonly id: string; readonly uptoSeq: number }
    /**
     * A continuation (a new visit, Reopen): stored from its first own entry, its `continue` entry
     * first; its first write moves the chain's head from the parent (§1.3.1, §1.3.6).
     */
    readonly continuation?: boolean
    /** Stored at once whatever its origin: it set chain fields before its first write. */
    atOnce?: boolean
    /** A fork's name on the record it makes, "<name> (2)" (§1.3.1). */
    readonly forkName?: string
    /** Chain fields set before its first write, `null` removing: written with its record. */
    chainSet?: Record<string, unknown>
    /** Whether a flush of it has committed. */
    stored: boolean
    nextSeq: number
    /**
     * The newest `seq` of an entry this session holds, stored, pending or in memory only: the
     * journal's `seq` (§1.6.4). Never a reserved or skipped one, and never lowered.
     */
    entrySeq: number
    readonly pending: PendingEntry[]
    /** Acknowledged by an in-memory store only: sent again after a worker restart. */
    readonly memoryOnly: PendingEntry[]
    /** Resolves once this tab holds the session's lock (§1.6.6). */
    readonly ready: Promise<unknown>
    /** Its stack as acknowledged, which each flush's entries are replayed over (§1.6.4 #6). */
    readonly stack: SessionStack<PendingEntry>
    /** The newest entry acknowledged from a database, and the newest committed strictly. */
    ackedSeq: number
    strictSeq: number
    /** Whether it has an entry of an editing kind (§1.6.11.2's `edited`). */
    edited: boolean
    /** Its chain record as the last flush wrote it, for the journal's descriptor. */
    chain?: Record<string, unknown>
    /** Runs once the session is replaced and nothing of it is pending: releases its lock. */
    done?: () => void
    /** An unstored continuation's hold on its parent (§1.3.6): released at its first write. */
    parentDone?: () => void
    /**
     * A continuation that started from a journal holds its parent until the journal's key goes
     * (`releaseParent`) or the session ends, not until its first write.
     */
    journalParent?: () => void
    /**
     * A Save's reservation (§1.6.11.6): entries after its `seq` wait until the Save appends its
     * `save` entry or lets the `seq` go, so the entry is never behind a stored one. Ended by the
     * object, never by its `seq`: a later Save may reserve the same one.
     */
    reserved?: SaveReservation
    /** A Save's identity unit not stored yet (storage paused or full: the binding in memory). */
    identity?: PendingIdentity
}

export type SessionStart = {
    id: string
    docId: string
    origin: SessionOrigin
    sourceName?: string
    state: State
    operation: JsonValue
    dirty: boolean
    ready?: Promise<unknown>
    /** The session's lock: the flusher takes it as the session registers (A7). */
    lock?: LockLease
}

/** A stored stack as read for opening: slots from `first`, every slot a stored root. */
export type StoredStack = {
    first: number
    slots: { hash: Uint8Array; step: UndoableStep }[]
    index: number
}

/** A new session continuing a stored one (§1.3.1): in its chain, or as a fork of it. */
export type ContinueStart = {
    id: string
    chainId: string
    docId: string
    lineageId: string
    sourceName?: string
    parent: { id: string; uptoSeq: number }
    /** The parent's stack at `uptoSeq`, which the continuation's first write copies whole. */
    stack: StoredStack
    /** The chain record as read: the journal's descriptor carries it until the first write. */
    chain: Record<string, unknown>
    /** The captured `continue` operation. */
    operation: JsonValue
    dirty: boolean
    /** A fork: a new chain copied from `forkOf`'s record, with `forkName`. */
    fork?: { forkOf: string; forkName?: string }
    ready?: Promise<unknown>
    lock?: LockLease
    /** The hold on the parent, taken with `lock`: released once the first write commits. */
    parentLock?: LockLease
    /** The hold on the parent stays until `releaseParent` (a start from a journal). */
    parentUntilReleased?: boolean
}

/** A stored session taken up again by its own tab's reload (§1.4.2): no entry is added. */
export type ResumeStart = {
    id: string
    chainId: string
    docId: string
    lineageId: string
    origin: SessionOrigin
    startedAt: number
    parent?: { id: string; uptoSeq: number }
    sourceName?: string
    lastSeq: number
    chain: Record<string, unknown>
    stack: StoredStack & {
        window: StackWindow
        blocks: { block: number; first: number; end: number }[]
        at: StoredAt
    }
    ready?: Promise<unknown>
    lock?: LockLease
}

/** What writing chain fields found (§1.3.1: only the chain's head writes its record). */
export type ChainWriteResult =
    | { kind: 'stored'; chain: Record<string, unknown> }
    | { kind: 'notHead'; lastSeq: number; lastTime: number }
    | { kind: 'missing' }

/**
 * Sends a batch. `current` says whether the batch was planned for the worker that is running
 * now: the transport refuses one planned before a restart, and the flusher plans it again.
 */
export type FlushTransport = (
    batch: FlushBatch,
    transfer: Transferable[],
    current: () => boolean,
) => Promise<FlushResult>

/** One flush's figures, for the timing and budget specs. */
export type FlushReport = {
    sessionId: string
    entries: number
    newChunks: number
    textBytes: number
    /** Main-thread time: extraction slices plus building the batch. */
    mainMs: number
    slices: number[]
    strict: boolean
    stats: WriteStats
}

export type FlushDeps = {
    transport: FlushTransport
    appVersion: string
    now?: () => number
    newId?: () => string
    view?: () => SessionView | undefined
    /** The lock of a session the flusher starts itself (a fork): taken as the fork registers. */
    lockSession?: (id: string) => LockLease
    /** A session's chain was continued elsewhere: its further entries went to this fork (D10). */
    onFork?: (fork: FlushSession, from: FlushSession) => void
    /** A fork's name from its old session: "<name> (2)" (§1.3.1). */
    forkName?: (from: FlushSession) => string | undefined
    /** Captures a `continue` operation from the source entry time. */
    continueOperation: (fromTime: number) => JsonValue
    /** A Save's identity unit was stored in a database. */
    onIdentity?: (session: FlushSession, identity: PendingIdentity) => void
    /** A Save's identity unit was dropped: its binding was taken over meanwhile. */
    onStaleIdentity?: (session: FlushSession) => void
    /** A `seq` a Save reserved in this session before a reload: resumed sessions go past it. */
    reservedSeq?: (sessionId: string) => number | undefined
    /** Writes chain fields of a stored session, checking it's still the chain's head. */
    writeChain?: (request: {
        chainId: string
        sessionId: string
        fields: Record<string, unknown>
        appVersion: string
    }) => Promise<ChainWriteResult>
    /**
     * Stores a media item alone, after its flush's read-back failed (§1.6.8.4): resolves whether
     * it's stored right now. Without it the item is left not held in storage.
     */
    storeMedia?: (item: BatchMedia) => Promise<boolean>
    onFlushed?: (report: FlushReport) => void
    /** The roots a flush stored for its entries' states, so peek can find them in memory. */
    onRoots?: (roots: readonly (readonly [State, Uint8Array])[]) => void
    /** A flush or a strict sync committed a session's entries up to `seq` in a database. */
    onCommitted?: (session: FlushSession, commit: { seq: number; strict: boolean }) => void
    /**
     * Commits strictly what relaxed flushes stored (§1.6.4: a journal is cleared only once a
     * strict commit covers its `seq`); without it, a hide's flush with nothing new does nothing.
     */
    syncStrict?: () => Promise<boolean>
    onError?: (error: unknown) => void
    /** Runs an extraction in slices; `runSliced` by default. */
    runJob?: typeof runSliced
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (handle: unknown) => void
}

/** About 1 s after the last change (an internal constant; §1.6.4). */
export const FLUSH_DELAY_MS = 1000
/** Entries in one batch at most, and about this much new text, so one transaction stays short. */
export const BATCH_ENTRIES = 64
export const BATCH_TEXT = 2 * 1024 * 1024
/** After a failed flush, the next try waits this long, doubling up to the maximum. */
export const RETRY_MS = 5000
export const RETRY_MAX_MS = 60_000
/** Attempts of one batch: missing windows re-sent, before it counts as failed. */
const ATTEMPTS = 4
/** Tries at storing a media item alone, with the flush's backoff, before it's left not held. */
export const MEDIA_ATTEMPTS = 6

type FlushOptions = { strict?: boolean; oneGo?: boolean }

/**
 * A call's timeout by the bytes it carries (§1.6.5): the usual 10 s, and a second more per MB,
 * since a large BGM is hashed, stored and read back in it.
 */
export const mediaTimeoutMs = (bytes: number) => 10_000 + bytes / 1000

/** A flush call's timeout, by its text and media. */
export const flushTimeoutMs = (batch: FlushBatch) =>
    mediaTimeoutMs(
        batch.text.byteLength + batch.media.reduce((sum, item) => sum + item.bytes.byteLength, 0),
    )

/** A media item a state holds the bytes of: the BGM's `Bgm.source` (§1.6.8.4). */
export const heldMediaOf = (state: State): BatchMedia[] => {
    const { meta, source } = state.bgm
    return meta && source
        ? [
              {
                  hash: meta.hash,
                  bytes: source,
                  type: meta.type,
                  ...(meta.filename ? { filename: meta.filename } : {}),
                  kind: 'bgm',
              },
          ]
        : []
}

/** The unit as a batch carries it. */
const unitOf = ({
    docId,
    revision,
    file,
    marks,
    from,
    clearExport,
}: PendingIdentity): IdentityUnit => ({
    docId,
    revision,
    file,
    marks,
    ...(from ? { from } : {}),
    ...(clearExport ? { clearExport } : {}),
})

/** Recent Sessions' summary of a head (§1.6.11.2). */
export const summaryOf = (state: State, noteCount: number): ChainSummary => {
    const { title, artists, author, rating, tags } = state.levelInfo
    return {
        ...(title ? { title } : {}),
        ...(artists ? { artists } : {}),
        ...(author ? { author } : {}),
        ...(rating === undefined ? {} : { rating }),
        ...(tags.length ? { tags: tags.map((tag) => tag.title) } : {}),
        noteCount,
    }
}

/**
 * Removes exactly the entries a batch sent from `pending`, in place, and returns them in order. By
 * identity, never by count: an entry joins `pending` between others while a batch is in flight
 * (a restart's re-sends), and must stay until a batch of its own stores it.
 */
const acknowledge = (pending: PendingEntry[], sent: readonly PendingEntry[]) => {
    const ids = new Set(sent)
    const acknowledged: PendingEntry[] = []
    let kept = 0
    for (const entry of pending)
        if (ids.has(entry)) acknowledged.push(entry)
        else pending[kept++] = entry
    pending.length = kept
    return acknowledged
}

const encoder = new TextEncoder()

/** A batch's new chunks as one buffer of UTF-8 text and each one's end. */
const encodeTexts = (texts: readonly string[]) => {
    const parts = texts.map((text) => encoder.encode(text))
    const ends: number[] = []
    let total = 0
    for (const part of parts) ends.push((total += part.length))
    const text = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
        text.set(part, at)
        at += part.length
    }
    return { text, ends }
}

export class Flusher {
    readonly extractor = new Extractor()
    private readonly sessions: FlushSession[] = []
    private current: FlushSession | undefined
    private running: Promise<void> = Promise.resolve()
    /** The running drain's options: a hide makes them strict and one-go. */
    private active: { strict: boolean; oneGo: boolean } | undefined
    /** Finishes the running sliced extraction at once. */
    private hurry: (() => void) | undefined
    /** Counts worker restarts: a batch planned before one is planned again. */
    private generation = 0
    private timer: unknown
    /** Media this tab knows stored; others it holds go with the next flush naming them. */
    private readonly knownMedia = new Set<string>()
    /** Media the worker found missing: sent again with their bytes. */
    private readonly resendMedia = new Set<string>()
    /** Media sent in a flush not yet answered: read back even if found stored (§1.6.8.4). */
    private readonly unconfirmed = new Set<string>()
    /**
     * Media whose read-back failed: stored again alone, with backoff, and left out of flushes
     * meanwhile, so it never holds back the history (§1.6.8.4).
     */
    private readonly failedMedia = new Map<string, BatchMedia>()
    private mediaTimer: unknown
    private mediaRetryMs = 0
    private mediaAttempts = 0
    private readonly now: () => number
    private readonly newId: () => string
    private readonly setTimer: (fn: () => void, ms: number) => unknown
    private readonly clearTimer: (handle: unknown) => void
    /** No database will answer in this tab: replaced sessions keep no in-memory history. */
    private noDatabase = false
    /** Whether the last flush failed: storing is paused, and it retries later. */
    failed = false
    /** Whether the last strict sync failed or reached only an in-memory store. */
    syncFailed = false
    /**
     * The replaced session's strict commit at the last `begin()` (§1.3.8): resolves whether
     * everything of it is committed strictly in a database, for Step 4's switch prompt.
     */
    outgoing: Promise<boolean> = Promise.resolve(true)
    private retryMs = 0
    private readonly entryListeners = new Set<() => void>()

    /**
     * Calls `listener` whenever an entry joins a session's pending list or a fork takes some over,
     * whatever made it: an edit, a Save's entry, a continuation, a recovery. What shows the entries
     * (the Timeline) follows this, not each producer. Returns the way to stop.
     */
    onEntry(listener: () => void) {
        this.entryListeners.add(listener)
        return () => void this.entryListeners.delete(listener)
    }

    private entered() {
        for (const listener of [...this.entryListeners]) listener()
    }

    constructor(private readonly deps: FlushDeps) {
        this.now = deps.now ?? Date.now
        this.newId = deps.newId ?? (() => crypto.randomUUID())
        this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
        this.clearTimer =
            deps.clearTimer ??
            ((handle) => {
                clearTimeout(handle as ReturnType<typeof setTimeout>)
            })
    }

    get session() {
        return this.current
    }

    /** Whether any entry is waiting for the worker. */
    get hasPending() {
        return this.sessions.some((session) => session.pending.length > 0)
    }

    /**
     * Starts a session with its first entry (§1.3.6): `init`. A new or blank session is stored
     * from its first own entry; one that brings content in is stored at once. The replaced
     * session is committed strictly (§1.3.8): its pending entries, or what relaxed flushes stored.
     */
    begin(start: SessionStart): FlushSession {
        const session: FlushSession = {
            id: start.id,
            chainId: this.newId(),
            docId: start.docId,
            lineageId: this.newId(),
            origin: start.origin,
            startedAt: this.now(),
            ...(start.sourceName === undefined ? {} : { sourceName: start.sourceName }),
            stored: false,
            nextSeq: 1,
            entrySeq: 0,
            pending: [],
            memoryOnly: [],
            ready: start.ready ?? Promise.resolve(),
            stack: new SessionStack(),
            ackedSeq: 0,
            strictSeq: 0,
            edited: false,
        }
        this.add(session, { kind: 'init', operation: start.operation }, start.state, start.dirty)
        return this.switchTo(session, start)
    }

    /**
     * Continues a stored session in a new one (§1.3.1): its `continue` entry first, pointing at
     * the parent's head, over the parent's stack. Stored from its first own entry, when its write
     * moves the chain's head, or as a fork, a new chain copied from the old record.
     */
    continueSession(start: ContinueStart): FlushSession {
        const stack = new SessionStack<PendingEntry>()
        stack.committed = new SlotStack<ModelSlot<PendingEntry>>(
            start.stack.first,
            start.stack.slots.map(({ hash, step }) => ({ hash, step: captureStep(step) })),
            start.stack.index,
        )
        const head = start.stack.slots[start.stack.index - start.stack.first]
        if (!head) throw new RangeError('The index is outside the stack')
        const fork = start.fork
        const chain = fork ? forkRecord(start.chain) : { ...start.chain }
        if (fork?.forkName !== undefined) chain.name = fork.forkName
        const session: FlushSession = {
            id: start.id,
            chainId: start.chainId,
            docId: start.docId,
            lineageId: start.lineageId,
            origin: 'continued',
            startedAt: this.now(),
            ...(start.sourceName === undefined ? {} : { sourceName: start.sourceName }),
            ...(fork ? { forkOf: fork.forkOf } : {}),
            ...(fork?.forkName === undefined ? {} : { forkName: fork.forkName }),
            parent: { ...start.parent },
            continuation: true,
            stored: false,
            nextSeq: 1,
            entrySeq: 0,
            pending: [],
            memoryOnly: [],
            ready: start.ready ?? Promise.resolve(),
            stack,
            ackedSeq: 0,
            strictSeq: 0,
            edited: false,
            chain,
        }
        this.add(session, { kind: 'continue', operation: start.operation }, head.hash, start.dirty)
        return this.switchTo(session, start)
    }

    /**
     * Takes up a stored session again, as its own tab's reload does (§1.4.2): no entry is added,
     * and the next entry follows its `lastSeq` over its stored stack.
     */
    resumeSession(start: ResumeStart): FlushSession {
        const stack = new SessionStack<PendingEntry>()
        stack.committed = new SlotStack<ModelSlot<PendingEntry>>(
            start.stack.first,
            start.stack.slots.map(({ hash, step }) => ({ hash, step: captureStep(step) })),
            start.stack.index,
        )
        stack.window = start.stack.window
        for (const { block, first, end } of start.stack.blocks)
            stack.blocks.set(block, { first, end })
        // Blocks not read back are rewritten whole by the next flush.
        stack.synced = start.stack.blocks.length > 0
        stack.durable = true
        stack.at = start.stack.at
        const session: FlushSession = {
            id: start.id,
            chainId: start.chainId,
            docId: start.docId,
            lineageId: start.lineageId,
            origin: start.origin,
            startedAt: start.startedAt,
            ...(start.sourceName === undefined ? {} : { sourceName: start.sourceName }),
            ...(start.parent ? { parent: { ...start.parent } } : {}),
            stored: true,
            nextSeq: Math.max(start.lastSeq, this.deps.reservedSeq?.(start.id) ?? 0) + 1,
            entrySeq: start.lastSeq,
            pending: [],
            memoryOnly: [],
            ready: start.ready ?? Promise.resolve(),
            stack,
            ackedSeq: start.lastSeq,
            strictSeq: start.lastSeq,
            edited: start.chain.edited === true,
            chain: { ...start.chain },
        }
        return this.switchTo(session, start)
    }

    /**
     * Takes up a session from its own journal while storage is unavailable (§1.6.7: a same-tab
     * reload continues from it): its ids and descriptor kept, its state as its first entry, its
     * `seq`s after the journal's, so the journal it goes on writing holds both visits' edits.
     */
    resumeJournalled(start: {
        id: string
        chainId: string
        docId: string
        lineageId: string
        origin: SessionOrigin
        startedAt: number
        parent?: { id: string; uptoSeq: number }
        sourceName?: string
        seq: number
        chain: Record<string, unknown>
        state: State
        operation: JsonValue
        recoveryContext: RecoveryContext
        ready?: Promise<unknown>
        lock?: LockLease
    }): FlushSession {
        const session: FlushSession = {
            id: start.id,
            chainId: start.chainId,
            docId: start.docId,
            lineageId: start.lineageId,
            origin: start.origin,
            startedAt: start.startedAt,
            ...(start.sourceName === undefined ? {} : { sourceName: start.sourceName }),
            ...(start.parent ? { parent: { ...start.parent } } : {}),
            atOnce: true,
            stored: false,
            // Past the journal's entries and a marker's `seq`: the Save's file may hold it.
            nextSeq: Math.max(start.seq, this.deps.reservedSeq?.(start.id) ?? 0) + 1,
            entrySeq: 0,
            pending: [],
            memoryOnly: [],
            ready: start.ready ?? Promise.resolve(),
            stack: new SessionStack(),
            ackedSeq: 0,
            strictSeq: 0,
            edited: true,
            chain: { ...start.chain },
        }
        const step = captureStep({
            kind: 'edit',
            operation: start.operation,
            recoveryContext: start.recoveryContext,
        })
        if (!step.recoveryContext) throw new Error('Recovery baseline has no context')
        session.pending.push({
            kind: 'recovered',
            operation: step.operation,
            recoveryContext: step.recoveryContext,
            recoveryBaseline: step,
            seq: session.nextSeq++,
            wall: this.now(),
            state: start.state,
            dirty: true,
        })
        session.entrySeq = session.nextSeq - 1
        this.entered()
        return this.switchTo(session, start)
    }

    /**
     * Makes a session the current one. The replaced session is committed strictly (§1.3.8): its
     * pending entries, or what relaxed flushes stored; `outgoing` says whether that held.
     */
    private switchTo(
        session: FlushSession,
        leases: { lock?: LockLease; parentLock?: LockLease; parentUntilReleased?: boolean },
    ): FlushSession {
        // The session's leases are taken here, first, after everything that can throw (A7). Both
        // must be held before either is taken, so a lost one leaves the other to its creator.
        const { lock, parentLock } = leases
        if ((lock && lock.state !== 'held') || (parentLock && parentLock.state !== 'held'))
            throw new Error(`The lock of session ${session.id} is no longer held`)
        if (lock) session.done = lock.take()
        if (parentLock) {
            const release = parentLock.take()
            if (leases.parentUntilReleased) session.journalParent = release
            else session.parentDone = release
        }
        const previous = this.current
        this.current = session
        this.sessions.push(session)
        let committing = Promise.resolve()
        if (
            previous?.pending.length ||
            (previous && previous.ackedSeq > previous.strictSeq) ||
            this.flushable(session)
        )
            committing = this.flush({ strict: true })
        else this.retire()
        this.outgoing = committing.then(() => !previous || !this.unflushed(previous))
        return session
    }

    /** Commits file ownership only now, after earlier identity changes, never on a later retry. */
    async setChainFieldsNow(fields: Record<string, unknown>): Promise<boolean> {
        const session = this.current
        if (!session) return false
        if (!session.stored || session.identity || this.active) {
            session.atOnce = true
            await this.flush({ strict: true })
        }
        if (this.current !== session || !session.stored || session.identity || this.noDatabase)
            return false
        return this.setChainFields(fields, false)
    }

    /**
     * Sets chain fields of the current session (§1.3.1: a rename, Export's target and name),
     * `undefined` removing one. A session not stored yet commits its first row with them, as a
     * continuation commits before it writes a file; a stored one writes them as the chain's head,
     * and one that isn't the head any more goes on as a fork, which takes them. Resolves whether
     * they're stored.
     */
    setChainFields(fields: Record<string, unknown>, defer = true): Promise<boolean> {
        const session = this.current
        if (!session) return Promise.resolve(false)
        // A first write already in flight must settle before deciding how to store fields.
        if (!session.stored && this.active)
            return this.running.then(() =>
                this.current === session ? this.setChainFields(fields, defer) : false,
            )
        const set: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(fields)) set[key] = value ?? null
        const chain: Record<string, unknown> = { ...session.chain }
        for (const [key, value] of Object.entries(set))
            if (value === null) Reflect.deleteProperty(chain, key)
            else chain[key] = value
        session.chain = chain
        const viaFirstWrite = (target: FlushSession) => {
            target.chainSet = { ...target.chainSet, ...set }
            target.atOnce = true
            return this.flush({ strict: true }).then(() => target.stored && !target.chainSet)
        }
        const writeChain = this.deps.writeChain
        if (!session.stored || !writeChain)
            return defer ? viaFirstWrite(session) : Promise.resolve(false)
        const run = this.running.then(async (): Promise<boolean> => {
            await session.ready
            let result: ChainWriteResult
            try {
                result = await writeChain({
                    chainId: session.chainId,
                    sessionId: session.id,
                    fields: set,
                    appVersion: this.deps.appVersion,
                })
            } catch (error) {
                this.deps.onError?.(error)
                return false
            }
            if (result.kind === 'stored') {
                session.chain = result.chain
                return true
            }
            if (result.kind === 'notHead' && this.sessions.includes(session)) {
                // Another tab continued the chain: this session goes on as a fork (D10), which
                // starts with a `continue` entry at the head when it has no entries of its own.
                const fork = this.fork(session, result.lastSeq)
                const head = fork.stack.committed.at(fork.stack.committed.index)
                if (!fork.pending.length && head?.hash)
                    this.add(
                        fork,
                        {
                            kind: 'continue',
                            operation: this.deps.continueOperation(result.lastTime),
                        },
                        head.hash,
                        false,
                    )
                if (defer) void viaFirstWrite(fork)
            }
            return false
        })
        this.running = run.then(() => undefined)
        return run
    }

    /**
     * Appends an entry to the current session: synchronous, as push, undo and redo are. A state
     * holding media not yet stored (a pick) flushes at once and strictly: the journal doesn't
     * carry media (§1.6.4). An undo or redo onto a slot not loaded gives its stored root instead.
     */
    append(description: EntryDescription, state: State | Uint8Array, dirty: boolean) {
        const session = this.current
        if (!session) return
        this.add(session, description, state, dirty)
        if (
            !(state instanceof Uint8Array) &&
            heldMediaOf(state).some(
                (item) => !this.knownMedia.has(item.hash) && !this.failedMedia.has(item.hash),
            )
        )
            void this.flush({ strict: true })
        else this.schedule()
    }

    private add(
        session: FlushSession,
        description: EntryDescription,
        state: State | Uint8Array,
        dirty: boolean,
    ) {
        const captured = captureEntryDescription(description)
        session.pending.push({
            seq: session.nextSeq++,
            wall: this.now(),
            ...captured,
            ...(state instanceof Uint8Array ? { snapshot: state } : { state }),
            dirty,
        })
        session.entrySeq = Math.max(session.entrySeq, session.nextSeq - 1)
        if (isEditingKind(description.kind)) session.edited = true
        this.entered()
    }

    /**
     * The newest entry's `seq` the session holds; 0 before any. A reserved `seq`, a kept one and
     * the `seq`s a resume jumped over are not entries, so the journal never names them (§1.6.4).
     */
    newestSeq(session: FlushSession) {
        return session.entrySeq
    }

    /**
     * Reserves the current session's next `seq` for a Save's `save` entry (§1.6.11.6): edits made
     * while the file is built get later ones, and wait for it. One at a time.
     */
    reserveSave(): SaveReservation | undefined {
        const session = this.current
        if (!session || session.reserved !== undefined) return
        const seq = session.nextSeq++
        const reservation = { session, seq, wall: this.now() }
        session.reserved = reservation
        return reservation
    }

    /**
     * Ends `reservation` if it is the session's current one, else 'ended' and nothing changes.
     * With `entry`: added at its `seq` with `identity` ('added'), or, the session no longer
     * current, nothing added and the `seq` kept ('notCurrent'). Without: kept with `keep`
     * ('kept'), else let go ('letGo'; a trailing `seq` is handed out again). A capture that throws
     * leaves it held. Resolves once a strict flush tried it.
     */
    endSave(
        reservation: SaveReservation,
        entry?: SaveEntryInput,
        identity?: IdentityUnit,
        keep = false,
    ): Promise<EndSaveResult> {
        const { session, seq } = reservation
        if (session.reserved !== reservation) return Promise.resolve('ended')
        const current = this.current === session && this.sessions.includes(session)
        const captured =
            entry && current
                ? { ...entry, operation: captureOperation(entry.operation) }
                : undefined
        session.reserved = undefined
        let result: EndSaveResult
        if (captured) {
            const at = session.pending.findIndex((each) => each.seq > seq)
            const added: PendingEntry = {
                ...captured,
                seq,
                kind: 'save',
                dirty: false,
            }
            if (at === -1) session.pending.push(added)
            else session.pending.splice(at, 0, added)
            session.entrySeq = Math.max(session.entrySeq, seq)
            this.entered()
            if (identity) {
                session.identity = { ...identity, seq }
                if (identity.clearExport) {
                    delete session.chain?.exportTarget
                    delete session.chain?.exportName
                    delete session.chainSet?.exportTarget
                    delete session.chainSet?.exportName
                }
            }
            result = 'added'
        } else if (entry) result = 'notCurrent'
        else if (keep) result = 'kept'
        else {
            if (session.nextSeq - 1 === seq) session.nextSeq--
            result = 'letGo'
        }
        return this.flush({ strict: true }).then(() => result)
    }

    /** Ends a reservation no path ended (a throw, a write in flight): kept. */
    release(reservation: SaveReservation): Promise<EndSaveResult> {
        return this.endSave(reservation, undefined, undefined, true)
    }

    /**
     * What a Save's build takes from this tab (§1.6.11.6): the entries before its reservation that
     * no store acknowledged yet, and the stack they give, slots `first` on.
     */
    unstored(session: FlushSession) {
        const entries = [...this.takeable(session)]
        return {
            entries,
            stack: session.stack.replay(
                entries,
                (entry) => this.slotOf(entry),
                (entry) => this.recoveredSlotOf(entry),
            )?.stack,
        }
    }

    /** The entries a flush can take: those before a reserved `seq`. */
    private takeable(session: FlushSession) {
        const reserved = session.reserved?.seq
        if (reserved === undefined) return session.pending
        const at = session.pending.findIndex((entry) => entry.seq > reserved)
        return at === -1 ? session.pending : session.pending.slice(0, at)
    }

    /**
     * Whether some entry isn't committed strictly in a database: the journal's trigger (§1.6.4).
     * A stored session's entries past its strict commit are relaxed, held in memory only (storage
     * unavailable, §1.6.7) or still to send. A blank start with no edit has nothing to store, so
     * nothing to journal.
     */
    unflushed(session: FlushSession) {
        if (session.strictSeq >= this.newestSeq(session)) return false
        return session.stored || this.flushable(session)
    }

    /** The session's stack with every pending entry replayed: what the tab shows. */
    liveStack(session: FlushSession) {
        return session.stack.replay(
            session.pending,
            (entry) => this.slotOf(entry),
            (entry) => this.recoveredSlotOf(entry),
        )?.stack
    }

    /** The slot an entry pushes. */
    private slotOf(entry: PendingEntry): ModelSlot<PendingEntry> {
        return { entry, step: pushedStep(entry) }
    }

    private recoveredSlotOf(entry: PendingEntry): ModelSlot<PendingEntry> {
        if (entry.kind !== 'recovered' || !entry.recoveryBaseline)
            throw new Error('Pending recovery has no current-state baseline')
        return { entry, step: entry.recoveryBaseline }
    }

    private storesAtOnce(session: FlushSession) {
        return session.origin !== 'new' && session.origin !== 'continued'
    }

    /** Whether a session has anything to store: a new session only from its first own entry. */
    private flushable(session: FlushSession) {
        const pending = this.takeable(session)
        if (!pending.length) return false
        if (session.stored || session.atOnce || this.storesAtOnce(session)) return true
        // A fork's entries are all its own edits; a continuation's first is its `continue`.
        if (session.parent && !session.continuation) return true
        return pending.length > 1
    }

    /** About 1 s after the last change, then through idle slices. */
    schedule(delay = FLUSH_DELAY_MS) {
        if (this.timer !== undefined) this.clearTimer(this.timer)
        this.timer = this.setTimer(() => {
            this.timer = undefined
            void this.flush()
        }, delay)
    }

    /**
     * Flushes everything pending now. `strict` for hide, a switch and media (§1.6.1); `oneGo`
     * extracts without yielding, for hide (§1.6.4): a flush already running then finishes its
     * extraction at once and sends strictly. Resolves once every batch was tried.
     */
    flush(options: FlushOptions = {}): Promise<void> {
        if (this.timer !== undefined) {
            this.clearTimer(this.timer)
            this.timer = undefined
        }
        if (this.active) {
            if (options.strict) this.active.strict = true
            if (options.oneGo) {
                this.active.oneGo = true
                this.hurry?.()
            }
        }
        const run = this.running.then(() =>
            this.drain(options).catch((error: unknown) => {
                this.failed = true
                this.deps.onError?.(error)
            }),
        )
        this.running = run
        return run
    }

    /** No database will answer in this tab any more (a newer one opened read-only). */
    withoutDatabase() {
        this.noDatabase = true
        for (const session of this.sessions) session.memoryOnly.length = 0
        this.retire()
    }

    /**
     * After the worker restarted: the memo is reset, and every pending entry is sent again, after
     * the entries only the old worker's in-memory store held.
     */
    restarted() {
        this.generation++
        this.extractor.reset()
        this.knownMedia.clear()
        for (const session of this.sessions) {
            session.pending.unshift(...session.memoryOnly)
            session.memoryOnly.length = 0
            // What memory held is sent again, and a reply may have been lost: the stack goes back
            // to before it, and its blocks are written whole next time.
            session.stack.rollback()
        }
        // A new worker holds nothing paused: media that failed gets tries afresh.
        if (this.failedMedia.size) {
            this.mediaAttempts = 0
            this.mediaRetryMs = 0
            this.scheduleMedia(0)
        }
        return this.flush()
    }

    private scheduleMedia(delay: number) {
        if (!this.deps.storeMedia) return
        if (this.mediaTimer !== undefined) this.clearTimer(this.mediaTimer)
        this.mediaTimer = this.setTimer(() => {
            this.mediaTimer = undefined
            void this.retryMedia()
        }, delay)
    }

    /**
     * Stores each media item whose read-back failed again, alone, in turn with the flushes. Still
     * failing, it tries again later, less often, up to `MEDIA_ATTEMPTS`; the history goes on.
     */
    retryMedia(): Promise<void> {
        if (this.mediaTimer !== undefined) {
            this.clearTimer(this.mediaTimer)
            this.mediaTimer = undefined
        }
        const storeMedia = this.deps.storeMedia
        const run = this.running.then(async () => {
            if (!storeMedia || !this.failedMedia.size) return
            for (const [hash, item] of [...this.failedMedia]) {
                const stored = await storeMedia(item).catch((error: unknown) => {
                    this.deps.onError?.(error)
                    return false
                })
                if (!stored) continue
                this.failedMedia.delete(hash)
                this.knownMedia.add(hash)
            }
            if (!this.failedMedia.size) {
                this.mediaAttempts = 0
                this.mediaRetryMs = 0
                return
            }
            if (++this.mediaAttempts >= MEDIA_ATTEMPTS) return
            this.mediaRetryMs = Math.min(Math.max(this.mediaRetryMs * 2, RETRY_MS), RETRY_MAX_MS)
            this.scheduleMedia(this.mediaRetryMs)
        })
        this.running = run
        return run
    }

    private async drain(options: FlushOptions) {
        const active = { strict: !!options.strict, oneGo: !!options.oneGo }
        this.active = active
        try {
            // A fork joins the list while it runs, and is reached in turn.
            for (const session of this.sessions) {
                while (this.flushable(session)) {
                    const stored = await this.flushBatch(session, active)
                    if (!stored) {
                        this.retire()
                        // Storing is paused or the worker failed: try again later, less often.
                        this.retryMs = Math.min(Math.max(this.retryMs * 2, RETRY_MS), RETRY_MAX_MS)
                        this.schedule(this.retryMs)
                        return
                    }
                }
            }
            this.retryMs = 0
            if (active.strict) await this.syncStrict()
            this.retire()
        } finally {
            this.active = undefined
        }
    }

    /** Commits strictly what relaxed flushes stored, so their journals can be cleared. */
    private async syncStrict() {
        const behind = this.sessions.filter((session) => session.strictSeq < session.ackedSeq)
        if (!behind.length || !this.deps.syncStrict) return
        const seqs = behind.map((session) => session.ackedSeq)
        try {
            // Committed in memory only (a worker restarted over memory): nothing is covered.
            this.syncFailed = !(await this.deps.syncStrict())
            if (this.syncFailed) return
        } catch (error) {
            // The journal stays until a later strict commit covers it.
            this.syncFailed = true
            this.deps.onError?.(error)
            return
        }
        behind.forEach((session, i) => {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const seq = seqs[i]!
            if (seq <= session.strictSeq) return
            session.strictSeq = seq
            this.deps.onCommitted?.(session, { seq, strict: true })
        })
    }

    /** Sessions replaced and fully stored are let go: their locks released. */
    private retire() {
        for (const session of [...this.sessions]) {
            if (session === this.current) continue
            // A blank start never edited stores nothing (§1.3.6).
            if (!this.flushable(session) && session.reserved === undefined)
                session.pending.length = 0
            // Held in memory only: kept, so a worker restart can send it again, while a database
            // may still take it (Try Again).
            if (this.noDatabase) session.memoryOnly.length = 0
            if (session.pending.length || session.memoryOnly.length) continue
            // Committed relaxed only: kept until a strict commit covers it, so its journal clears,
            // unless no database will answer in this tab any more.
            if (this.deps.syncStrict && !this.noDatabase && session.ackedSeq > session.strictSeq)
                continue
            this.sessions.splice(this.sessions.indexOf(session), 1)
            this.releaseParent(session)
            session.done?.()
        }
    }

    /**
     * Lets go of a session's hold on its parent: at its first write, or, for a start from a
     * journal, when the journal's key goes. Safe to call again.
     */
    releaseParent(session: FlushSession) {
        session.parentDone?.()
        session.parentDone = undefined
        session.journalParent?.()
        session.journalParent = undefined
    }

    private async flushBatch(
        session: FlushSession,
        options: { strict: boolean; oneGo: boolean },
    ): Promise<boolean> {
        await session.ready
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            const batch = new ChunkBatch()
            const generation = this.generation
            try {
                const outcome = await this.attempt(session, batch, options, generation)
                if (outcome === 'stored') {
                    this.failed = false
                    return true
                }
            } catch (error) {
                this.extractor.fail(
                    batch,
                    error instanceof Error ? error : new Error(String(error)),
                )
                // Planned with the memo of a worker that restarted meanwhile: planned again, with
                // what only its in-memory store held first, so the session has no gap.
                if (generation !== this.generation) continue
                this.failed = true
                this.deps.onError?.(error)
                return false
            }
        }
        this.failed = true
        this.deps.onError?.(new Error('The flush did not complete after retries'))
        return false
    }

    private async attempt(
        session: FlushSession,
        batch: ChunkBatch,
        options: { strict: boolean; oneGo: boolean },
        generation: number,
    ): Promise<'stored' | 'retry'> {
        const slices: number[] = []
        // Each entry's plan, or undefined for one landing on a stored slot.
        const planned: (SnapshotPlan | undefined)[] = []
        const take = this.takeable(session).slice(0, BATCH_ENTRIES)
        for (const entry of take) {
            if (!entry.state) {
                planned.push(undefined)
                continue
            }
            const job = this.extractor.plan(entry.state, batch)
            if (options.oneGo) {
                const start = performance.now()
                planned.push(runToEnd(job))
                slices.push(performance.now() - start)
            } else
                try {
                    planned.push(
                        await (this.deps.runJob ?? runSliced)(job, {
                            onSlice: (ms) => slices.push(ms),
                            hurry: (finish) => {
                                this.hurry = finish
                            },
                        }),
                    )
                } finally {
                    this.hurry = undefined
                }
            if (batch.size > BATCH_TEXT) break
        }
        const entries = take.slice(0, planned.length)
        const plans = planned.filter((plan) => plan !== undefined)
        // Each stateful entry's snapshot in the batch.
        const snapshotOf = new Map<PendingEntry, number>()
        entries.forEach((entry, i) => {
            if (planned[i]) snapshotOf.set(entry, snapshotOf.size)
        })
        // A fork's inherited slots stored by a commit whose reply was lost have no known root:
        // their states go in this batch as snapshots of their own, with no entry.
        for (const slot of session.stack.replay(
            entries,
            (entry) => this.slotOf(entry),
            (entry) => this.recoveredSlotOf(entry),
        )?.stack.slots ?? [])
            if (slot.entry?.state && !snapshotOf.has(slot.entry)) {
                snapshotOf.set(slot.entry, plans.length)
                plans.push(runToEnd(this.extractor.plan(slot.entry.state, batch)))
            }

        // Chunks pending in an earlier batch: wait for their hashes. One that failed is sent again.
        const earlier = new Set<Promise<Uint8Array>>()
        for (const plan of plans)
            for (const { chunks } of plan.kinds)
                for (const chunk of chunks) {
                    const pending = chunk.t === 'pending' ? chunk.memo.pending : undefined
                    if (pending && pending.batch !== batch) earlier.add(pending.promise)
                }
        try {
            await Promise.all(earlier)
        } catch {
            this.extractor.fail(batch, new Error('An earlier batch failed'))
            return 'retry'
        }

        const start = performance.now()
        const { text, ends } = encodeTexts(batch.texts)
        const reused = new Map<string, { memo: ChunkMemo; hash: Uint8Array }>()
        const snapshots: BatchSnapshot[] = plans.map((plan) => ({
            header: plan.header,
            kinds: plan.kinds.map(({ kind, chunks }) => ({
                kind,
                chunks: chunks.map((chunk) => {
                    const pending = chunk.memo.pending
                    if (chunk.t === 'pending' && pending?.batch === batch) return pending.id
                    const hash = chunk.t === 'stored' ? chunk.hash : chunk.memo.hash
                    if (!hash) throw new Error('A chunk has no hash')
                    reused.set(toHex(hash), { memo: chunk.memo, hash })
                    return hash
                }),
            })),
            noteCount: plan.noteCount,
            media: [...plan.media],
        }))

        const referenced = new Set(plans.flatMap((plan) => plan.media))
        const media: BatchMedia[] = []
        const held: string[] = []
        const sent = new Set<string>()
        for (const entry of entries)
            for (const item of entry.state ? heldMediaOf(entry.state) : []) {
                if (!referenced.has(item.hash) || sent.has(item.hash)) continue
                sent.add(item.hash)
                // Stored alone meanwhile: the root names it, and it reads as not held till then.
                if (this.failedMedia.has(item.hash)) continue
                if (this.knownMedia.has(item.hash) && !this.resendMedia.has(item.hash))
                    held.push(item.hash)
                else media.push(item)
            }

        // The last entry's state is the head once this batch is stored.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const last = entries.at(-1)!
        const lastPlan = planned.at(-1)
        const stack = this.planStack(session, entries, snapshotOf)
        // A Save's identity unit rides with its `save` entry's batch, or a later one.
        const identity =
            session.identity && last.seq >= session.identity.seq ? session.identity : undefined
        const isStrict =
            options.strict ||
            media.length > 0 ||
            !!identity ||
            (!session.stored && this.storesAtOnce(session))
        const view = this.deps.view?.()
        const unconfirmed = media.map((item) => item.hash).filter((h) => this.unconfirmed.has(h))
        for (const item of media) this.unconfirmed.add(item.hash)
        const wire: FlushBatch = {
            session: {
                id: session.id,
                chainId: session.chainId,
                origin: session.origin,
                startedAt: session.startedAt,
                ...(session.parent ? { parent: session.parent } : {}),
            },
            chain: {
                docId: session.docId,
                lineageId: session.lineageId,
                ...(session.sourceName === undefined ? {} : { sourceName: session.sourceName }),
                ...(session.forkOf === undefined ? {} : { forkOf: session.forkOf }),
                ...(session.forkName === undefined ? {} : { name: session.forkName }),
                ...(session.chainSet ? { set: session.chainSet } : {}),
            },
            appVersion: this.deps.appVersion,
            text,
            ends,
            snapshots,
            reused: [...reused.values()].map(({ memo, hash }) => ({
                hash,
                ...(memo.known ? { known: memo.known } : {}),
            })),
            entries: entries.map((entry) => {
                const snapshot = entry.snapshot ?? snapshotOf.get(entry)
                if (snapshot === undefined) throw new Error('Missing flush entry snapshot')
                return {
                    seq: entry.seq,
                    wall: entry.wall,
                    ...captureEntryDescription(entry),
                    snapshot,
                    dirty: entry.dirty,
                    ...(entry.recoveryBaseline
                        ? {
                              stack: {
                                  keep: 0,
                                  push: [
                                      {
                                          snapshot,
                                          step: entry.recoveryBaseline,
                                      },
                                  ],
                                  index: 0,
                              },
                          }
                        : {}),
                    ...(entry.revisionId === undefined ? {} : { revisionId: entry.revisionId }),
                    ...(entry.device ? { device: entry.device } : {}),
                    ...(entry.appVersion === undefined ? {} : { appVersion: entry.appVersion }),
                }
            }),
            media,
            held,
            ...(unconfirmed.length ? { unconfirmed } : {}),
            ...(view ? { view } : {}),
            ...(last.state && lastPlan
                ? { summary: summaryOf(last.state, lastPlan.noteCount) }
                : {}),
            ...(stack ? { stack: stack.wire } : {}),
            ...(identity ? { identity: unitOf(identity) } : {}),
            durability: isStrict ? 'strict' : 'relaxed',
        }
        const mainMs = slices.reduce((sum, ms) => sum + ms, 0) + performance.now() - start
        // Read before the buffer is transferred.
        const textBytes = text.length

        const result = await this.deps.transport(
            wire,
            [text.buffer],
            () => generation === this.generation,
        )
        switch (result.kind) {
            case 'stored': {
                this.extractor.settle(batch, result.chunks, result.known)
                this.extractor.confirm(
                    [...reused.values()].map(({ memo }) => memo),
                    result.known,
                )
                const acknowledged = acknowledge(session.pending, entries)
                if (this.deps.onRoots) {
                    const roots: (readonly [State, Uint8Array])[] = []
                    for (const [entry, at] of snapshotOf) {
                        const hash = result.roots[at]
                        if (entry.state && hash) roots.push([entry.state, hash])
                    }
                    this.deps.onRoots(roots)
                }
                this.noDatabase = !!result.noDatabase
                if (result.memory) {
                    session.stack.checkpoint()
                    session.memoryOnly.push(...acknowledged)
                } else
                    // A database holds them now: moved by Try Again, or sent again after a restart.
                    for (const each of this.sessions) {
                        each.memoryOnly.length = 0
                        each.stack.release()
                    }
                session.stored = true
                session.chain = result.chain
                if (identity && result.identity && !result.memory) {
                    if (session.identity === identity) session.identity = undefined
                    session.docId = identity.docId
                    this.deps.onIdentity?.(session, identity)
                }
                // Taken over since the Save (R5, R6): the unit goes, and the record stands.
                if (identity && result.staleIdentity) {
                    if (session.identity === identity) session.identity = undefined
                    this.deps.onStaleIdentity?.(session)
                }
                // Its first row is written: an unstored continuation's hold on its parent goes.
                session.parentDone?.()
                session.parentDone = undefined
                // Held until a database has them: a restarted worker's memory makes the row again.
                if (!result.memory) delete session.chainSet
                if (stack)
                    session.stack.commit(
                        stack.plan,
                        (entry) => {
                            const at = snapshotOf.get(entry)
                            const hash = at === undefined ? undefined : result.roots[at]
                            return hash
                                ? { hash, step: entry.recoveryBaseline ?? pushedStep(entry) }
                                : undefined
                        },
                        {
                            written: result.stackWritten,
                            durable: !result.memory,
                            at: result.known,
                        },
                    )
                else session.stack.unsync()
                if (result.stackRemoved) session.stack.forget()
                if (!result.memory) {
                    const seq = Math.max(session.ackedSeq, result.lastSeq)
                    session.ackedSeq = seq
                    if (isStrict) session.strictSeq = Math.max(session.strictSeq, seq)
                    this.deps.onCommitted?.(session, { seq, strict: isStrict })
                }
                const failed = new Set(result.mediaFailed)
                for (const item of media) {
                    this.unconfirmed.delete(item.hash)
                    if (failed.has(item.hash)) this.failedMedia.set(item.hash, item)
                    else this.knownMedia.add(item.hash)
                }
                for (const hash of [...media.map((item) => item.hash), ...held])
                    this.resendMedia.delete(hash)
                if (failed.size && this.mediaTimer === undefined) {
                    this.mediaAttempts = 0
                    this.scheduleMedia(Math.max(this.mediaRetryMs, RETRY_MS))
                }
                this.deps.onFlushed?.({
                    sessionId: session.id,
                    entries: entries.length,
                    newChunks: batch.texts.length,
                    textBytes,
                    mainMs,
                    slices,
                    strict: isStrict,
                    stats: result.stats,
                })
                return 'stored'
            }
            case 'stackWhole':
                // Blocks the model leaves alone were stored elsewhere: the whole window this time.
                this.extractor.fail(batch, new Error('The stack is needed whole'))
                session.stack.unsync()
                return 'retry'
            case 'missing':
                // The closure check found windows gone (§1.6.6): forget only those, send them again.
                this.extractor.fail(batch, new Error('Missing windows'))
                this.extractor.forgetHashes(new Set(result.chunks), plans)
                for (const hash of result.media) this.resendMedia.add(hash)
                // Another store than the stack's: its whole window goes with the next attempt.
                if (session.stack.at && session.stack.at.db !== result.known.db)
                    session.stack.unsync()
                return 'retry'
            case 'notHead':
                // Another tab continued the chain: further entries go to a fork (§1.3.1, D10).
                this.extractor.fail(batch, new Error('Not the head'))
                this.fork(session, result.lastSeq)
                return 'stored'
        }
    }

    /**
     * The batch's stack: its entries replayed over the acknowledged stack, with the blocks they
     * change. Undefined when the model can't follow them: they're stored all the same, and the
     * blocks are rewritten whole later.
     */
    private planStack(
        session: FlushSession,
        entries: readonly PendingEntry[],
        snapshotOf: ReadonlyMap<PendingEntry, number>,
    ): { plan: StackPlan<PendingEntry>; wire: BatchStack } | undefined {
        const replayed = session.stack.replay(
            entries,
            (entry) => this.slotOf(entry),
            (entry) => this.recoveredSlotOf(entry),
        )
        if (!replayed) {
            this.deps.onError?.(new Error('The stack model could not follow the entries'))
            return
        }
        const plan = session.stack.plan(replayed.stack, replayed.changedFrom)
        const blocks: BatchStack['blocks'] = []
        for (const { block, first, end } of plan.writes) {
            const slots: (number | Uint8Array)[] = []
            const steps: UndoableStep[] = []
            for (let slot = first; slot < end; slot++) {
                const model = plan.stack.at(slot)
                const entry = model?.entry
                const ref = entry ? snapshotOf.get(entry) : model?.hash
                const step = model?.step
                if (ref === undefined || !step) {
                    this.deps.onError?.(new Error(`Stack slot ${slot} has no snapshot`))
                    return
                }
                slots.push(ref)
                steps.push(step)
            }
            blocks.push({ block, first, slots, steps })
        }
        return {
            plan,
            wire: {
                ...plan.window,
                blocks,
                full: plan.full,
                ...(session.stack.at ? { at: session.stack.at } : {}),
            },
        }
    }

    /**
     * Moves a session's pending entries to a new session in a new chain, copied from the old
     * chain's record, whose parent is the stored session (D10). A stored session never changes
     * chain, so the chain that continued it keeps its whole history.
     */
    private fork(from: FlushSession, lastSeq: number | undefined): FlushSession {
        // Entries a kill after commit already stored stay the stored session's.
        const moving = from.pending.filter((entry) => lastSeq === undefined || entry.seq > lastSeq)
        // A continuation that lost the race forks from the parent it continued (§1.3.1).
        const parent =
            lastSeq !== undefined
                ? { id: from.id, uptoSeq: lastSeq }
                : from.continuation
                  ? from.parent
                  : undefined
        const forkName = this.deps.forkName?.(from)
        // The parent's stack at `uptoSeq`: what's acknowledged, then what was stored unanswered.
        const stored = from.pending.filter((entry) => lastSeq !== undefined && entry.seq <= lastSeq)
        const inherited = from.stack.replay(
            stored,
            (entry) => this.slotOf(entry),
            (entry) => this.recoveredSlotOf(entry),
        )?.stack
        from.pending.length = 0
        const id = this.newId()
        // Everything that can throw is built first: the lease is taken straight after (A7).
        const forkStack = from.stack.forkedStack(inherited)
        const forkChain = from.chain
            ? { ...forkRecord(from.chain), ...(forkName ? { name: forkName } : {}) }
            : undefined
        const lease = this.deps.lockSession?.(id)
        const fork: FlushSession = {
            id,
            chainId: this.newId(),
            docId: this.newId(),
            lineageId: from.lineageId,
            // Without a stored row there is nothing to continue: it keeps its own origin.
            origin: parent ? 'continued' : from.origin,
            startedAt: this.now(),
            ...(from.sourceName === undefined ? {} : { sourceName: from.sourceName }),
            forkOf: from.chainId,
            ...(forkName === undefined ? {} : { forkName }),
            ...(parent ? { parent } : {}),
            ...(from.parentDone ? { parentDone: from.parentDone } : {}),
            ...(from.chainSet ? { chainSet: from.chainSet, atOnce: true } : {}),
            stored: false,
            nextSeq: moving.length + 1,
            entrySeq: moving.length,
            pending: moving.map((entry, i) => ({ ...entry, seq: i + 1 })),
            memoryOnly: [],
            ready: lease?.granted.catch(() => undefined) ?? Promise.resolve(),
            stack: forkStack,
            // Until its own first flush, its journal's descriptor carries the old chain's fields.
            ...(forkChain ? { chain: forkChain } : {}),
            ackedSeq: 0,
            strictSeq: 0,
            edited: moving.some((entry) => isEditingKind(entry.kind)),
        }
        if (lease) fork.done = lease.take()
        from.parentDone = undefined
        this.sessions.splice(this.sessions.indexOf(from) + 1, 0, fork)
        if (this.current === from) this.current = fork
        this.deps.onFork?.(fork, from)
        if (moving.length) this.entered()
        return fork
    }
}
