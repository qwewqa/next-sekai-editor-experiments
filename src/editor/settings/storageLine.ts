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

// The storage line at the top of Settings › Local Data: one static line, the
// first condition that holds. It never overclaims, and says what can still remove stored work.

export type StorageLineKey =
    | 'unavailable'
    | 'private'
    | 'inAppBrowser'
    | 'ios'
    | 'safari'
    | 'installedWebkit'
    | 'persisted'
    | 'default'

export type StorageFacts = {
    /** Storage unavailable, insecure origins included. */
    unavailable: boolean
    privateSuspected: boolean
    /** Likely an app’s built-in browser. */
    inAppBrowser: boolean
    persisted: boolean
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

export const storageLineKey = (facts: StorageFacts): StorageLineKey => {
    if (facts.unavailable) return 'unavailable'
    if (facts.privateSuspected) return 'private'
    if (facts.inAppBrowser) return 'inAppBrowser'
    if (facts.os === 'ios' && !facts.standalone) return 'ios'
    if (facts.engine === 'webkit' && facts.os === 'macos' && !facts.standalone) return 'safari'
    if (facts.engine === 'webkit' && facts.standalone) return 'installedWebkit'
    return facts.persisted ? 'persisted' : 'default'
}

/** What the browser says about its storage, with the test override first. */
export const readBrowserFacts = async () => {
    const override = platformOverride()
    let persisted = override.persisted
    let quota: number | undefined
    try {
        persisted ??= await navigator.storage.persisted()
    } catch {
        // Unknown counts as not persisted.
    }
    if (override.privateSuspected === undefined)
        try {
            quota = (await navigator.storage.estimate()).quota
        } catch {
            // Without an estimate nothing suggests a private window.
        }
    const { os, engine } = detection()
    return {
        persisted: persisted === true,
        privateSuspected:
            override.privateSuspected ??
            (quota !== undefined && suspectPrivate({ persisted: persisted === true, quota })),
        inAppBrowser: platform.capabilities.likelyInAppBrowser,
        os,
        engine,
        standalone: isStandalone(),
    }
}
