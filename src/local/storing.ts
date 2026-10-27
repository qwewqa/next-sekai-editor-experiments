import { recordError } from '../diagnostics'
import {
    setExportHandleReader,
    setExportPersister,
    setExportTargetReader,
    setUnregisteredTargetCheck,
} from '../editor/commands/exportLevel/memory'
import { setTargetLock } from '../editor/commands/exportLevel/targetLock'
import { setFileActions } from '../editor/file'
import { loadForAction } from '../editor/loadFailure'
import { configureHeldBgm, decodeBgmData, withCachedBgm } from '../editor/media/heldBgm'
import { getVerticalScale } from '../editor/navigation'
import { setSaveEnvironment } from '../editor/save/binding'
import { markedSeq, removeMarker, withBind } from '../editor/save/env'
import { refreshBinding, watchBindings } from '../editor/save/watch'
import { withSwitchRequest } from '../editor/switchRequest'
import { view } from '../editor/view'
import { warmUp } from '../editor/warmUp'
import { onHistoryAction } from '../history/actions'
import { createHistoryOperation } from '../history/createHistoryOperation'
import { captureEntryDescription } from '../history/operations'
import { setPeekSource } from '../history/peek'
import { session as currentSession } from '../history/session'
import { liveState, setSlotLoader } from '../history/stack'
import { appVersion, platform } from '../platform'
import { startupEnded, startupGate } from '../startup/gate'
import { keepClockWhile } from '../time'
import { chainStartOf } from './chainFields'
import { postSessionUpdated } from './channel'
import { runSliced } from './chunks'
import { isDurablyStoredWith, notDurableReason } from './durable'
import {
    Flusher,
    flushTimeoutMs,
    hasChainRecord,
    heldMediaOf,
    mediaTimeoutMs,
    type FlushReport,
    type FlushSession,
} from './flush'
import { notifyFlusherStart, onFlusherStart } from './flusherStart'
import { checkPrivateWindow, handleOf } from './handles'
import { JournalWriter, type JournalWrite } from './journal/writer'
import { displayName, forkNameOf, namePartsOf, sessionCopyOf } from './names'
import { isImporting, whenImported } from './open/importLoop'
import { createPeekSource, rememberRoots, slotLoader } from './peekSource'
import { inspectSnapshot } from './records/inspect'
import { setRetrySource } from './retryStoring'
import { holdSessionLock, TabClient } from './sessions'
import { leftSession } from './startup/api'
import { previousSession } from './startup/events'
import { writeTabRecord } from './startup/tab'
import { readValue, storedRead } from './storedRead'
import type { StorageWorker } from './worker/client'
import type { StorageStatus } from './worker/core'
import { transfer } from './worker/rpc'

// Storing: every change to the undo stack becomes an entry; the flush stores them
// about 1 s after the last change, at once and strictly on hide, and right after a media pick.
// The journal covers what isn't committed to the database; while storage is unavailable it's
// written on a slow idle timer too.

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        /** The dev console's tools: dev builds and test flags only. */
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

export { onFlusherStart }

/**
 * Safe mode: the flusher holds the open session in memory only, so Save builds from
 * what this tab holds; no journal, tab record or Reopen is written.
 */
let safeMode = false

/** This tab's journal writer, once storing started; none in safe mode. */
export let journalWriter: JournalWriter | undefined

/** This tab's client id for `query()`, once storing started. */
export let tabClient: TabClient | undefined

/** The page's own blank start, until a session replaces it. */
let initialSession: FlushSession | undefined

/**
 * Whether the tab still shows its own blank start, never edited: only then does startup open a
 * stored session over it, so nothing made meanwhile is lost to it.
 */
export const untouched = () => {
    const session = flusher?.session
    return !!session && session === initialSession && !session.stored && session.pending.length <= 1
}

/**
 * Names the page's own blank start in the tab record, once startup opened nothing over it:
 * until then the record keeps the session this tab had, so a reload meanwhile claims it again.
 */
export const recordBlankStart = () => {
    if (safeMode) return
    const session = flusher?.session
    if (session && session === initialSession)
        writeTabRecord({ sessionId: session.id, start: 'blank' })
}

/**
 * Reopen offers a session this tab left, once its commit holds: an unstored,
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
        // The date that names an untitled session is its chain's first start, not this visit's.
        chainStartOf(leaving.chain, leaving.startedAt) ?? leaving.startedAt,
        outgoing,
    )
}

let storingWorker: StorageWorker | undefined

/**
 * Whether leaving the open session can lose it. The journal is written
 * first when it's due, as the leave and switch triggers do; its verification decides.
 */
const durabilityInputs = () => ({
    status: storingWorker?.status,
    flusher,
    journal: journalWriter,
    media: heldMediaOf(liveState.value).map((item) => item.hash),
})

export const isDurablyStored = () => {
    journalWriter?.write()
    return isDurablyStoredWith(durabilityInputs())
}

/**
 * Runs the strict flush when the only thing missing is the first write: an edit made within the
 * flush delay of a visit's start is not stored yet, and the flush is due. A storing that is
 * paused or unavailable gets none, and a flush that fails leaves the reason in place.
 */
export const flushFirstWrite = async () => {
    if (notDurableReason(durabilityInputs()) !== 'notWritten') return
    await flusher?.flush({ strict: true })
}

let watching = false

/**
 * Flushes at once and strictly on hide and freeze. Watched from startup, before the
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
    // beforeunload too; it never keeps the page itself.
    platform.onCloseRequested(() => {
        journalWriter?.write()
        return true
    })
}

/** Waits while a spec holds flushes, to leave edits only the journal has, as a kill does. */
const whileStalled = async () => {
    while (window.nseFlushTest?.stall) await new Promise((resolve) => setTimeout(resolve, 50))
}

/** How long a slot load waits for the next load's import resume to start. */
const RESUME_WAIT_MS = 4000

/** Whether the session's import runs here, or starts within `RESUME_WAIT_MS` (the resume). */
const importStarted = async (sessionId: string) => {
    for (let waited = 0; waited < RESUME_WAIT_MS; waited += 100) {
        if (isImporting(sessionId)) return true
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return isImporting(sessionId)
}

/** About every 10 s while storage is unavailable and there are changes. */
export const IDLE_JOURNAL_MS = 10_000

const whenIdle = (fn: () => void) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 5000 })
    else setTimeout(fn, 0)
}

export type StoringOptions = {
    /** Safe mode: nothing but settings goes to localStorage, so no journal. */
    safe?: boolean
}

/**
 * Starts storing: entries from now on, and the journal on hide. `replayed` is the recovery order
 * (the canary, the journals, the old auto save), which every flush waits for: journals are
 * replayed before any session opens.
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
    // This tab's client id for query().
    const client = new TabClient(locks)
    tabClient = client
    void client.lock.granted.catch(() => undefined)

    safeMode = safe

    const writes: JournalWrite[] = []
    const instance = new Flusher({
        appVersion: appVersion().appVersion,
        // Keep the app clock running during an extraction, so its slices come every frame: it runs
        // one slice per idle period, and without frames Chrome's idle periods come about 50 ms
        // apart.
        runJob: (job, options) => {
            const release = keepClockWhile(() => true)
            return runSliced(job, options).finally(release)
        },
        // A commit clears the journal it covers.
        onCommitted: (session, seq) => {
            journalWriter?.committed(session.id, seq)
        },
        syncStrict: () => worker.call('syncStrict'),
        // A chain made or its head moved: other tabs' Recent Sessions lists refresh.
        onChainMoved: () => {
            postSessionUpdated()
        },
        // A Save's binding stored: its marker goes (our own completed Save).
        onIdentity: (session, identity) => {
            removeMarker(session.chainId, identity.revision.id)
        },
        // Taken over while the binding waited in memory: the label follows the record.
        onStaleIdentity: () => {
            void refreshBinding(worker, flusher)
        },
        // A Save that may have written its file before a reload keeps its `seq`.
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
        liveHeld: () => heldMediaOf(liveState.value),
        view: () => ({
            scroll: view.time,
            zoom: getVerticalScale(),
            ...(view.groupId === undefined ? {} : { group: view.groupId }),
            ...(view.stageId === undefined ? {} : { stage: view.stageId }),
        }),
        lockSession: (id) => holdSessionLock(locks, id),
        onFork: (fork, from) => {
            journalWriter?.forked(from, fork)
            if (currentSession.value.sessionId !== from.id) return
            // A separate copy of the file, or of the session, without the binding.
            const file = from.chain?.file as { name?: unknown } | undefined
            const copyOf =
                typeof file?.name === 'string'
                    ? { name: file.name, bound: true }
                    : (currentSession.value.copyOf ??
                      sessionCopyOf(currentSession.value.name, currentSession.value.startedAt))
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
        continueOperation: (fromTime) =>
            createHistoryOperation({ id: 'nse.continue', data: { fromTime } }),
        onRoots: rememberRoots,
        onFlushed: (report) => {
            if (test) reports.push(report)
        },
        onError: (error) => {
            if (test) errors.push(error)
            // A newer database's refusals are expected.
            if (worker.status?.mode === 'readOnly') return
            // The ring keeps the failure for Copy Diagnostic Info….
            recordError(error)
            // A dev build's checks (a published state changed in place) fail loudly.
            if (import.meta.env.DEV) console.error('A flush failed', error)
        },
    })
    flusher = instance
    storingWorker = worker
    setRetrySource(() => ({ worker, flusher }))
    // Safe mode stores nothing: the session stays in this tab, for Save.
    if (safe) instance.withoutDatabase()
    // A newer database stores nothing from this build: as with storage unavailable, the journal
    // keeps the open session.
    void Promise.resolve(status).then((known) => {
        if (known.mode === 'readOnly') instance.withoutDatabase()
    })
    journalWriter = safe
        ? undefined
        : new JournalWriter({
              store: platform.journal,
              flusher: () => flusher,
              state: () => liveState.value,
              pausedForSpace: () => worker.status?.reason === 'full',
              appVersion: appVersion().appVersion,
              onWrite: (write) => {
                  if (test) writes.push(write)
              },
          })

    // While storage is unavailable the journal is also written about every 10 s.
    void Promise.resolve(status).then((known) => {
        if (known.mode === 'stored' || !journalWriter) return
        setInterval(() => {
            whenIdle(() => journalWriter?.write())
        }, IDLE_JOURNAL_MS)
    })

    // Export's target and name are the open chain's fields.
    setExportPersister((fields) => instance.setChainFieldsNow(fields))
    setExportTargetReader(async () => {
        const session = instance.session
        if (!session || !hasChainRecord(session)) return
        const record = await storedRead(worker, 'readChainRecord', session.chainId)
        return instance.session !== session ? readValue({}) : record
    })
    // Its handle is the chain's too, read when Export needs it.
    checkPrivateWindow()
    setExportHandleReader(async () => {
        const session = instance.session
        return session ? handleOf(worker, session.chainId, 'exportTarget') : readValue(undefined)
    })

    let firstReset = true
    let blankNamed = false
    let prefetched: FlushSession | undefined
    onHistoryAction(
        (action) => {
            if (action.kind === 'reset') {
                const descriptor = currentSession.value
                // A New reloads as blank; the page's own blank start is recorded once
                // startup opened nothing over it (`recordBlankStart`).
                if (!safe && (!firstReset || action.origin !== 'new'))
                    writeTabRecord({
                        sessionId: descriptor.sessionId,
                        start: action.origin === 'import' ? 'stored' : 'new',
                    })
                const first = firstReset
                firstReset = false
                const leaving = instance.session
                const lock = holdSessionLock(locks, descriptor.sessionId)
                let begun: FlushSession
                try {
                    begun = instance.begin({
                        id: descriptor.sessionId,
                        docId: descriptor.docId,
                        origin: action.origin,
                        ...(descriptor.sourceName === undefined
                            ? {}
                            : { sourceName: descriptor.sourceName }),
                        state: action.state,
                        operation: action.step.operation,
                        dirty: action.isDirty,
                        // Without Web Locks (an insecure origin) there's no other tab to keep out.
                        ready: Promise.all([lock.granted.catch(() => undefined), afterReplay]),
                        lock,
                    })
                } finally {
                    // The session took it as it registered; anything else goes.
                    lock.release()
                }
                if (first && action.origin === 'new') initialSession = begun
                if (leaving && !safe) offerReopen(leaving, instance.outgoing)
                return
            }
            // Work on the blank start (after Start Blank) names it in the tab record at once, so
            // a reload or crash while startup still runs brings that work back.
            if (instance.session === initialSession && !blankNamed) {
                blankNamed = true
                recordBlankStart()
            }
            // The bound file's handle read once the session is edited, so a Save's permission
            // request isn't behind a storage read (never at startup).
            if (startupGate.phase === 'done' && prefetched !== instance.session) {
                prefetched = instance.session
                void import('../editor/save/flow').then(
                    (flow) => flow.prefetchHandle(),
                    () => undefined,
                )
            }
            instance.append(
                captureEntryDescription(action),
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
    // Other tabs' takeovers show here as they happen.
    watchBindings(worker, () => flusher)
    // What the Save flows run in, read at each call: a fork or an open changes the session.
    setSaveEnvironment(() => {
        const session = flusher?.session
        return flusher && session
            ? { worker, flusher, session, chainId: session.chainId }
            : undefined
    })
    // The file state's dialogs run the Save flows, loaded on first use.
    const flows = () => import('../editor/save/flow')
    // A button on the file state: a load that fails says so, and changes nothing.
    const withFlow = async (
        run: (flow: Awaited<ReturnType<typeof flows>>) => void | Promise<void>,
    ) => {
        const flow = await loadForAction(flows)
        if (flow) await run(flow)
    }
    // Without the code to ask, the target is not authorized and a picker asks.
    setUnregisteredTargetCheck(async (target) => {
        const flow = await flows().catch((error: unknown) => {
            recordError(error)
        })
        return flow ? flow.exportTargetAvailable(target.handle) : false
    })
    setTargetLock((run) => withBind('shared', run))
    setFileActions({
        saveAs: () => void withFlow((flow) => flow.fileSaveAs()),
        downloadAgain: () => void withFlow((flow) => flow.fileDownloadAgain()),
        openOtherVersion: () =>
            void withSwitchRequest(undefined, async (request) => {
                try {
                    const flow = await loadForAction(flows)
                    if (flow && request.isCurrent()) await flow.openOtherVersion(request)
                } catch (error) {
                    if (request.isCurrent()) throw error
                }
            }),
        persistConfirmed: () =>
            void withFlow((flow) => {
                flow.persistConfirmed()
            }),
    })

    // Once startup is over, the code behind the likely features loads in the background.
    warmUp(startupEnded)

    worker.onRestart(() => {
        void instance.restarted()
    })

    // A restored undo slot is built from its stored records, verified, when Undo or Redo reaches it.
    // Right after a reload, a slot the resumed import hasn't brought yet loads once it has: the
    // load waits for the resume to start, then for the import, and tries again.
    const load = slotLoader((hex) => worker.call('readSnapshotVerified', hex))
    // A BGM this tab holds is attached to the slot it names, so Undo and Redo land with audio.
    setSlotLoader(async (snapshot) => {
        try {
            return withCachedBgm(await load(snapshot))
        } catch (error) {
            const id = instance.session?.id
            // Only a session whose open's import hasn't finished waits for it.
            const pending = id
                ? await storedRead(worker, 'openPendingImports', undefined)
                : undefined
            // A failed read of the pending list rethrows the load's error.
            if (
                !id ||
                pending?.storedRead !== 'value' ||
                !pending.storedValue.some((each) => each.sessionId === id)
            )
                throw error
            if (!(await importStarted(id))) throw error
            await whenImported(id)
            return withCachedBgm(await load(snapshot))
        }
    })

    // A state that names audio it does not hold gets it from the media store.
    configureHeldBgm({
        read: (hash, size) =>
            worker.call('readMedia', hash, { timeoutMs: mediaTimeoutMs(size ?? 0) }),
        decode: decodeBgmData,
        atStartup: () => startupGate.phase !== 'done',
        store: (item) =>
            worker.call('storeMedia', item, { timeoutMs: mediaTimeoutMs(item.bytes.byteLength) }),
    })

    // History's entries are peeked from memory or their stored snapshots.
    setPeekSource(createPeekSource(worker, () => flusher))

    // The debug viewer reads, and so only dev builds and a page with a storage test flag have it.
    if (import.meta.env.DEV || test)
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
    // Last, with storing fully set up: a subscriber never runs in the middle of the setup.
    notifyFlusherStart()
}
