import { markDeleted, undoDeleted } from '../../local/deletion'
import { dismissNoticeCard, noticeCard, notify } from '../notification'
import { backToNow, peekedSession } from './selection'
import { createDeleteModel } from './sessionDelete'

// This tab's Delete model, over the page's deletion core and the notice card.

const model = createDeleteModel({
    mark: markDeleted,
    undo: undoDeleted,
    card: ({ message, action, severity }) =>
        notify(message, {
            card: true,
            ...(action ? { action } : {}),
            ...(severity ? { severity } : {}),
        }),
    cardShown: (id) => noticeCard.value?.id === id,
    closeCard: (id) => {
        if (noticeCard.value?.id === id) dismissNoticeCard()
    },
    // The lists read again themselves: they hand `changed` their refresh while shown.
    changed: () => {
        for (const listener of listeners) listener()
    },
    endPeek: (chainId) => {
        if (peekedSession.value?.chainId === chainId) backToNow()
    },
})

const listeners = new Set<() => void>()

/** Lists show the model's changes by reading again; returns how to stop. */
export const onDeleteChanged = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export const sessionDelete = model
