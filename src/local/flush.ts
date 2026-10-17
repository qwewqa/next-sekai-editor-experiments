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
// nothing: the next one, or the restarted worker, gets them again.

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
    /** Set when the chain was continued elsewhere and this session became a fork (§1.3.1). */
    forkOf?: string
    /** Whether a flush of it has committed. */
    stored: boolean
    nextSeq: number
    readonly pending: PendingEntry[]
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

export type FlushTransport = (batch: FlushBatch, transfer: Transferable[]) => Promise<FlushResult>

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
    /** A session became a fork: its new chain and document ids. */
    onFork?: (session: FlushSession) => void
    onFlushed?: (report: FlushReport) => void
    onError?: (error: unknown) => void
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (handle: unknown) => void
}

/** About 1 s after the last change (an internal constant; §1.6.4). */
export const FLUSH_DELAY_MS = 1000
/** Entries in one batch at most, and about this much new text, so one transaction stays short. */
export const BATCH_ENTRIES = 64
export const BATCH_TEXT = 2 * 1024 * 1024
/** Attempts of one batch: missing windows re-sent, a fork made, before it counts as failed. */
const ATTEMPTS = 4

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
    private timer: unknown
    /** Media this tab knows stored; others it holds go with the next flush naming them. */
    private readonly knownMedia = new Set<string>()
    /** Media the worker found missing: sent again with their bytes. */
    private readonly resendMedia = new Set<string>()
    private readonly now: () => number
    private readonly newId: () => string
    private readonly setTimer: (fn: () => void, ms: number) => unknown
    private readonly clearTimer: (handle: unknown) => void
    /** Whether the last flush failed: storing is paused, and the next change retries. */
    failed = false

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

    /** Appends an entry to the current session: synchronous, as push, undo and redo are. */
    append(kind: EntryKind, label: () => string, state: State, dirty: boolean) {
        const session = this.current
        if (!session) return
        this.add(session, kind, label, state, dirty)
        this.schedule()
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
        return session.stored || this.storesAtOnce(session) || session.pending.length > 1
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
     * extracts without yielding, for hide (§1.6.4). Resolves once every batch was tried.
     */
    flush(options: { strict?: boolean; oneGo?: boolean } = {}): Promise<void> {
        if (this.timer !== undefined) {
            this.clearTimer(this.timer)
            this.timer = undefined
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

    /** After the worker restarted: the memo is reset and every pending entry is sent again. */
    restarted() {
        this.extractor.reset()
        this.knownMedia.clear()
        return this.flush()
    }

    private async drain(options: { strict?: boolean; oneGo?: boolean }) {
        for (const session of [...this.sessions]) {
            while (this.flushable(session)) {
                const stored = await this.flushBatch(session, options)
                if (!stored) {
                    this.retire()
                    return
                }
            }
        }
        this.retire()
    }

    /** Sessions replaced and fully stored are let go: their locks released. */
    private retire() {
        for (const session of [...this.sessions]) {
            if (session === this.current) continue
            // A blank start never edited stores nothing (§1.3.6).
            if (!this.flushable(session)) session.pending.length = 0
            if (session.pending.length) continue
            this.sessions.splice(this.sessions.indexOf(session), 1)
            session.done?.()
        }
    }

    private async flushBatch(
        session: FlushSession,
        options: { strict?: boolean; oneGo?: boolean },
    ): Promise<boolean> {
        await session.ready
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            const batch = new ChunkBatch()
            try {
                const outcome = await this.attempt(session, batch, options)
                if (outcome === 'stored') {
                    this.failed = false
                    return true
                }
            } catch (error) {
                this.extractor.fail(
                    batch,
                    error instanceof Error ? error : new Error(String(error)),
                )
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
        { strict = false, oneGo = false }: { strict?: boolean; oneGo?: boolean },
    ): Promise<'stored' | 'retry'> {
        const slices: number[] = []
        const plans: SnapshotPlan[] = []
        const take = session.pending.slice(0, BATCH_ENTRIES)
        for (const entry of take) {
            const job = this.extractor.plan(entry.state, batch)
            if (oneGo) {
                const start = performance.now()
                plans.push(runToEnd(job))
                slices.push(performance.now() - start)
            } else plans.push(await runSliced(job, { onSlice: (ms) => slices.push(ms) }))
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
            strict || media.length > 0 || (!session.stored && this.storesAtOnce(session))
        const view = this.deps.view?.()
        const wire: FlushBatch = {
            session: {
                id: session.id,
                chainId: session.chainId,
                origin: session.origin,
                startedAt: session.startedAt,
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
                epoch: memo.epoch ?? -1,
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
            ...(view ? { view } : {}),
            summary: summaryOf(last.state, lastPlan.noteCount),
            durability: isStrict ? 'strict' : 'relaxed',
        }
        const mainMs = slices.reduce((sum, ms) => sum + ms, 0) + performance.now() - start

        const result = await this.deps.transport(wire, [text.buffer])
        switch (result.kind) {
            case 'stored': {
                this.extractor.settle(batch, result.chunks, result.epoch)
                this.extractor.confirm(
                    [...reused.values()].map(({ memo }) => memo),
                    result.epoch,
                )
                session.pending.splice(0, entries.length)
                session.stored = true
                for (const item of media) this.knownMedia.add(item.hash)
                for (const hash of [...media.map((item) => item.hash), ...held])
                    this.resendMedia.delete(hash)
                this.deps.onFlushed?.({
                    sessionId: session.id,
                    entries: entries.length,
                    newChunks: batch.texts.length,
                    textBytes: text.length,
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
                // Another tab continued the chain: this session becomes a fork (§1.3.1).
                this.extractor.fail(batch, new Error('Not the head'))
                session.forkOf = session.chainId
                session.chainId = this.newId()
                session.docId = this.newId()
                this.deps.onFork?.(session)
                return 'retry'
        }
    }
}
