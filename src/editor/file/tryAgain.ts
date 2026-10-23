import { i18n } from '../../i18n'
import { notify } from '../notification'
import { causeOf } from './notStored'

/**
 * Try Again for storing, from a button the user pressed (the chip's dialog, Settings › Local
 * Data): retries, and says so when storing is still not working. Success needs no notice, as the
 * chip and the line go away.
 */
export const tryStoringAgain = async () => {
    const { retryStoring } = await import('../../local/retryStoring')
    const status = await retryStoring()
    if (causeOf(status)) notify(() => i18n.value.notSaving.bar, { card: true, severity: 'warning' })
}
