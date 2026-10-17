import { shallowRef } from 'vue'
import { addLoadNotice, notify, type NoticeAction } from '../editor/notification'
import { i18n } from '../i18n'
import { appVersion } from '../platform'
import { PRODUCT_NAME } from '../product'
import { storageGet } from '../storage'
import { interpolate } from '../utils/interpolate'
import { startStoring } from './storing'
import { StorageWorker } from './worker/client'
import type { StorageStatus, TestFlags } from './worker/core'
import storageWorkerUrl from './worker/storage.worker?worker&url'

// Starts the storage worker after first paint (Part 1 §1.6.5) and says at load what the
// handshake found (§1.4.3): stored work behind other tabs, or a database newer than this build.
// Until Step 4, startup is today's: the auto save restores, and storing runs alongside it.

/** The worker's test flag, seeded like the other test keys (§1.11's test notes). */
export const STORAGE_TEST_KEY = 'nse.test.storage'
/** The fixture hook's no-storage key. */
export const NO_STORAGE_TEST_KEY = 'nse.test.noStorage'

type StorageTestFlags = TestFlags & { rpcTimeoutMs?: number }

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

/** Try Again behind a blocked upgrade: asks again; still blocked says so again. */
const tryAgain = async () => {
    const worker = storageWorker
    if (!worker) return
    let status: StorageStatus
    try {
        status = await worker.call('tryAgain')
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

export const startStorage = async () => {
    if (storageWorker) return
    const { flags, test } = readFlags()
    if (!canStore()) flags.noStorage = true
    const deviceId = storageGet('deviceId', undefined)
    const { rpcTimeoutMs, ...workerFlags } = flags
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

    let status: StorageStatus
    try {
        status = await worker.start()
        sayAtLoad(status)
    } catch {
        // The worker never answered: the client paused storing.
        status = worker.status ?? { mode: 'stored', reason: 'failed' }
    }
    startStoring(worker, status, test)
}
