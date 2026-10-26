import { recordError } from '../diagnostics'
import { i18n } from '../i18n'
import { notify } from './notification'

// Code the editor loads when an action first needs it can fail to load: a tab left open across a
// deploy, or one without a connection. The user who asked is told, and nothing else changes.

/** Records a failed load and shows the error card. */
export const loadFailed = (error: unknown) => {
    recordError(error)
    notify(() => i18n.value.modals.loading.failed, { card: true, severity: 'error' })
}

/** Runs a dynamic import for a user action; undefined, after the error card, when it fails. */
export const loadForAction = async <T>(load: () => Promise<T>): Promise<T | undefined> => {
    try {
        return await load()
    } catch (error) {
        loadFailed(error)
        return undefined
    }
}
