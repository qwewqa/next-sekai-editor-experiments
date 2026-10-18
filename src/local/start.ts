import { shallowRef } from 'vue'
import { addLoadNotice, notify, type NoticeAction } from '../editor/notification'
import { session as currentSession } from '../history/session'
import { i18n } from '../i18n'
import { appVersion, platform } from '../platform'
import { PRODUCT_NAME } from '../product'
import { isSafeMode } from '../safe'
import { storageGet, storageKey } from '../storage'
import { interpolate } from '../utils/interpolate'
import { recoveredLabel } from './journal/label'
import { setSessionContext } from './startup/api'
import { addLoadEvent } from './startup/events'
import { claimTab, openAtStart, type Claim, type OpenDeps } from './startup/open'
import { runRecovery, type RecoveryContext } from './startup/steps'
import { watchMarker } from './startup/tab'
import { flusher, startStoring, tabClient, untouched, watchLifecycle } from './storing'
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
}

/** What storing can do in this tab; undefined until the worker answers. */
export const storageStatus = shallowRef<StorageStatus | undefined>()

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
    else if (status.mode === 'readOnly') notify(olderVersion)
}

const sayAtLoad = (status: StorageStatus) => {
    if (status.mode === 'memory' && status.reason === 'olderTabs')
        addLoadNotice(upgradeBlocked, tryAgainAction)
    else if (status.mode === 'readOnly') addLoadNotice(olderVersion)
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
    const { rpcTimeoutMs, holdReplayMs, ...workerFlags } = flags
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
    let status: StorageStatus
    let answered = true
    try {
        status = await worker.start()
        sayAtLoad(status)
    } catch {
        // The worker never answered: the client paused storing.
        status = worker.status ?? { mode: 'stored', reason: 'failed' }
        answered = false
    }
    const claim = await claiming
    if (!safe) watchMarker(() => currentSession.value.sessionId)
    const recovery = recoveryContext(worker, status, safe, claim)
    // Storing starts first, so a hide meanwhile writes this tab's journal; its flushes wait for
    // the recovery order, which runs before any session opens (Part 0 §0.9.8).
    const recover = async () => {
        if (!answered) return
        await runRecovery(recovery)
        if (test)
            window.nseJournalTest = { outcomes: recovery.outcomes, ms: recovery.journalMs ?? 0 }
    }
    const recovered = holdReplayMs
        ? new Promise((resolve) => setTimeout(resolve, holdReplayMs)).then(recover)
        : recover()
    startStoring(worker, status, test, recovered, { safe })
    let open = false
    try {
        await recovered
        if (answered && tabClient) {
            const deps: OpenDeps = {
                worker,
                status,
                locks: platform.locks,
                client: tabClient,
                safe,
                ...(recovery.migrated ? { migrated: recovery.migrated } : {}),
                ...(recovery.ownJournal ? { ownJournal: recovery.ownJournal } : {}),
                flusher: () => flusher,
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
        } else if (claim.kind === 'reload') claim.lock.release()
    } finally {
        if (test) window.nseStartupTest = { recovery, claim: claim.kind, opened: open }
    }
}
