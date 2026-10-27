import { noticeCard, notify, type NoticeLine } from '../notification'
import { hostRefusalRow, knownRefusalLine } from './heldBgm'

/**
 * Raises a card that can carry a BGM refused for its length as a row: `compose` raises it, with
 * the row when a refusal is known. A refusal that comes while this card still shows composes it
 * again with the row, so no other card replaces it.
 */
export const raiseWithRefusal = (compose: (refusal?: NoticeLine) => void) => {
    compose(knownRefusalLine())
    const shown = noticeCard.value
    hostRefusalRow({
        shown: () => shown !== undefined && noticeCard.value === shown,
        raise: () => {
            compose(knownRefusalLine())
        },
    })
}

/** A warning card that carries a BGM refused for its length as a second row, before or after. */
export const notifyWarning = (message: () => string) => {
    raiseWithRefusal((refusal) => {
        if (refusal)
            notify(message, {
                lines: [{ message, severity: 'warning' }, refusal],
                // A screen reader hears the refusal row too.
                announcement: () => `${message()} ${refusal.message()}`,
            })
        else notify(message, { card: true, severity: 'warning' })
    })
}
