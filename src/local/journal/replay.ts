import type { JournalFound, JournalStore, LockService } from '../../platform/types'
import { ChunkBatch, Extractor, runToEnd } from '../chunks'
import { summaryOf } from '../flush'
import type { BatchSnapshot } from '../flushWrite'
import { sessionLock } from '../locks'
import type { JournalApplyBatch, JournalApplyResult } from './apply'
import { journalState } from './content'
import { readJournal, type JournalV1 } from './format'
import type { RecoveredBytes } from './handlers'

// Journal replay at load (Part 1 §1.6.4 #7, §1.11.3's `startupApplyJournals`): every pending
// `journal.*` key whose session no live tab holds is applied to its session in the database,
// kept as a recovery session when it can't be, or moved into the `recovered` store when it can't
// be read; a journal from a newer build stays for a later one. The key goes only after its
// transaction commits. Until Step 4's recovery order, startup is today's: the recovered work is
// stored, not opened, and no load notice is shown.

/** What the worker does for replay. */
export type JournalWorker = {
    applyJournal: (batch: JournalApplyBatch) => Promise<JournalApplyResult>
    keepRecovered: (item: RecoveredBytes) => Promise<void>
}

export type JournalOutcome =
    | { sessionId: string; kind: JournalApplyResult['kind']; result: JournalApplyResult }
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
    newId?: () => string
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
    const newId = deps.newId ?? (() => crypto.randomUUID())
    return {
        sessionId: journal.sessionId,
        seq: journal.seq,
        descriptor: journal.descriptor,
        stack: journal.stack,
        text,
        ends,
        snapshot,
        summary: summaryOf(state, plan.noteCount),
        label: deps.label(journal.stack.dropped.length),
        recovery: { chainId: newId(), docId: newId(), sessionId: newId() },
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
                await deps.worker.keepRecovered({
                    id: (deps.newId ?? (() => crypto.randomUUID()))(),
                    source: 'journal',
                    from: found.from,
                    sessionId,
                    text: found.text,
                    appVersion: deps.appVersion,
                })
                deps.store.remove(found)
                return { sessionId, kind: 'unreadable', why }
            }
            try {
                const reading = readJournal(found.text, sessionId)
                if (reading.kind === 'later') return { sessionId, kind: 'later', why: reading.why }
                if (reading.kind === 'unreadable') return await unreadable(reading.why)
                const content = journalState(reading.journal)
                if (content.kind === 'later') return { sessionId, kind: 'later', why: content.why }
                if (content.kind === 'unreadable') return await unreadable(content.why)
                const result = await deps.worker.applyJournal(
                    planBatch(reading.journal, content.state, deps),
                )
                // Its transaction committed: the key goes, unless it changed meanwhile.
                if (result.kind !== 'later') deps.store.remove(found)
                return { sessionId, kind: result.kind, result }
            } catch (error) {
                // Left in place for the next load.
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
