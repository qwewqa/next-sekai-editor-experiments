import type { JournalFound, JournalStore, LockService } from '../../platform/types'
import { ChunkBatch, Extractor, runToEnd } from '../chunks'
import { summaryOf } from '../flush'
import type { BatchSnapshot } from '../flushWrite'
import { sessionLock } from '../locks'
import { RECORDS_V } from '../records/version'
import type { JournalApplyBatch, JournalApplyResult } from './apply'
import { journalState } from './content'
import { readJournal, type JournalV1 } from './format'
import type { RecoveredBytes } from './handlers'
import { recoveredId, recoveryIds } from './ids'

// Journal replay at load (Part 1 §1.6.4 #7, §1.11.3's `startupApplyJournals`): every pending
// `journal.*` key whose session no live tab holds is applied to its session in the database,
// kept as a recovery session when it can't be, or moved into the `recovered` store when it can't
// be read; a journal from a newer build stays for a later one. The key goes only after its
// transaction commits. Until Step 4's recovery order, startup is today's: the recovered work is
// stored, not opened, and no load notice is shown.

/** What the worker does for replay. */
export type JournalWorker = {
    applyJournal: (batch: JournalApplyBatch) => Promise<JournalApplyResult>
    /** Resolves false when the browser refuses the bytes (WebKit's private windows). */
    keepRecovered: (item: RecoveredBytes) => Promise<boolean>
}

export type JournalOutcome =
    | {
          sessionId: string
          kind: JournalApplyResult['kind']
          result: JournalApplyResult
          /** Main-thread reading and planning, and the worker's apply, for the timing spec. */
          ms: { read: number; plan: number; apply: number }
      }
    | { sessionId: string; kind: 'live' }
    | { sessionId: string; kind: 'later'; why: string }
    | { sessionId: string; kind: 'unreadable'; why: string }
    | { sessionId: string; kind: 'failed'; error: unknown }

export type ReplayDeps = {
    store: JournalStore
    locks: LockService
    worker: JournalWorker
    appVersion: string
    /** The `recovered` entry's label, naming the undo steps that weren't kept (§1.6.4 step 4). */
    label: (dropped: number) => string
    now?: () => number
}

const encoder = new TextEncoder()

/** The journal's state as a batch for the worker: every chunk new, as a fresh memo plans it. */
const planBatch = (
    journal: JournalV1,
    state: Parameters<Extractor['plan']>[0],
    deps: ReplayDeps,
): JournalApplyBatch => {
    const batch = new ChunkBatch()
    const plan = runToEnd(new Extractor().plan(state, batch))
    const parts = batch.texts.map((text) => encoder.encode(text))
    const ends: number[] = []
    let total = 0
    for (const part of parts) ends.push((total += part.length))
    const text = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
        text.set(part, at)
        at += part.length
    }
    const snapshot: BatchSnapshot = {
        header: plan.header,
        kinds: plan.kinds.map(({ kind, chunks }) => ({
            kind,
            chunks: chunks.map((chunk) => {
                const id = chunk.memo.pending?.id
                if (id === undefined) throw new Error('A fresh memo has a stored chunk')
                return id
            }),
        })),
        noteCount: plan.noteCount,
        media: [...plan.media],
    }
    return {
        sessionId: journal.sessionId,
        seq: journal.seq,
        descriptor: journal.descriptor,
        stack: journal.stack,
        text,
        ends,
        snapshot,
        summary: summaryOf(state, plan.noteCount),
        label: deps.label(journal.stack.droppedCount ?? journal.stack.dropped.length),
        recovery: recoveryIds(journal),
        appVersion: deps.appVersion,
        wall: (deps.now ?? Date.now)(),
    }
}

/** Replays one journal under its session's lock, taken only if no live tab holds it. */
export const replayJournal = (found: JournalFound, deps: ReplayDeps): Promise<JournalOutcome> =>
    deps.locks.request(
        sessionLock(found.sessionId),
        { ifAvailable: true },
        async (held): Promise<JournalOutcome> => {
            const { sessionId } = found
            // That tab owns its journal (§1.6.4 step 1).
            if (!held) return { sessionId, kind: 'live' }
            const unreadable = async (why: string): Promise<JournalOutcome> => {
                const kept = await deps.worker.keepRecovered({
                    id: await recoveredId(found.from, found.text),
                    source: 'journal',
                    from: found.from,
                    sessionId,
                    text: found.text,
                    appVersion: deps.appVersion,
                })
                // Refused: the key stays for a later load, and storing goes on.
                if (!kept)
                    return { sessionId, kind: 'failed', error: new Error('Its bytes were refused') }
                deps.store.remove(found)
                return { sessionId, kind: 'unreadable', why }
            }
            try {
                const start = performance.now()
                const reading = readJournal(found.text, sessionId)
                if (reading.kind === 'later') return { sessionId, kind: 'later', why: reading.why }
                if (reading.kind === 'unreadable') return await unreadable(reading.why)
                const content = journalState(reading.journal)
                // Level data this very build wrote and can't read back is a bug, not a newer
                // build's: its bytes are kept, so it isn't skipped at every load.
                if (
                    content.kind === 'later' &&
                    reading.journal.appVersion === deps.appVersion &&
                    reading.journal.recordsV === RECORDS_V
                )
                    return await unreadable(`its own ${content.why}`)
                if (content.kind === 'later') return { sessionId, kind: 'later', why: content.why }
                if (content.kind === 'unreadable') return await unreadable(content.why)
                const parsed = performance.now()
                let batch: JournalApplyBatch
                try {
                    batch = planBatch(reading.journal, content.state, deps)
                } catch (error) {
                    // Records of this state can't be made: that recurs on every load.
                    return await unreadable(`its records: ${String(error)}`)
                }
                const planned = performance.now()
                let result: JournalApplyResult
                try {
                    result = await deps.worker.applyJournal(batch)
                } catch (error) {
                    // Neither applied nor kept as a recovery session, by an error that recurs.
                    if (error instanceof Error && error.name === 'JournalUnappliableError')
                        return await unreadable(error.message)
                    throw error
                }
                // Its transaction committed: the key goes, unless it changed meanwhile.
                if (result.kind !== 'later') deps.store.remove(found)
                const ms = {
                    read: parsed - start,
                    plan: planned - parsed,
                    apply: performance.now() - planned,
                }
                return { sessionId, kind: result.kind, result, ms }
            } catch (error) {
                // Storage unavailable, full or busy: left in place for the next load.
                return { sessionId, kind: 'failed', error }
            }
        },
    )

/**
 * Named stub until Step 4's recovery order: applies every pending journal into the database at
 * load, before this tab's own session starts storing.
 */
export const startupApplyJournals = async (deps: ReplayDeps): Promise<JournalOutcome[]> => {
    const outcomes: JournalOutcome[] = []
    for (const found of await deps.store.read()) outcomes.push(await replayJournal(found, deps))
    return outcomes
}
