import { showModal } from '../../../modals'
import { fallbacks } from '../../../preview/assets/active'
import type { PreviewAssetsTab } from './tabs'

/**
 * Opens the Preview Assets dialog (Part 2, 2.6), a lazy chunk. With no tab it opens on the
 * first type that fell back, otherwise on Skin.
 */
export const showPreviewAssets = async (tab?: PreviewAssetsTab) => {
    const { default: PreviewAssetsModal } = await import('./PreviewAssetsModal.vue')
    void showModal(
        PreviewAssetsModal,
        { tab: tab ?? fallbacks.value[0]?.type ?? 'skin' },
        { size: 'large' },
    )
}
