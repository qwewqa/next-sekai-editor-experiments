import type { JournalFound, JournalStore, LockService } from '../../platform/types'
import type { Extractor } from '../chunks'
import { sessionLock } from '../locks'
import { namePartsOf, type NameParts } from '../names'
import { RECORDS_V } from '../records/version'
import { stateBatch } from '../stateBatch'
import type { JournalApplyBatch, JournalApplyResult } from './apply'
import { journalState } from './content'
import { readJournal, type JournalV1 } from './format'
import type { RecoveredBytes } from './handlers'
import { recoveredId, recoveryIds } from './ids'

// Journal replay (Part 1 §1.6.4 #7): at load, as the recovery order's second step (Part 0
// §0.9.8), every pending `journal.*` key whose session no live tab holds is applied to its session
// in the database, kept as a recovery session when it can't be, or moved into the `recovered`
// store when it can't be read; a journal from a newer build stays for a later one. The key goes
// only after its transaction commits. Between loads, an operation on a session that isn't open
// replays its journal the same way under the lock it holds.

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
          /** What the recovered work's displayed name comes from, for its load notice. */
          names: NameParts
          /** The journal's session start: the date fallback's date. */
          startedAt: number
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

/** The journal's state as a batch for the worker: every chunk new, as a fresh memo plans it. */
const planBatch = (
    journal: JournalV1,
    state: Parameters<Extractor['plan']>[0],
    deps: ReplayDeps,
): JournalApplyBatch => {
    const { text, ends, snapshot, summary } = stateBatch(state)
    return {
        sessionId: journal.sessionId,
        seq: journal.seq,
        descriptor: journal.descriptor,
        stack: journal.stack,
        text,
        ends,
        snapshot,
        summary,
        label: deps.label(journal.stack.droppedCount ?? journal.stack.dropped.length),
        recovery: recoveryIds(journal),
        appVersion: deps.appVersion,
        wall: (deps.now ?? Date.now)(),
    }
}

/**
 * Replays one journal under its session's lock, taken only if no live tab holds it; with `held`,
 * this tab holds it already (its own reload, or an operation on that session, §1.6.4 step 1).
 */
export const replayJournal = (
    found: JournalFound,
    deps: ReplayDeps,
    { held: owned = false }: { held?: boolean } = {},
): Promise<JournalOutcome> => {
    const body = async (held: boolean): Promise<JournalOutcome> => {
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
            return {
                sessionId,
                kind: result.kind,
                result,
                names: namePartsOf(reading.journal.descriptor, content.state),
                startedAt: reading.journal.descriptor.startedAt,
                ms,
            }
        } catch (error) {
            // Storage unavailable, full or busy: left in place for the next load.
            return { sessionId, kind: 'failed', error }
        }
    }
    if (owned) return body(true)
    return deps.locks.request(sessionLock(found.sessionId), { ifAvailable: true }, body)
}

/**
 * The recovery order's journal step (Part 0 §0.9.8): every pending journal, in turn. `own` is the
 * session whose lock this tab already holds (its own reload, §1.4.2), replayed under that lock.
 */
export const replayJournals = async (
    deps: ReplayDeps,
    { own }: { own?: string } = {},
): Promise<JournalOutcome[]> => {
    const outcomes: JournalOutcome[] = []
    for (const found of await deps.store.read())
        outcomes.push(await replayJournal(found, deps, { held: found.sessionId === own }))
    return outcomes
}
