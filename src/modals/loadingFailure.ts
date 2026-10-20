import { i18n } from '../i18n'
import { errorMessage, TaskFailure } from '../utils/error'

export type LoadingFailure = {
    /** The localized one-line headline, or undefined when the error's own message is the text. */
    headline?: () => string
    /** Technical detail for the disclosure. */
    detail?: string
}

/**
 * What a loading dialog shows for a failed task. A known failure or a browser-raised error gets a
 * localized headline with its English text as detail; a plain `Error` already carries the
 * localized text its task chose, so that text is the message.
 */
export const describeFailure = (error: unknown): LoadingFailure => {
    if (error instanceof TaskFailure) {
        const { kind } = error
        return { headline: () => i18n.value.modals.loading[kind], detail: errorMessage(error) }
    }
    const raised =
        error instanceof DOMException ||
        error instanceof TypeError ||
        error instanceof RangeError ||
        !(error instanceof Error)
    if (raised) {
        return { headline: () => i18n.value.modals.loading.failed, detail: errorMessage(error) }
    }
    return {}
}
