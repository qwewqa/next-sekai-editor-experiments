import { showModal } from '../../../modals'
import { fallbacks } from '../../../preview/assets/active'
import { loadForAction } from '../../loadFailure'
import type { PreviewAssetsTab } from './tabs'

let isOpen = false

/**
 * Opens the Preview Assets dialog, a lazy chunk. With no tab it opens on the
 * first type that fell back, otherwise on Skin.
 */
export const showPreviewAssets = async (tab?: PreviewAssetsTab) => {
    // A second press while the chunk loads or the dialog is up opens nothing more.
    if (isOpen) return
    isOpen = true
    try {
        const modal = await loadForAction(() => import('./PreviewAssetsModal.vue'))
        if (!modal) {
            isOpen = false
            return
        }
        const PreviewAssetsModal = modal.default
        void showModal(
            PreviewAssetsModal,
            { tab: tab ?? fallbacks.value[0]?.type ?? 'skin' },
            { size: 'large', cap: '34rem' },
        ).finally(() => (isOpen = false))
    } catch (error) {
        isOpen = false
        throw error
    }
}
