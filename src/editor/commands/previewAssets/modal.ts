import { showModal } from '../../../modals'
import { fallbacks } from '../../../preview/assets/active'
import type { PreviewAssetsTab } from './tabs'

let isOpen = false

/**
 * Opens the Preview Assets dialog (Part 2, 2.6), a lazy chunk. With no tab it opens on the
 * first type that fell back, otherwise on Skin. With a package already picked (Open File…) it
 * opens on the first type the package holds, with that tab's chooser listing the package's items.
 */
export const showPreviewAssets = async (tab?: PreviewAssetsTab, options?: { file?: File }) => {
    // A second press while the chunk loads or the dialog is up opens nothing more.
    if (isOpen) return
    isOpen = true
    try {
        const { default: PreviewAssetsModal } = await import('./PreviewAssetsModal.vue')
        const file = options?.file
        // The package reader stays out of the main bundle until a package is picked.
        const held = file
            ? await import('../../../preview/assets/files/inspect').then(({ firstTypeIn }) =>
                  firstTypeIn(file),
              )
            : undefined
        void showModal(
            PreviewAssetsModal,
            {
                tab: held?.type ?? tab ?? fallbacks.value[0]?.type ?? 'skin',
                file,
                source: held?.source,
            },
            { size: 'large' },
        ).finally(() => (isOpen = false))
    } catch (error) {
        isOpen = false
        throw error
    }
}
