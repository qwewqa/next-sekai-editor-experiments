import type { Command } from '..'
import { i18n } from '../../../i18n'
import { loadForAction } from '../../loadFailure'
import SaveIcon from './SaveIcon.vue'

// Save (`p`, Ctrl/Cmd+S): writes the session's `.nxsp`, by write-back, a download,
// or the Save dialog. The flows load with the storage modules, on the first press.

const flows = () => import('../../save/flow')

export const save: Command = {
    // Saves the live session while peeking.
    readOnly: true,
    title: () => i18n.value.commands.save.title,
    icon: {
        is: SaveIcon,
    },

    async execute() {
        const flow = await loadForAction(flows)
        if (flow) await flow.save()
    },
}
