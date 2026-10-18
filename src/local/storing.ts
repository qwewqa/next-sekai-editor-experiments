import { setExportHandleReader, setExportPersister } from '../editor/commands/exportLevel/memory'
import {
    setExportReads,
    setPickLock,
    setProjectPickCheck,
} from '../editor/commands/exportLevel/pick'
import { setFileActions } from '../editor/file'
import { getVerticalScale } from '../editor/navigation'
import { markedSeq, removeMarker, withBind } from '../editor/save/env'
import { applyRevocations, refreshBinding, watchBindings } from '../editor/save/watch'
import { view } from '../editor/view'
import { onHistoryAction } from '../history/actions'
import { filename } from '../history/live'
import { setPeekSource } from '../history/peek'
import { session as currentSession } from '../history/session'
import { liveState, setSlotLoader } from '../history/stack'
import { i18n } from '../i18n'
import { appVersion, platform } from '../platform'
import { startupGate } from '../startup/gate'
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
import { checkPrivateWindow, handleOf } from './handles'
import { journalContent } from './journal/content'
import { JournalWriter, type JournalWrite } from './journal/writer'
import { displayName, forkNameOf, namePartsOf } from './names'
import { isImporting, whenImported } from './open/importLoop'
import { dropKept } from './open/kept'
import { createPeekSource, rememberRoots, slotLoader } from './peekSource'
import { inspectSnapshot } from './records/inspect'
import { holdSessionLock, TabClient } from './sessions'
import { leftSession } from './startup/api'
import { previousSession } from './startup/events'
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

/**
 * Safe mode (§1.4.2): the flusher holds the open session in memory only, so Save builds from
 * what this tab holds (§1.4.7); no journal, tab record, Reopen or revocation is written.
 */
let safeMode = false

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
    if (safeMode) return
    const session = flusher?.session
    if (session && session === initialSession)
        writeTabRecord({ sessionId: session.id, start: 'blank' })
}

/**
 * Reopen offers a session this tab left, once its strict commit holds (§1.4.1): an unstored,
 * unedited continuation stands for the session it continues.
 */
export const offerReopen = (leaving: FlushSession, outgoing: Promise<boolean>) => {
    const reopenable =
        leaving.stored || leaving.edited
            ? leaving.id
            : leaving.continuation
              ? leaving.parent?.id
              : undefined
    if (!reopenable) {
        previousSession.value = undefined
        return
    }
    const state = [...leaving.pending].reverse().find((entry) => entry.state)?.state
    leftSession(
        reopenable,
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

/** How long a slot load waits for the next load's import resume to start (§1.5.4). */
const RESUME_WAIT_MS = 4000

/** Whether the session's import runs here, or starts within `RESUME_WAIT_MS` (the resume). */
const importStarted = async (sessionId: string) => {
    for (let waited = 0; waited < RESUME_WAIT_MS; waited += 100) {
        if (isImporting(sessionId)) return true
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return isImporting(sessionId)
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
    /** What storing can do: a promise while the worker hasn't answered yet (outside safe mode). */
    status: StorageStatus | Promise<StorageStatus>,
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

    safeMode = safe

    const writes: JournalWrite[] = []
    const instance = new Flusher({
        appVersion: appVersion().appVersion,
        // A strict commit clears the journal it covers (§1.6.4 #7).
        onCommitted: (session, { seq, strict }) => {
            journalWriter?.committed(session.id, seq, strict)
        },
        syncStrict: () => worker.call('syncStrict'),
        // A Save's binding stored: its marker goes (§1.4.7, our own completed Save).
        onIdentity: (session, identity) => {
            removeMarker(session.chainId, identity.revision.id)
        },
        // Taken over while the binding waited in memory (R5, R6): the label follows the record.
        onStaleIdentity: () => {
            void refreshBinding(worker, flusher)
        },
        // A Save that may have written its file before a reload keeps its `seq` (§1.6.11.6).
        reservedSeq: markedSeq,
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
            // The fork has no binding, so no file in the label.
            const { file: _unbound, ...unbound } = currentSession.value
            currentSession.value = {
                ...unbound,
                sessionId: fork.id,
                docId: fork.docId,
                ...(fork.forkName === undefined ? {} : { name: fork.forkName }),
                copyOf,
            }
            if (!safe)
                writeTabRecord({
                    sessionId: fork.id,
                    start: 'continuation',
                    parent: from.id,
                    copyOf,
                })
        },
        forkName: (from: FlushSession) => forkNameOf(namePartsOf(from.chain, liveState.value)),
        writeChain: (request) => worker.call('writeChainFields', request),
        continueLabel: () => i18n.value.entry.continued,
        onRoots: rememberRoots,
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
    // Safe mode stores nothing: the session stays in this tab, for Save (§1.4.7 R11).
    if (safe) instance.withoutDatabase()
    // A newer database stores nothing from this build: as with storage unavailable, the journal
    // keeps the open session (§1.6.7).
    void Promise.resolve(status).then((known) => {
        if (known.mode === 'readOnly') instance.withoutDatabase()
    })
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
    void Promise.resolve(status).then((known) => {
        if (known.mode === 'stored' || !journalWriter) return
        setInterval(() => {
            whenIdle(() => journalWriter?.write())
        }, IDLE_JOURNAL_MS)
    })

    // Export's target and name are the open chain's fields (§1.4.8).
    setExportPersister((fields) => {
        const changed = changedFields(instance.session?.chain, fields)
        if (Object.keys(changed).length) void instance.setChainFields(changed)
    })
    // Its handle is the chain's too, read when Export needs it (D24).
    checkPrivateWindow()
    setExportHandleReader(async () => {
        const session = instance.session
        return session ? handleOf(worker, session.chainId, 'exportTarget') : undefined
    })

    let firstReset = true
    let blankNamed = false
    let prefetched: FlushSession | undefined
    onHistoryAction(
        (action) => {
            if (action.kind === 'reset') {
                const descriptor = currentSession.value
                const lock = holdSessionLock(locks, descriptor.sessionId)
                // A New reloads as blank (§1.4.2); the page's own blank start is recorded once
                // startup opened nothing over it (`recordBlankStart`).
                if (!safe && (!firstReset || action.origin !== 'new'))
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
                // A partial open's kept bytes go with its session (§1.5.4).
                if (leaving && leaving.chainId !== begun.chainId && !safe)
                    void dropKept(worker, leaving.chainId)
                if (leaving && !safe) offerReopen(leaving, instance.outgoing)
                return
            }
            // Work on the blank start (after Start Blank) names it in the tab record at once, so
            // a reload or crash while startup still runs brings that work back (§1.4.2).
            if (instance.session === initialSession && !blankNamed) {
                blankNamed = true
                recordBlankStart()
            }
            // The bound file's handle read once the session is edited, so a Save's permission
            // request isn't behind a storage read (D24: never at startup).
            if (startupGate.phase === 'done' && prefetched !== instance.session) {
                prefetched = instance.session
                void import('../editor/save/flow').then((flow) => flow.prefetchHandle())
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
        // Storing resumed: revocations kept meanwhile go in (§1.4.7 R11).
        if (next.mode === 'stored' && !next.reason && !safe) void applyRevocations(worker)
    })
    // At the next start, after the journals and before any cleanup (R11); then other tabs'
    // takeovers show here as they happen (R6).
    if (!safe) void afterReplay.then(() => applyRevocations(worker))
    watchBindings(worker, () => flusher)
    // The file state's dialogs and Export's picker run the Save flows, loaded on first use.
    const flows = () => import('../editor/save/flow')
    setProjectPickCheck(async (handle) => (await flows()).projectPick(handle))
    setPickLock((run) => withBind('exclusive', run))
    setExportReads({
        start: () =>
            void flows().then((flow) => {
                flow.startExportRead()
            }),
        end: () =>
            void flows().then((flow) => {
                flow.endExportRead()
            }),
    })
    setFileActions({
        saveAs: () => void flows().then((flow) => flow.fileSaveAs()),
        downloadAgain: () => void flows().then((flow) => flow.fileDownloadAgain()),
        openOtherVersion: () => void flows().then((flow) => flow.openOtherVersion()),
        persistConfirmed: () =>
            void flows().then((flow) => {
                flow.persistConfirmed()
            }),
    })

    worker.onRestart(() => {
        void instance.restarted()
    })

    // A restored undo slot is built from its stored records, verified, when Undo or Redo reaches it.
    // Right after a reload, a slot the resumed import hasn't brought yet loads once it has: the
    // load waits for the resume to start, then for the import, and tries again (§1.5.4).
    const load = slotLoader((hex) => worker.call('readSnapshotVerified', hex))
    setSlotLoader(async (snapshot) => {
        try {
            return await load(snapshot)
        } catch (error) {
            const id = instance.session?.id
            // Only a session whose open's import hasn't finished waits for it.
            const pending = id ? await worker.call('openPendingImports').catch(() => []) : []
            if (!id || !pending.some((each) => each.sessionId === id)) throw error
            if (!(await importStarted(id))) throw error
            await whenImported(id)
            return load(snapshot)
        }
    })

    // History's entries are peeked from memory or their stored snapshots (§1.4.11).
    setPeekSource(createPeekSource(worker, () => flusher))

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
    if (test && !safe)
        window.nseFlushTest = {
            flusher: instance,
            reports,
            errors,
            journal: { writer: journalWriter, writes },
            isDurablyStored,
        }
    if (!safe)
        void Promise.resolve(status).then(() => worker.call('countDay').catch(() => undefined))
}
