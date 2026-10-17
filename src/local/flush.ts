import type { State } from '../state'
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
    ChainSummary,
    EntryKind,
    FlushBatch,
    FlushResult,
    SessionOrigin,
    SessionView,
    WriteStats,
} from './flushWrite'
import { toHex } from './hash'

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
export type PendingEntry = {
    readonly seq: number
    readonly wall: number
    readonly kind: EntryKind
    /** Evaluated when flushed, so the stored label is in the locale at write time (§1.10 #7). */
    readonly label: () => string
    readonly state: State
    readonly dirty: boolean
}

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
    /** The stored session a fork continues (D10). */
    readonly parent?: { readonly id: string; readonly uptoSeq: number }
    /** Whether a flush of it has committed. */
    stored: boolean
    nextSeq: number
    readonly pending: PendingEntry[]
    /** Acknowledged by an in-memory store only: sent again after a worker restart. */
    readonly memoryOnly: PendingEntry[]
    /** Resolves once this tab holds the session's lock (§1.6.6). */
    readonly ready: Promise<unknown>
    /** Runs once the session is replaced and nothing of it is pending: releases its lock. */
    readonly done?: () => void
}

export type SessionStart = {
    id: string
    docId: string
    origin: SessionOrigin
    sourceName?: string
    state: State
    label: () => string
    dirty: boolean
    ready?: Promise<unknown>
    done?: () => void
}

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
    /** The lock of a session the flusher starts itself (a fork): held until `done`. */
    lockSession?: (id: string) => { ready: Promise<unknown>; done: () => void }
    /** A session's chain was continued elsewhere: its further entries went to this fork (D10). */
    onFork?: (fork: FlushSession, from: FlushSession) => void
    /**
     * Stores a media item alone, after its flush's read-back failed (§1.6.8.4): resolves whether
     * it's stored right now. Without it the item is left not held in storage.
     */
    storeMedia?: (item: BatchMedia) => Promise<boolean>
    onFlushed?: (report: FlushReport) => void
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
    private retryMs = 0

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
     * session's pending entries are flushed strictly.
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
            pending: [],
            memoryOnly: [],
            ready: start.ready ?? Promise.resolve(),
            ...(start.done ? { done: start.done } : {}),
        }
        const previous = this.current
        this.current = session
        this.sessions.push(session)
        this.add(session, 'init', start.label, start.state, start.dirty)
        if (previous?.pending.length || this.storesAtOnce(session))
            void this.flush({ strict: true })
        else this.retire()
        return session
    }

    /**
     * Appends an entry to the current session: synchronous, as push, undo and redo are. A state
     * holding media not yet stored (a pick) flushes at once and strictly: the journal doesn't
     * carry media (§1.6.4).
     */
    append(kind: EntryKind, label: () => string, state: State, dirty: boolean) {
        const session = this.current
        if (!session) return
        this.add(session, kind, label, state, dirty)
        if (
            heldMediaOf(state).some(
                (item) => !this.knownMedia.has(item.hash) && !this.failedMedia.has(item.hash),
            )
        )
            void this.flush({ strict: true })
        else this.schedule()
    }

    private add(
        session: FlushSession,
        kind: EntryKind,
        label: () => string,
        state: State,
        dirty: boolean,
    ) {
        session.pending.push({
            seq: session.nextSeq++,
            wall: this.now(),
            kind,
            label,
            state,
            dirty,
        })
    }

    private storesAtOnce(session: FlushSession) {
        return session.origin !== 'new' && session.origin !== 'continued'
    }

    /** Whether a session has anything to store: a new session only from its first own entry. */
    private flushable(session: FlushSession) {
        if (!session.pending.length) return false
        // A fork's entries are all its own edits.
        if (session.stored || session.parent || this.storesAtOnce(session)) return true
        return session.pending.length > 1
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
            this.retire()
        } finally {
            this.active = undefined
        }
    }

    /** Sessions replaced and fully stored are let go: their locks released. */
    private retire() {
        for (const session of [...this.sessions]) {
            if (session === this.current) continue
            // A blank start never edited stores nothing (§1.3.6).
            if (!this.flushable(session)) session.pending.length = 0
            // Held in memory only: kept, so a worker restart can send it again, while a database
            // may still take it (Try Again).
            if (this.noDatabase) session.memoryOnly.length = 0
            if (session.pending.length || session.memoryOnly.length) continue
            this.sessions.splice(this.sessions.indexOf(session), 1)
            session.done?.()
        }
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
        const plans: SnapshotPlan[] = []
        const take = session.pending.slice(0, BATCH_ENTRIES)
        for (const entry of take) {
            const job = this.extractor.plan(entry.state, batch)
            if (options.oneGo) {
                const start = performance.now()
                plans.push(runToEnd(job))
                slices.push(performance.now() - start)
            } else
                try {
                    plans.push(
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
        const entries = take.slice(0, plans.length)

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
            for (const item of heldMediaOf(entry.state)) {
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
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const lastPlan = plans.at(-1)!
        const isStrict =
            options.strict || media.length > 0 || (!session.stored && this.storesAtOnce(session))
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
            },
            appVersion: this.deps.appVersion,
            text,
            ends,
            snapshots,
            reused: [...reused.values()].map(({ memo, hash }) => ({
                hash,
                ...(memo.known ? { known: memo.known } : {}),
            })),
            entries: entries.map((entry, i) => ({
                seq: entry.seq,
                wall: entry.wall,
                kind: entry.kind,
                label: entry.label(),
                snapshot: i,
                dirty: entry.dirty,
            })),
            media,
            held,
            ...(unconfirmed.length ? { unconfirmed } : {}),
            ...(view ? { view } : {}),
            summary: summaryOf(last.state, lastPlan.noteCount),
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
                const acknowledged = session.pending.splice(0, entries.length)
                this.noDatabase = !!result.noDatabase
                if (result.memory) session.memoryOnly.push(...acknowledged)
                // A database holds them now: moved by Try Again, or sent again after a restart.
                else for (const each of this.sessions) each.memoryOnly.length = 0
                session.stored = true
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
            case 'missing':
                // The closure check found windows gone (§1.6.6): forget only those, send them again.
                this.extractor.fail(batch, new Error('Missing windows'))
                this.extractor.forgetHashes(new Set(result.chunks), plans)
                for (const hash of result.media) this.resendMedia.add(hash)
                return 'retry'
            case 'notHead':
                // Another tab continued the chain: further entries go to a fork (§1.3.1, D10).
                this.extractor.fail(batch, new Error('Not the head'))
                this.fork(session, result.lastSeq)
                return 'stored'
        }
    }

    /**
     * Moves a session's pending entries to a new session in a new chain, copied from the old
     * chain's record, whose parent is the stored session (D10). A stored session never changes
     * chain, so the chain that continued it keeps its whole history.
     */
    private fork(from: FlushSession, lastSeq: number | undefined) {
        // Entries a kill after commit already stored stay the stored session's.
        const moving = from.pending.filter((entry) => lastSeq === undefined || entry.seq > lastSeq)
        from.pending.length = 0
        const id = this.newId()
        const lock = this.deps.lockSession?.(id)
        const fork: FlushSession = {
            id,
            chainId: this.newId(),
            docId: this.newId(),
            lineageId: from.lineageId,
            // Without a stored row there is nothing to continue: it keeps its own origin.
            origin: lastSeq === undefined ? from.origin : 'continued',
            startedAt: this.now(),
            ...(from.sourceName === undefined ? {} : { sourceName: from.sourceName }),
            forkOf: from.chainId,
            ...(lastSeq === undefined ? {} : { parent: { id: from.id, uptoSeq: lastSeq } }),
            stored: false,
            nextSeq: moving.length + 1,
            pending: moving.map((entry, i) => ({ ...entry, seq: i + 1 })),
            memoryOnly: [],
            ready: lock?.ready ?? Promise.resolve(),
            ...(lock ? { done: lock.done } : {}),
        }
        this.sessions.splice(this.sessions.indexOf(from) + 1, 0, fork)
        if (this.current === from) this.current = fork
        this.deps.onFork?.(fork, from)
    }
}
