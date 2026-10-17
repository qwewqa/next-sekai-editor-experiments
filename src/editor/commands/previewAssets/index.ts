import type { Command } from '..'
import { i18n } from '../../../i18n'
import PreviewAssetsIcon from './PreviewAssetsIcon.vue'
import { showPreviewAssets } from './modal'

export const previewAssets: Command = {
    // A device setting: allowed while peeking, which it does not change.
    readOnly: true,
    title: () => i18n.value.commands.previewAssets.title,
    icon: {
        is: PreviewAssetsIcon,
    },

    execute() {
        return showPreviewAssets()
    },
}
