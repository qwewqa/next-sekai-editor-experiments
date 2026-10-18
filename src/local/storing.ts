import { setExportPersister } from '../editor/commands/exportLevel/memory'
import { getVerticalScale } from '../editor/navigation'
import { view } from '../editor/view'
import { onHistoryAction } from '../history/actions'
import { filename } from '../history/live'
import { session as currentSession } from '../history/session'
import { liveState, setSlotLoader } from '../history/stack'
import { i18n } from '../i18n'
import { appVersion, platform } from '../platform'
import type { State } from '../state'
import { isDurablyStoredWith } from './durable'
import {
    Flusher,
    flushTimeoutMs,
    heldMediaOf,
    mediaTimeoutMs,
    type FlushReport,
    type FlushSession,
} from './flush'
import { toHex } from './hash'
import { journalContent } from './journal/content'
import { JournalWriter, type JournalWrite } from './journal/writer'
import { displayName, forkNameOf, namePartsOf } from './names'
import { inspectSnapshot } from './records/inspect'
import { stateFromRecords } from './records/records'
import { decodeSnapshot } from './records/snapshot'
import { holdSessionLock, TabClient } from './sessions'
import { leftSession } from './startup/api'
import {
    legacyFromJournal,
    removeLegacyRecovery,
    writeLegacyRecovery,
    writesLegacySlot,
} from './startup/legacy'
import { writeTabRecord } from './startup/tab'
import type { StorageWorker } from './worker/client'
import type { StorageStatus } from './worker/core'
import { transfer } from './worker/rpc'

// Storing (Part 1 §1.6.4): every change to the undo stack becomes an entry; the flush stores them
// about 1 s after the last change, at once and strictly on hide, and right after a media pick.
// The journal covers what isn't committed strictly; while storage is unavailable it's written on
// a slow idle timer too. For the first releases the legacy recovery slot is kept as well (§1.8).

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        /** The dev console's tools (§1.6.11.1's debug viewer). */
        nse?: { inspectSnapshot: (hash: string) => Promise<unknown> }
        /** The flusher for specs, when a storage test flag is seeded. */
        nseFlushTest?: {
            flusher: Flusher
            reports: FlushReport[]
            errors: unknown[]
            journal: { writer: JournalWriter | undefined; writes: JournalWrite[] }
            /** Set by a spec: flushes from now on never reach the worker. */
            stall?: boolean
            isDurablyStored: () => boolean
        }
    }
}

/** This tab's flusher, once storing started. */
export let flusher: Flusher | undefined

/** This tab's journal writer (§1.6.4 #7), once storing started; none in safe mode. */
export let journalWriter: JournalWriter | undefined

/** This tab's client id for `query()` (§1.6.5), once storing started. */
export let tabClient: TabClient | undefined

/** The page's own blank start, until a session replaces it. */
let initialSession: FlushSession | undefined

/**
 * Whether the tab still shows its own blank start, never edited: only then does startup open a
 * stored session over it, so nothing made meanwhile is lost to it (§1.4.2).
 */
export const untouched = () => {
    const session = flusher?.session
    return !!session && session === initialSession && !session.stored && session.pending.length <= 1
}

/**
 * Names the page's own blank start in the tab record, once startup opened nothing over it (§1.4.2):
 * until then the record keeps the session this tab had, so a reload meanwhile claims it again.
 */
export const recordBlankStart = () => {
    const session = flusher?.session
    if (session && session === initialSession)
        writeTabRecord({ sessionId: session.id, start: 'blank' })
}

/** Reopen offers a session this tab left, once its strict commit holds (§1.4.1). */
export const offerReopen = (leaving: FlushSession, outgoing: Promise<boolean>) => {
    if (!leaving.stored && !leaving.edited) return
    const state = [...leaving.pending].reverse().find((entry) => entry.state)?.state
    leftSession(
        leaving.id,
        displayName(namePartsOf({ sourceName: leaving.sourceName, ...leaving.chain }, state)),
        leaving.startedAt,
        outgoing,
    )
}

let storingWorker: StorageWorker | undefined

/**
 * Whether leaving the open session can lose it (§1.6.7's predicate). The journal is written
 * first when it's due, as the leave and switch triggers do; its verification decides.
 */
export const isDurablyStored = () => {
    journalWriter?.write()
    return isDurablyStoredWith({
        status: storingWorker?.status,
        flusher,
        journal: journalWriter,
        media: heldMediaOf(liveState.value).map((item) => item.hash),
    })
}

let watching = false

/**
 * Flushes at once and strictly on hide and freeze (§1.6.4). Watched from startup, before the
 * worker answers, so the page's listeners are all in place early and never added later.
 */
export const watchLifecycle = () => {
    if (watching) return
    watching = true
    platform.onLifecycle((event) => {
        if (event !== 'hide' && event !== 'freeze') return
        // The journal first, synchronously: the flush may not finish before the page goes.
        journalWriter?.write()
        void flusher?.flush({ strict: true, oneGo: true })
    })
    // beforeunload too (§1.6.4 #7); it never keeps the page itself.
    platform.onCloseRequested(() => {
        journalWriter?.write()
        return true
    })
}

/** Waits while a spec holds flushes, to leave edits only the journal has, as a kill does. */
const whileStalled = async () => {
    while (window.nseFlushTest?.stall) await new Promise((resolve) => setTimeout(resolve, 50))
}

/** About every 10 s while storage is unavailable and there are changes (§1.6.7). */
export const IDLE_JOURNAL_MS = 10_000
/** The legacy slot at idle: at most every 30–60 s (§1.8). */
export const LEGACY_IDLE_MS = 45_000

const whenIdle = (fn: () => void) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 5000 })
    else setTimeout(fn, 0)
}

/** The fields that differ from a chain record's, `undefined` meaning absent. */
const changedFields = (
    chain: Record<string, unknown> | undefined,
    fields: Record<string, unknown>,
) => {
    const changed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fields))
        if (value === undefined ? chain !== undefined && key in chain : chain?.[key] !== value)
            changed[key] = value
    return changed
}

export type StoringOptions = {
    /** Safe mode: nothing but settings goes to localStorage, so no journal or legacy slot. */
    safe?: boolean
}

/**
 * Starts storing: entries from now on, and the journal on hide. `replayed` is the recovery order
 * (Part 0 §0.9.8), which every flush waits for: journals are replayed before any session opens.
 */
export const startStoring = (
    worker: StorageWorker,
    status: StorageStatus,
    test: boolean,
    replayed: Promise<unknown> = Promise.resolve(),
    { safe = false }: StoringOptions = {},
) => {
    const afterReplay = replayed.catch(() => undefined)
    const reports: FlushReport[] = []
    const errors: unknown[] = []
    const locks = platform.locks
    // This tab's client id for query() (§1.6.5).
    const client = new TabClient(locks)
    tabClient = client
    void client.lock.granted.catch(() => undefined)

    if (status.mode === 'readOnly' && safe) {
        // Safe mode: nothing is written. Earlier actions are let go.
        onHistoryAction(() => undefined, { replay: true })
        return
    }

    const writes: JournalWrite[] = []
    const instance = new Flusher({
        appVersion: appVersion().appVersion,
        // A strict commit clears the journal it covers (§1.6.4 #7).
        onCommitted: (session, { seq, strict }) => {
            journalWriter?.committed(session.id, seq, strict)
        },
        syncStrict: () => worker.call('syncStrict'),
        transport: (batch, list, current) =>
            // A spec holds flushes to leave edits only the journal has, as a kill does.
            (test ? whileStalled() : Promise.resolve()).then(() =>
                worker.call('flush', transfer(batch, list), {
                    timeoutMs: flushTimeoutMs(batch),
                    current,
                }),
            ),
        storeMedia: (item) =>
            worker.call('storeMedia', item, { timeoutMs: mediaTimeoutMs(item.bytes.byteLength) }),
        view: () => ({
            scroll: view.time,
            zoom: getVerticalScale(),
            ...(view.groupId === undefined ? {} : { group: view.groupId }),
            ...(view.stageId === undefined ? {} : { stage: view.stageId }),
        }),
        lockSession: (id) => {
            const lock = holdSessionLock(locks, id)
            return { ready: lock.granted.catch(() => undefined), done: lock.release }
        },
        onFork: (fork, from) => {
            journalWriter?.forked(from, fork)
            if (currentSession.value.sessionId !== from.id) return
            // A separate copy of the file, or of the session, without the binding (§1.3.1).
            const file = from.chain?.file as { name?: unknown } | undefined
            const copyOf =
                typeof file?.name === 'string'
                    ? { name: file.name, bound: true }
                    : (currentSession.value.copyOf ?? {
                          name: currentSession.value.name ?? '',
                          bound: false,
                      })
            currentSession.value = {
                ...currentSession.value,
                sessionId: fork.id,
                docId: fork.docId,
                ...(fork.forkName === undefined ? {} : { name: fork.forkName }),
                copyOf,
            }
            writeTabRecord({ sessionId: fork.id, start: 'continuation', parent: from.id, copyOf })
        },
        forkName: (from: FlushSession) => forkNameOf(namePartsOf(from.chain, liveState.value)),
        writeChain: (request) => worker.call('writeChainFields', request),
        continueLabel: () => i18n.value.entry.continued,
        onFlushed: (report) => {
            if (test) reports.push(report)
        },
        onError: (error) => {
            if (test) errors.push(error)
            // A dev build's checks (D9, a published state changed in place) fail loudly; a newer
            // database's refusals are expected.
            if (import.meta.env.DEV && worker.status?.mode !== 'readOnly')
                console.error('A flush failed', error)
        },
    })
    flusher = instance
    storingWorker = worker
    // A newer database stores nothing from this build: as with storage unavailable, the journal
    // keeps the open session (§1.6.7).
    if (status.mode === 'readOnly') instance.withoutDatabase()
    const version = appVersion().appVersion
    const legacy = !safe && writesLegacySlot(version)
    if (!safe && !legacy) removeLegacyRecovery()
    let legacyState: State | undefined
    journalWriter = safe
        ? undefined
        : new JournalWriter({
              store: platform.journal,
              flusher: () => flusher,
              state: () => liveState.value,
              pausedForSpace: () => worker.status?.reason === 'full',
              strictCommits:
                  typeof IDBTransaction !== 'undefined' && 'durability' in IDBTransaction.prototype,
              appVersion: version,
              onWrite: (write) => {
                  if (test) writes.push(write)
              },
              // The legacy slot from the hide journal's level data (§1.8).
              onJournal: (journal, state) => {
                  if (!legacy) return
                  writeLegacyRecovery(JSON.stringify(legacyFromJournal(journal, filename.value)))
                  legacyState = state
              },
          })

    // Otherwise the legacy slot at idle, at most every 30–60 s, when the live state changed.
    if (legacy)
        setInterval(() => {
            const state = liveState.value
            if (state === legacyState || !instance.session?.edited) return
            whenIdle(() => {
                if (liveState.value !== state) return
                legacyState = state
                writeLegacyRecovery(
                    JSON.stringify(legacyFromJournal(journalContent(state), filename.value)),
                )
            })
        }, LEGACY_IDLE_MS)

    // While storage is unavailable the journal is also written about every 10 s (§1.6.7).
    if (status.mode !== 'stored' && journalWriter)
        setInterval(() => {
            whenIdle(() => journalWriter?.write())
        }, IDLE_JOURNAL_MS)

    // Export's target and name are the open chain's fields (§1.4.8).
    setExportPersister((fields) => {
        const changed = changedFields(instance.session?.chain, fields)
        if (Object.keys(changed).length) void instance.setChainFields(changed)
    })

    let firstReset = true
    onHistoryAction(
        (action) => {
            if (action.kind === 'reset') {
                const descriptor = currentSession.value
                const lock = holdSessionLock(locks, descriptor.sessionId)
                // A New reloads as blank (§1.4.2); the page's own blank start is recorded once
                // startup opened nothing over it (`recordBlankStart`).
                if (!firstReset || action.origin !== 'new')
                    writeTabRecord({
                        sessionId: descriptor.sessionId,
                        start: action.origin === 'import' ? 'stored' : 'new',
                    })
                const first = firstReset
                firstReset = false
                const leaving = instance.session
                const begun = instance.begin({
                    id: descriptor.sessionId,
                    docId: descriptor.docId,
                    origin: action.origin,
                    ...(descriptor.sourceName === undefined
                        ? {}
                        : { sourceName: descriptor.sourceName }),
                    state: action.state,
                    label: action.name,
                    dirty: action.isDirty,
                    // Without Web Locks (an insecure origin) there's no other tab to keep out.
                    ready: Promise.all([lock.granted.catch(() => undefined), afterReplay]),
                    done: lock.release,
                })
                if (first && action.origin === 'new') initialSession = begun
                if (leaving) offerReopen(leaving, instance.outgoing)
                return
            }
            instance.append(
                action.kind,
                action.name,
                action.state ?? action.snapshot,
                action.isDirty,
            )
        },
        { replay: true },
    )

    // A newer database opened by Try Again: nothing this tab holds will be stored.
    worker.onStatus((next) => {
        if (next.mode === 'readOnly') instance.withoutDatabase()
    })

    worker.onRestart(() => {
        void instance.restarted()
    })

    // A restored undo slot is built from its stored records when Undo or Redo reaches it.
    setSlotLoader(async (snapshot) => {
        const parts = await worker.call('readSnapshot', toHex(snapshot))
        const records = decodeSnapshot(parts.root, {
            node: (hex) => parts.nodes[hex],
            chunk: (hex) => parts.chunks[hex],
        })
        return stateFromRecords(records)
    })

    window.nse = {
        ...window.nse,
        inspectSnapshot: async (hash: string) => {
            const parts = await worker.call('readSnapshot', hash.toLowerCase())
            return inspectSnapshot(parts.root, {
                node: (hex) => parts.nodes[hex],
                chunk: (hex) => parts.chunks[hex],
            })
        },
    }
    if (test)
        window.nseFlushTest = {
            flusher: instance,
            reports,
            errors,
            journal: { writer: journalWriter, writes },
            isDurablyStored,
        }
    void worker.call('countDay').catch(() => undefined)
}
