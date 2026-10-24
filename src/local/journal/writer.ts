import { recordError } from '../../diagnostics'
import type { JournalFound, JournalStore } from '../../platform/types'
import type { State } from '../../state'
import type { Flusher, FlushSession } from '../flush'
import { buildJournal } from './build'

// The last-chance journal's writer (Part 1 §1.6.4 #7): written synchronously on hide, pagehide,
// beforeunload and freeze whenever the open session has entries not committed strictly, and
// verified by reading it back. One key per session, overwritten each time and cleared only once
// a strict flush covering its `seq` commits; a second trigger for the same `seq` writes nothing.
// A fork's journal takes over its old session's key (§1.3.1).

export type JournalWriterDeps = {
    store: JournalStore
    flusher: () => Flusher | undefined
    /** The live state: what the open session shows. */
    state: () => State
    /**
     * Storing is paused by a quota error or `UnknownError`: a journal then counts as unverified
     * however its write went, since localStorage is likely short too (§1.6.4).
     */
    pausedForSpace: () => boolean
    /**
     * Whether a strict commit is on disk when it resolves: false where IndexedDB has no
     * `durability` option (Firefox before 126), and then no commit clears a journal; the next
     * load finds it covered and deletes it (D14).
     */
    strictCommits?: boolean
    appVersion: string
    now?: () => number
    /** Each write's figures, for the timing specs. */
    onWrite?: (write: JournalWrite) => void
}

/** A write's figures; `size` is the gzipped level data's, most of the journal. */
export type JournalWrite = {
    sessionId: string
    seq: number
    ms: number
    size: number
    verified: boolean
}

export class JournalWriter {
    /** This page's last write per session: its `seq` and whether it verified. */
    private readonly written = new Map<string, { seq: number; verified: boolean }>()
    /**
     * Keys of sessions a fork took the entries of, by the fork, with the fork's last moved `seq`:
     * cleared once the fork's own journal verifies or a strict commit covers what moved, since
     * the next load would otherwise keep them as a recovery chain duplicating the fork.
     */
    private readonly superseded = new Map<
        string,
        { keys: { sessionId: string; seq: number }[]; moved: number }
    >()

    /**
     * Keys a "strict" commit covered where commits aren't durable on resolve (D14), by session:
     * left for the next load, and removed once another session's newer journal verifies, so a
     * visit doesn't pile them up in the budget.
     */
    private readonly covered = new Map<string, number>()

    /**
     * Journals whose work another session took over, by that session (a reload's own journal it
     * couldn't apply, §1.6.4): each removed, if unchanged, once the session's own journal verifies
     * or a strict commit covers the entry that holds the work.
     */
    private readonly retiring = new Map<
        string,
        { found: JournalFound; seq: number; dropped?: () => void }[]
    >()

    constructor(private readonly deps: JournalWriterDeps) {}

    /**
     * Writes the open session's journal when it has entries not committed strictly. True when
     * nothing needed writing or the write verified: the session's pending entries are covered.
     */
    write(): boolean {
        const flusher = this.deps.flusher()
        const session = flusher?.session
        if (!flusher || !session || !flusher.unflushed(session)) return true
        const seq = flusher.newestSeq(session)
        const last = this.written.get(session.id)
        // beforeunload, pagehide, visibilitychange and freeze can all fire for one close; a key
        // removed or changed behind it since is written again.
        if (last?.seq === seq && last.verified && this.deps.store.holds(session.id)) return true
        const live = flusher.liveStack(session)
        if (!live) return false
        const start = performance.now()
        let verified = false
        let size = 0
        try {
            const journal = buildJournal({
                session,
                seq,
                live,
                state: this.deps.state(),
                appVersion: this.deps.appVersion,
                writtenAt: (this.deps.now ?? Date.now)(),
            })
            size = journal.levelDataGz.length
            verified = this.deps.store.writeWhole(journal)
        } catch (error) {
            recordError(error)
            console.error('The journal could not be written', error)
        }
        this.written.set(session.id, { seq, verified })
        if (verified) {
            this.dropRetired(session.id)
            this.dropSuperseded(session.id)
            this.covered.delete(session.id)
            for (const [id, coveredSeq] of this.covered) this.deps.store.clear(id, coveredSeq)
            this.covered.clear()
        }
        this.deps.onWrite?.({
            sessionId: session.id,
            seq,
            ms: performance.now() - start,
            size,
            verified,
        })
        return this.verified(session.id, seq)
    }

    /**
     * Writes the open session's journal again whatever was written before: its identity changed
     * (an unlink on damage, §1.6.11.8), so a replay can't put the old binding back.
     */
    rewrite(): boolean {
        const session = this.deps.flusher()?.session
        if (session) this.written.delete(session.id)
        return this.write()
    }

    /** Whether the journal of the session's `seq` verified on this page and still counts. */
    verified(sessionId: string, seq: number) {
        const last = this.written.get(sessionId)
        return (
            last?.seq === seq &&
            last.verified &&
            !this.deps.pausedForSpace() &&
            this.deps.store.holds(sessionId)
        )
    }

    /**
     * A flush committed the session's entries up to `seq`: a strict one clears its journal; a
     * relaxed one leaves the key for the next strict one, which a power loss can't undo. Where
     * strict commits aren't (D14), none clears it.
     */
    committed(sessionId: string, seq: number, strict: boolean) {
        if (!strict) return
        const last = this.written.get(sessionId)
        if (this.deps.strictCommits === false) {
            if (last && last.seq <= seq) this.covered.set(sessionId, seq)
            return
        }
        if (seq >= (this.superseded.get(sessionId)?.moved ?? Infinity))
            this.dropSuperseded(sessionId)
        this.dropRetired(sessionId, seq)
        if (!last || last.seq > seq) return
        this.deps.store.clear(sessionId, seq)
        this.written.delete(sessionId)
    }

    /**
     * A flush found the session continued elsewhere and moved its entries to a fork (D10): the
     * fork's journal takes over the old key, written at once when the fork is the open session.
     */
    forked(from: FlushSession, fork: FlushSession) {
        // The fork numbers the entries it took from 1: the work is held once all of them are.
        const retiring = this.retiring.get(from.id)
        this.retiring.delete(from.id)
        if (retiring)
            this.retiring.set(
                fork.id,
                retiring.map((each) => ({ ...each, seq: fork.entrySeq })),
            )
        const keys = this.superseded.get(from.id)?.keys ?? []
        this.superseded.delete(from.id)
        const last = this.written.get(from.id)
        this.written.delete(from.id)
        if (last) keys.push({ sessionId: from.id, seq: last.seq })
        if (!keys.length) return
        this.superseded.set(fork.id, { keys, moved: fork.entrySeq })
        if (this.deps.flusher()?.session === fork) this.write()
    }

    /** `found`'s work is in `by`'s entry `seq`: the key goes once `by` holds it (see `retiring`). */
    retire(found: JournalFound, by: string, seq: number, dropped?: () => void) {
        this.retiring.set(by, [
            ...(this.retiring.get(by) ?? []),
            { found, seq, ...(dropped ? { dropped } : {}) },
        ])
    }

    private dropRetired(by: string, covered = Infinity) {
        const list = this.retiring.get(by)
        if (!list) return
        const left = list.filter(({ found, seq, dropped }) => {
            if (covered !== Infinity && seq > covered) return true
            this.deps.store.remove(found)
            dropped?.()
            return false
        })
        if (left.length) this.retiring.set(by, left)
        else this.retiring.delete(by)
    }

    private dropSuperseded(sessionId: string) {
        const old = this.superseded.get(sessionId)
        if (!old) return
        this.superseded.delete(sessionId)
        for (const { sessionId: id, seq } of old.keys) this.deps.store.clear(id, seq)
    }
}
