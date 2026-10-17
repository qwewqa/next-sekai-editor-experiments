import { appVersion } from './platform/version'
import { isInternalKey } from './settings/migrationFlags'
import { storageGet, storageKey, storageSet } from './storage'

// What this load knows about earlier visits (Part 1 §1.7.3). It runs before the settings module,
// whose first load writes flags of its own, so it is imported ahead of everything that imports it.

/** Whether any key other than a migration flag or internal state is stored: a returning visitor. */
export const isExistingUser = (keys: readonly string[], prefix: string) =>
    keys.some((key) => key.startsWith(prefix) && !isInternalKey(key.slice(prefix.length)))

/** The `X.Y.Z` part of a version. */
export const releaseOf = (version: string) => version.split('+')[0] ?? version

/** Whether the start-up pill says "Updated to version X.Y.Z" (Part 1 §1.7.3). */
export const isUpdate = (last: string | undefined, current: string, existing: boolean) =>
    last === undefined ? existing : releaseOf(last) !== releaseOf(current)

export const LAST_VERSION_KEY = 'lastAppVersion'

type Launch = { isExistingUser: boolean; updated: boolean; release: string }

const start = (): Launch => {
    const release = releaseOf(appVersion().appVersion)
    if (typeof window === 'undefined') return { isExistingUser: false, updated: false, release }
    let existing = false
    let last: unknown
    try {
        const keys = Array.from(
            { length: localStorage.length },
            (_, i) => localStorage.key(i) ?? '',
        )
        existing = isExistingUser(keys, storageKey(''))
        last = storageGet(LAST_VERSION_KEY, undefined)
        storageSet(LAST_VERSION_KEY, release)
    } catch {
        // Storage can be unavailable: no update line, and nothing remembered.
        return { isExistingUser: existing, updated: false, release }
    }
    const previous = typeof last === 'string' ? last : undefined
    return { isExistingUser: existing, updated: isUpdate(previous, release, existing), release }
}

export const launch: Launch = start()
