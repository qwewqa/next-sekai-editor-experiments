import { shallowRef } from 'vue'
import { storageGet, storageSet } from '../../storage'

// Three browser-wide flags: plain keys the Settings UI doesn't show and
// Reset Settings… leaves alone.

const readFlag = (key: string) => storageGet(key, false) === true

const flag = (key: string) => {
    const value = shallowRef(readFlag(key))
    return {
        value,
        set: () => {
            value.value = true
            try {
                storageSet(key, true)
            } catch {
                // Storage is unavailable: it holds for this tab.
            }
        },
    }
}

const confirmed = flag('downloadConfirmed')
const firstSave = flag('firstSaveDone')
const exported = flag('exportUsed')

/** A download was confirmed once in this browser. */
export const downloadConfirmed = confirmed.value
export const confirmDownloads = confirmed.set

/** A Save has run in this browser, so the Save dialog's storage line no longer shows. */
export const firstSaveDone = firstSave.value
export const markFirstSaveDone = firstSave.set

/** Export Level Data… has run once (the Save dialog's Export line). */
export const exportUsed = exported.value
export const markExportUsed = exported.set
