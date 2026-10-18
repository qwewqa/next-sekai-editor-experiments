import { shallowRef } from 'vue'
import { storageGet, storageSet } from '../../storage'

// Three browser-wide flags (Part 1 §1.5.6, round 8 G6): plain keys the Settings UI doesn't show and
// Reset Settings leaves alone.

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

/** A download was confirmed once in this browser (§1.3.4). */
export const downloadConfirmed = confirmed.value
export const confirmDownloads = confirmed.set

/** A Save has run in this browser, so the Save dialog's download note no longer shows. */
export const firstSaveDone = firstSave.value
export const markFirstSaveDone = firstSave.set

/** Export Level Data… has run once (the Save dialog's Export line, §1.4.7). */
export const exportUsed = exported.value
export const markExportUsed = exported.set
