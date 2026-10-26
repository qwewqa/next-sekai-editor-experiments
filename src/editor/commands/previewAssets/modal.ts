import { showModal } from '../../../modals'
import { fallbacks } from '../../../preview/assets/active'
import { loadForAction } from '../../loadFailure'
import type { PreviewAssetsTab } from './tabs'

let isOpen = false

/**
 * Opens the Preview Assets dialog, a lazy chunk. With no tab it opens on the
 * first type that fell back, otherwise on Skin. With a package already picked (Open File…) it
 * opens on the first type the package holds, with that tab's chooser listing the package's items.
 */
export const showPreviewAssets = async (tab?: PreviewAssetsTab, options?: { file?: File }) => {
    // A second press while the chunk loads or the dialog is up opens nothing more.
    if (isOpen) return
    isOpen = true
    try {
        const modal = await loadForAction(() => import('./PreviewAssetsModal.vue'))
        const file = options?.file
        // The package reader stays out of the main bundle until a package is picked.
        const inspect = file
            ? await loadForAction(() => import('../../../preview/assets/files/inspect'))
            : undefined
        if (!modal || (file && !inspect)) {
            isOpen = false
            return
        }
        const PreviewAssetsModal = modal.default
        const held = file && inspect ? await inspect.firstTypeIn(file) : undefined
        void showModal(
            PreviewAssetsModal,
            {
                tab: held?.type ?? tab ?? fallbacks.value[0]?.type ?? 'skin',
                file,
                source: held?.source,
            },
            { size: 'large', cap: '34rem' },
        ).finally(() => (isOpen = false))
    } catch (error) {
        isOpen = false
        throw error
    }
}
