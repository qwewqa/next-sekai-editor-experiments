import type { JournalStore } from '../../platform/types'
import type { State } from '../../state'
import type { Flusher } from '../flush'
import { buildJournal } from './build'

// The last-chance journal's writer (Part 1 §1.6.4 #7): written synchronously on hide, pagehide,
// beforeunload and freeze whenever the open session has entries not committed strictly, and
// verified by reading it back. One key per session, overwritten each time and cleared only once
// a strict flush covering its `seq` commits; a second trigger for the same `seq` writes nothing.

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
        // beforeunload, pagehide, visibilitychange and freeze can all fire for one close.
        if (last?.seq === seq && last.verified) return true
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
            console.error('The journal could not be written', error)
        }
        this.written.set(session.id, { seq, verified })
        this.deps.onWrite?.({
            sessionId: session.id,
            seq,
            ms: performance.now() - start,
            size,
            verified,
        })
        return this.verified(session.id, seq)
    }

    /** Whether the journal of the session's `seq` verified on this page and still counts. */
    verified(sessionId: string, seq: number) {
        const last = this.written.get(sessionId)
        return last?.seq === seq && last.verified && !this.deps.pausedForSpace()
    }

    /**
     * A flush committed the session's entries up to `seq`: a strict one clears its journal; a
     * relaxed one leaves the key for the next strict one, which a power loss can't undo.
     */
    committed(sessionId: string, seq: number, strict: boolean) {
        const last = this.written.get(sessionId)
        if (!strict || !last || last.seq > seq) return
        this.deps.store.clear(sessionId, seq)
        this.written.delete(sessionId)
    }
}
