import { markDeleted, undoDeleted } from '../../local/deletion'
import { notify } from '../notification'
import { backToNow, peekedSession } from './selection'
import { createDeleteModel } from './sessionDelete'

// This tab's Delete model, over the page's deletion core. A Delete that did not happen has no
// inline row to say so: it is a card.

const listeners = new Set<() => void>()

export const sessionDelete = createDeleteModel({
    mark: markDeleted,
    undo: undoDeleted,
    report: (message) => {
        notify(message, { card: true, severity: 'error' })
    },
    changed: () => {
        for (const listener of listeners) listener()
    },
    endPeek: (chainId) => {
        if (peekedSession.value?.chainId === chainId) backToNow()
    },
})

/** Lists read again when the model changes; returns how to stop. */
export const onDeleteChanged = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
}
