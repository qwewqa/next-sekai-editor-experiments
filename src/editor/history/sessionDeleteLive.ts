import { markDeleted, undoDeleted } from '../../local/deletion'
import { notify } from '../notification'
import { backToNow, peekedSession } from './selection'
import { createDeleteModel } from './sessionDelete'
import { deleteChanged } from './sessionsChanged'

// This tab's Delete model, over the page's deletion core. A Delete that did not happen has no
// inline row to say so: it is a card.

export const sessionDelete = createDeleteModel({
    mark: markDeleted,
    undo: undoDeleted,
    report: (message) => {
        notify(message, { card: true, severity: 'error' })
    },
    changed: deleteChanged,
    endPeek: (chainId) => {
        if (peekedSession.value?.chainId === chainId) backToNow()
    },
})
