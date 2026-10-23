import { i18n } from '../i18n'
import type { OpenResult } from '../local/startup/api'
import { notify } from './notification'

/** Why a stored session could not be opened, as a sentence. */
export const failureLine = (why: 'deleted' | 'missing' | 'later' | 'damaged') => {
    const { load } = i18n.value
    return why === 'deleted'
        ? load.sessionDeleted
        : why === 'later'
          ? load.sessionLater
          : load.sessionDamaged
}

/**
 * Says why an open failed, as a card: the user asked for it. A request that was replaced,
 * answered Cancel or had nothing says nothing.
 */
export const notifyNotOpened = (result: OpenResult) => {
    if (result.opened || result.why === 'none' || result.why === 'blank') return
    const { why } = result
    notify(() => failureLine(why), { card: true, severity: 'error' })
}
