import { i18n } from '../../i18n'
import type { PauseReason } from '../../local/worker/core'
import { PRODUCT_NAME } from '../../product'
import { interpolateRaw } from '../../utils/interpolate'

// Apart from `notStored.ts`, which Node tests load: the strings come from the i18n module.

/** Why storing is paused, as a sentence: the one wording for the Not stored dialog and Local Data. */
export const pausedReasonLine = (reason: PauseReason) => {
    const { storage } = i18n.value
    switch (reason) {
        case 'full':
            return storage.reason.full
        case 'failed':
            // Said by the line above it.
            return undefined
        case 'upgrading':
            return storage.reason.upgrading
        case 'olderTabs':
            return interpolateRaw(storage.reason.olderTabs, PRODUCT_NAME)
    }
}
