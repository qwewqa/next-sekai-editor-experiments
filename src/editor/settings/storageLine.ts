import { shallowRef } from 'vue'
import type { StorageStatus } from '../../local/worker/core'
import { platform } from '../../platform'
import {
    detection,
    isStandalone,
    platformOverride,
    suspectPrivate,
    type Engine,
} from '../../platform/detect'
import type { PlatformOs } from '../../platform/types'

// The storage line in Settings › Local Data and Recent Sessions: one static line, the first
// condition that holds. It shows only when something can delete stored work.

export type StorageLineKey = 'unavailable' | 'private' | 'inAppBrowser' | 'ios' | 'safari'

export type StorageFacts = {
    /** Storage unavailable, insecure origins included. */
    unavailable: boolean
    privateSuspected: boolean
    /** Likely an app’s built-in browser. */
    inAppBrowser: boolean
    os: PlatformOs
    engine: Engine
    /** A Home Screen web app. */
    standalone: boolean
}

/**
 * Whether the browser cannot store: no storage at all, or a database from a newer build. A memory
 * tab waiting on older tabs has a browser that stores, and safe mode opens the database read-only
 * on purpose; the line describes the browser, so neither counts.
 */
export const storageUnavailable = (status: StorageStatus, safe: boolean) =>
    status.mode === 'memory' ? status.reason === undefined : status.mode === 'readOnly' && !safe

export const storageLineKey = (facts: StorageFacts): StorageLineKey | undefined => {
    if (facts.unavailable) return 'unavailable'
    if (facts.privateSuspected) return 'private'
    if (facts.inAppBrowser) return 'inAppBrowser'
    if (facts.os === 'ios' && !facts.standalone) return 'ios'
    if (facts.engine === 'webkit' && facts.os === 'macos' && !facts.standalone) return 'safari'
    return undefined
}

/** The browser's total for this origin; absent where it gives no usable figures. */
export type StorageTotal = { usage: number; quota: number }

type BrowserStorage = {
    facts: {
        privateSuspected: boolean
        inAppBrowser: boolean
        os: PlatformOs
        engine: Engine
        standalone: boolean
    }
    total: StorageTotal | undefined
}

/**
 * What the browser says about its storage, with the test override first: its facts and the total,
 * from one `estimate()`.
 */
const readStorage = async (): Promise<BrowserStorage> => {
    const override = platformOverride()
    let persisted = override.persisted
    let estimate: StorageEstimate | undefined
    try {
        persisted ??= await navigator.storage.persisted()
    } catch {
        // Unknown counts as not persisted.
    }
    try {
        estimate = await navigator.storage.estimate()
    } catch {
        // Without an estimate nothing suggests a private window, and no total shows.
    }
    const { usage, quota } = estimate ?? {}
    const { os, engine } = detection()
    return {
        facts: {
            privateSuspected:
                override.privateSuspected ??
                (quota !== undefined && suspectPrivate({ persisted: persisted === true, quota })),
            inAppBrowser: platform.capabilities.likelyInAppBrowser,
            os,
            engine,
            standalone: isStandalone(),
        },
        // Without both figures, no number shows.
        total:
            usage !== undefined && quota !== undefined && Number.isFinite(usage) && quota > 0
                ? { usage, quota }
                : undefined,
    }
}

/**
 * The last read. Local Data shows it at once and updates in place when a newer read ends. Absent
 * until the first read ends.
 */
export const browserStorage = shallowRef<BrowserStorage>()

let reading: Promise<BrowserStorage> | undefined

/** Reads the storage figures now (a read already under way is shared), and keeps the result. */
export const readBrowserStorage = () =>
    (reading ??= readStorage()
        .then((read) => (browserStorage.value = read))
        .finally(() => {
            reading = undefined
        }))

/** What the browser says about its storage. */
export const readBrowserFacts = async () => (await readBrowserStorage()).facts

/**
 * Starts the first read once the page is idle after startup, with the same timing as the close
 * prompt's modules (`closePrompt.ts`).
 */
export const readStorageWhenIdle = () => {
    const run = () => {
        if (!browserStorage.value && !reading) void readBrowserStorage()
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 })
    else setTimeout(run, 1000)
}
