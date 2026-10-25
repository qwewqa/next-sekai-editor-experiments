import { i18n } from '../i18n'
import { notify } from './notification'

// The in-app browser line's Copy Link: the page without its query or hash, which
// keeps `?safe` and the like out of what is pasted into a browser.

/** The clipboard API, else the older copy command, which some hosts still allow. */
const writeText = async (text: string) => {
    try {
        await navigator.clipboard.writeText(text)
        return true
    } catch {
        // The host may refuse the clipboard API; the older command is tried next.
    }
    const field = document.createElement('textarea')
    field.value = text
    field.readOnly = true
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.append(field)
    try {
        field.select()
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        return document.execCommand('copy')
    } catch {
        return false
    } finally {
        field.remove()
    }
}

export const copyPageLink = async () => {
    const copied = await writeText(location.origin + location.pathname)
    notify(() => (copied ? i18n.value.load.linkCopied : i18n.value.load.linkNotCopied))
}
