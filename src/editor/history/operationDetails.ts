import { nextTick } from 'vue'
import type { OperationRecipe } from '../../history/operationPresentation'
import { peekSourceGeneration } from '../../history/peek'
import { modals, showModal } from '../../modals'
import { sourceGeneration } from './source'
import { historyViewGeneration } from './state'

let opening = false

/** Opening metadata never changes the active snapshot comparison. */
export const openOperationDetails = async (
    recipe: OperationRecipe,
    time: number,
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
    focusPolicy?: { captureDialog: (dialog: HTMLDialogElement) => void; restoreFocus: () => void },
) => {
    if (opening) return
    opening = true
    const source = sourceGeneration.value
    const peekSource = peekSourceGeneration.value
    const generation = historyViewGeneration()
    const modalOwner = modals.at(-1)?.id
    const fallback = opener?.closest<HTMLElement>('[data-history-list]')
    try {
        const { default: StepDetailsModal } = await import('./StepDetailsModal.vue')
        if (
            source !== sourceGeneration.value ||
            peekSource !== peekSourceGeneration.value ||
            generation !== historyViewGeneration() ||
            modalOwner !== modals.at(-1)?.id
        )
            return
        await showModal(StepDetailsModal, {
            recipe,
            time,
            source,
            peekSource,
            generation,
            captureDialog: focusPolicy?.captureDialog,
        })
        await nextTick()
        const target = opener?.isConnected ? opener : fallback
        if (
            source === sourceGeneration.value &&
            peekSource === peekSourceGeneration.value &&
            generation === historyViewGeneration() &&
            modalOwner === modals.at(-1)?.id
        ) {
            if (focusPolicy) focusPolicy.restoreFocus()
            else if (target?.isConnected && target.getClientRects().length)
                target.focus({ preventScroll: true })
        }
    } finally {
        opening = false
    }
}
