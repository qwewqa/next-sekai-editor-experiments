import { LOAD_ORDER } from '../editor/loadOrder'
import { addLoadNotice, notify, type NoticeAction } from '../editor/notification'
import { sweepMarkers } from '../editor/save/env'
import { session as currentSession } from '../history/session'
import { i18n } from '../i18n'
import { appVersion, platform } from '../platform'
import { PRODUCT_NAME } from '../product'
import { isSafeMode } from '../safe'
import { storageGet, storageKey } from '../storage'
import { interpolate } from '../utils/interpolate'
import { recoveredLabel } from './journal/label'
import { resumeAfterStartup } from './open/project'
import { setSessionContext } from './startup/api'
import { addLoadEvent, storageStatus } from './startup/events'
import { claimTab, openAtStart, type Claim, type OpenDeps } from './startup/open'
import { showSession, showState } from './startup/show'
import { runRecovery, type RecoveryContext } from './startup/steps'
import { watchMarker } from './startup/tab'
import {
    flusher,
    journalWriter,
    offerReopen,
    recordBlankStart,
    startStoring,
    tabClient,
    untouched,
    watchLifecycle,
} from './storing'
import { StorageWorker } from './worker/client'
import type { StorageStatus, TestFlags } from './worker/core'
import { transfer } from './worker/rpc'
import storageWorkerUrl from './worker/storage.worker?worker&url'

// Starts the storage worker after first paint (Part 1 §1.6.5), runs the recovery order (Part 0
// §0.9.8: the canary, the journals, the old auto save) and opens the session this load continues
// (§1.4.2), while the startup gate refuses input. It also says at load what the handshake found
// (§1.4.3): stored work behind other tabs, or a database newer than this build.

/** The worker's test flag, seeded like the other test keys (§1.11's test notes). */
export const STORAGE_TEST_KEY = 'nse.test.storage'
/** The fixture hook's no-storage key. */
export const NO_STORAGE_TEST_KEY = 'nse.test.noStorage'

type StorageTestFlags = TestFlags & {
    rpcTimeoutMs?: number
    /** Holds journal replay at load this long, for the spec of a hide meanwhile. */
    holdReplayMs?: number
    /** Holds the worker's start this long, for the spec of Start Blank's work before it answers. */
    holdStartMs?: number
}

export { storageStatus }

/** This tab's storage worker, once started. */
export let storageWorker: StorageWorker | undefined

const readFlags = (): { flags: StorageTestFlags; test: boolean } => {
    try {
        // A tab's own flag first, so a spec can run tabs of two simulated builds side by side.
        const text =
            sessionStorage.getItem(STORAGE_TEST_KEY) ?? localStorage.getItem(STORAGE_TEST_KEY)
        const noStorage = localStorage.getItem(NO_STORAGE_TEST_KEY) !== null
        const parsed = text ? (JSON.parse(text) as unknown) : undefined
        const flags =
            typeof parsed === 'object' && parsed !== null ? (parsed as StorageTestFlags) : {}
        if (noStorage) flags.noStorage = true
        // A simulated later version would upgrade the real database for good: dev builds only.
        if (!import.meta.env.DEV) delete flags.dbVersion
        return { flags, test: text !== null || noStorage }
    } catch {
        return { flags: {}, test: false }
    }
}

const upgradeBlocked = interpolate(() => i18n.value.load.upgradeBlocked, PRODUCT_NAME)
const olderVersion = () => i18n.value.load.olderVersion

const tryAgainAction: NoticeAction = {
    label: () => i18n.value.load.tryAgain,
    run: () => {
        void tryAgain()
    },
}

/** Try Again waits about 3 s for other tabs, then moves what was stored in memory. */
const TRY_AGAIN_TIMEOUT_MS = 30_000

/** Try Again behind a blocked upgrade: asks again; still blocked says so again. */
const tryAgain = async () => {
    const worker = storageWorker
    if (!worker) return
    let status: StorageStatus
    try {
        // The move from memory can be long; the watchdog waits while it makes progress.
        status = await worker.call('tryAgain', undefined, { timeoutMs: TRY_AGAIN_TIMEOUT_MS })
    } catch {
        return
    }
    if (status.mode === 'memory' && status.reason === 'olderTabs')
        notify(upgradeBlocked, { action: tryAgainAction })
    else if (status.mode === 'readOnly') notify(olderVersion, { card: true })
}

const sayAtLoad = (status: StorageStatus) => {
    if (status.mode === 'memory' && status.reason === 'olderTabs')
        addLoadNotice(upgradeBlocked, tryAgainAction, LOAD_ORDER.handshake)
    else if (status.mode === 'readOnly')
        addLoadNotice(olderVersion, undefined, LOAD_ORDER.handshake)
}

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        /** What the recovery order found at this load, for specs, under a storage test flag. */
        nseStartupTest?: { recovery: RecoveryContext; claim: Claim['kind']; opened: boolean }
        /** What journal replay did at this load, for specs, under a storage test flag. */
        nseJournalTest?: { outcomes: RecoveryContext['outcomes']; ms: number }
    }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A call's timeout: the usual 10 s and a second more per MB, as a flush's. */
const timeoutFor = (bytes: number) => 10_000 + bytes / 1000

/** The recovery order's context over this tab's worker and localStorage. */
const recoveryContext = (
    worker: StorageWorker,
    status: StorageStatus,
    safe: boolean,
    claim: Claim,
): RecoveryContext => ({
    worker: {
        applyJournal: (batch) =>
            worker.call('applyJournal', transfer(batch, [batch.text.buffer]), {
                timeoutMs: timeoutFor(batch.text.byteLength),
            }),
        keepRecovered: (item) =>
            worker.call('keepRecovered', item, { timeoutMs: timeoutFor(item.text.length) }),
        readMetaIds: () => worker.call('readMetaIds'),
        migratedBefore: (hash) => worker.call('migratedBefore', hash),
        migrateAutoSave: (batch) =>
            worker.call('migrateAutoSave', transfer(batch, [batch.text.buffer]), {
                timeoutMs: timeoutFor(batch.text.byteLength),
            }),
    },
    status,
    locks: platform.locks,
    journal: platform.journal,
    storage: () => {
        try {
            return localStorage
        } catch {
            return undefined
        }
    },
    prefix: storageKey(''),
    appVersion: appVersion().appVersion,
    safe,
    labels: {
        recovered: (dropped) => recoveredLabel(i18n.value, dropped),
        migrated: i18n.value.entry.migrated,
    },
    ...(claim.kind === 'reload' ? { own: claim.record.sessionId } : {}),
    outcomes: [],
    keptForLocalData: [],
    events: addLoadEvent,
})

/** Whether this context can store at all: insecure origins have no locks or crypto.subtle. */
const canStore = () =>
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof indexedDB !== 'undefined' &&
    'locks' in navigator

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        /** The storage worker for specs, when a storage test flag is seeded. */
        nseStorageTest?: {
            worker: StorageWorker
            status: () => StorageStatus | undefined
        }
    }
}

/**
 * The startup sequence (§1.4.2): resolves once the session this load continues is open, and
 * rejects when a journal, a row or the migration triggered a bug; the startup gate follows it.
 */
export const startStorage = async () => {
    if (storageWorker) return
    const { flags, test } = readFlags()
    if (!canStore()) flags.noStorage = true
    // Safe mode opens the database read-only and writes nothing but settings (§1.4.2).
    const safe = isSafeMode()
    if (safe) flags.readOnly = true
    const deviceId = storageGet('deviceId', undefined)
    const { rpcTimeoutMs, holdReplayMs, holdStartMs, ...workerFlags } = flags
    const dev = import.meta.env.DEV
    const worker = new StorageWorker(
        { url: storageWorkerUrl, type: dev ? 'module' : 'classic', blobRestart: !dev },
        {
            appVersion: appVersion().appVersion,
            deviceId: typeof deviceId === 'string' ? deviceId : undefined,
            flags: workerFlags,
            test,
        },
        { timeoutMs: rpcTimeoutMs },
    )
    storageWorker = worker
    watchLifecycle()
    worker.onStatus((status) => {
        storageStatus.value = status
    })
    if (test) window.nseStorageTest = { worker, status: () => storageStatus.value }

    // A connection the browser dropped in the background is reopened on return.
    const resume = () => {
        void worker.call('resume').catch(() => undefined)
    }
    window.addEventListener('pageshow', resume)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') resume()
    })

    // Reload or Duplicate Tab, by the session lock, before the recovery order (§1.4.2).
    const claiming = claimTab(platform.locks).catch((): Claim => ({ kind: 'none' }))
    const starting = (holdStartMs ? wait(holdStartMs) : Promise.resolve())
        .then(() => worker.start())
        .then(
            (status) => {
                // Safe mode opens read-only on purpose: its bar says so, not a notice about a
                // newer database.
                if (!safe) sayAtLoad(status)
                return { status, answered: true }
            },
            // The worker never answered: the client paused storing.
            () => ({
                status: worker.status ?? { mode: 'stored', reason: 'failed' },
                answered: false,
            }),
        )
    let claim = { kind: 'none' } as Claim
    let recovery: RecoveryContext | undefined
    // The recovery order, once the worker answered; every flush waits for it (Part 0 §0.9.8).
    const recovered = (async () => {
        const { status, answered } = await starting
        claim = await claiming
        if (!safe) watchMarker(() => currentSession.value.sessionId)
        const context = recoveryContext(worker, status, safe, claim)
        recovery = context
        if (!answered) return
        if (holdReplayMs) await wait(holdReplayMs)
        await runRecovery(context)
        if (test) window.nseJournalTest = { outcomes: context.outcomes, ms: context.journalMs ?? 0 }
    })()
    // Storing starts before the worker answers, so a hide while it doesn't (Start Blank's work)
    // writes this tab's journal: no edit is ever without one. Safe mode writes none, and starts
    // once it knows whether the database opened read-only.
    if (safe) startStoring(worker, (await starting).status, test, recovered, { safe })
    else
        startStoring(
            worker,
            starting.then(({ status }) => status),
            test,
            recovered,
            { safe },
        )
    const { status, answered } = await starting
    let open = false
    try {
        await recovered
        if (answered && tabClient && recovery) {
            const own = recovery.ownOutcome
            const deps: OpenDeps = {
                worker,
                status,
                locks: platform.locks,
                client: tabClient,
                safe,
                journal: platform.journal,
                ...(recovery.migrated ? { migrated: recovery.migrated } : {}),
                ...(recovery.ownJournal ? { ownJournal: recovery.ownJournal } : {}),
                ...(recovery.ownLeft ? { ownLeft: true } : {}),
                ...(recovery.ownFailed ? { ownFailed: true } : {}),
                ...(own && 'result' in own && own.result.kind === 'recovery'
                    ? { ownRecovery: own.result.sessionId }
                    : {}),
                keptForLocalData: recovery.keptForLocalData,
                flusher: () => flusher,
                show: showSession,
                showState,
                onLeft: offerReopen,
                retireJournal: (found, by, seq, dropped) =>
                    journalWriter?.retire(found, by, seq, dropped),
                untouched,
                labels: {
                    continued: () => i18n.value.entry.continued,
                    recoveredHead: () => i18n.value.entry.recovered,
                },
                events: addLoadEvent,
            }
            open = await openAtStart(deps, claim)
            // Reopen, Restore as a Copy and Local Data's rows act through these from now on.
            setSessionContext(deps, recovery)
            // An open's import a tab didn't finish: resumed or ended once startup is done (§1.5.4).
            if (!safe && status.mode === 'stored') {
                resumeAfterStartup(appVersion().appVersion)
                // Only markers of definitely deleted chains can be reclaimed here.
                const sweep = () => {
                    void sweepMarkers(worker)
                }
                if (typeof requestIdleCallback === 'function')
                    requestIdleCallback(sweep, { timeout: 5000 })
                else setTimeout(sweep, 1000)
            }
        } else if (claim.kind === 'reload') claim.lock.release()
    } finally {
        // The tab record names the blank start only now, so a reload meanwhile claims again;
        // never when the worker didn't answer (a page torn down mid-start), which decided
        // nothing. Work on it named it already.
        if (!open && answered) recordBlankStart()
        if (test && recovery) window.nseStartupTest = { recovery, claim: claim.kind, opened: open }
    }
}
