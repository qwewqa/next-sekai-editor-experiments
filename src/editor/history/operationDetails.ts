import { nextTick } from 'vue'
import type { OperationRecipe } from '../../history/operationPresentation'
import { peekSourceGeneration } from '../../history/peek'
import { modals, showModal } from '../../modals'
import { historyViewGeneration } from './state'
import { sourceGeneration } from './source'

let opening = false

/** Opening metadata never changes the active snapshot comparison. */
export const openOperationDetails = async (
    recipe: OperationRecipe,
    time: number,
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
    restoreFocus?: () => void,
) => {
    if (opening) return
    opening = true
    const source = sourceGeneration.value
    const peekSource = peekSourceGeneration.value
    const generation = historyViewGeneration()
    const fallback = opener?.closest<HTMLElement>('[data-history-list]')
    try {
        const { default: StepDetailsModal } = await import('./StepDetailsModal.vue')
        if (source !== sourceGeneration.value || peekSource !== peekSourceGeneration.value || generation !== historyViewGeneration()) return
        await showModal(StepDetailsModal, { recipe, time, source, peekSource, generation })
        await nextTick()
        const target = opener?.isConnected ? opener : fallback
        if (
            source === sourceGeneration.value &&
            peekSource === peekSourceGeneration.value &&
            generation === historyViewGeneration() &&
            !modals.some((modal) => modal.presentation !== 'tool')
        ) {
            if (restoreFocus) restoreFocus()
            else if (target?.isConnected && target.getClientRects().length)
                target.focus({ preventScroll: true })
        }
    } finally {
        opening = false
    }
}
