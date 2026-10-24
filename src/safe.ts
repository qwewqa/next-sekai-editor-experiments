import { WEB_MIGRATION_FLAGS } from './settings/migrationFlags'
import { storageKey } from './storage'

// Safe mode on the web (`?safe`): a blank editor over a read-only database that
// writes nothing to localStorage but settings. It is imported ahead of everything that stores
// (`launch.ts` imports it first), so the guard below is in place before any write.

export const SAFE_PARAM = 'safe'

const search = () => (typeof location === 'undefined' ? '' : location.search)

const safe = new URLSearchParams(search()).has(SAFE_PARAM)

/** Whether this page was opened with `?safe`; fixed for the page's life. */
export const isSafeMode = () => safe

const settingKeys = new Set<string>()

/** The settings module names its keys: the only localStorage keys safe mode writes. */
export const registerSettingKeys = (keys: Iterable<string>) => {
    for (const key of keys) settingKeys.add(storageKey(key))
}

const flagKeys = new Set(WEB_MIGRATION_FLAGS.map(storageKey))
const ownPrefix = storageKey('')

/** Whether safe mode lets this localStorage key change: a setting, or a key outside the editor's own. */
export const safeModeMayWrite = (key: string) =>
    !key.startsWith(ownPrefix) || settingKeys.has(key) || flagKeys.has(key)

const isLocalStorage = (storage: Storage) => {
    try {
        return storage === window.localStorage
    } catch {
        return false
    }
}

// Every module that stores (the journal, the canary, the device id, the version line) goes
// through localStorage, so one guard on it keeps the rule whatever they do. A refused write is
// dropped silently: callers read back what they wrote, and see that it isn't there.
const guardLocalStorage = () => {
    // Called back with their own storage as `this`.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const { setItem, removeItem, clear } = Storage.prototype
    Storage.prototype.setItem = function (key, value) {
        if (isLocalStorage(this) && !safeModeMayWrite(key)) return
        setItem.call(this, key, value)
    }
    Storage.prototype.removeItem = function (key) {
        if (isLocalStorage(this) && !safeModeMayWrite(key)) return
        removeItem.call(this, key)
    }
    Storage.prototype.clear = function () {
        if (isLocalStorage(this)) return
        clear.call(this)
    }
}

if (safe) guardLocalStorage()

/** This page's address with `?safe` added or removed, other parameters and the hash kept. */
export const safeModeUrl = (safe: boolean, href = location.href) => {
    const url = new URL(href)
    if (safe) url.searchParams.set(SAFE_PARAM, '')
    else url.searchParams.delete(SAFE_PARAM)
    // `?safe`, not `?safe=`.
    return url.pathname + url.search.replace(/([?&])safe=(?=&|$)/, '$1safe') + url.hash
}

/** Reloads in safe mode; the startup gate offers it when startup is slow or fails. */
export const openInSafeMode = () => {
    location.assign(safeModeUrl(true))
}

/**
 * Asked before Leave Safe Mode goes on, so an edit isn't lost silently: the in-app not-stored
 * prompt answers true to leave and false to stay, and answers true at once when
 * the tab has no edits.
 */
export type LeaveGuard = () => boolean | Promise<boolean>

let leaveGuard: LeaveGuard | undefined

/** The in-app not-stored prompt registers itself here; the last registration wins. */
export const setLeaveSafeModeGuard = (guard: LeaveGuard | undefined) => {
    leaveGuard = guard
}

/**
 * Leave Safe Mode: back to the editor without the parameter, after the registered guard, or
 * `fallback` (today's changes prompt, until the not-stored prompt registers) when there is none.
 */
export const leaveSafeMode = async (fallback?: LeaveGuard) => {
    const guard = leaveGuard ?? fallback
    if (guard && !(await guard())) return
    location.assign(safeModeUrl(false))
}
