import type { Command } from '..'
import { i18n } from '../../../i18n'
import { loadForAction } from '../../loadFailure'
import SaveAsIcon from './SaveAsIcon.vue'

// Save As… (no default key): the Save dialog, then a new file with a new `docId`.

export const saveAs: Command = {
    readOnly: true,
    title: () => i18n.value.commands.saveAs.title,
    icon: {
        is: SaveAsIcon,
    },

    async execute() {
        const flow = await loadForAction(() => import('../../save/flow'))
        if (flow) await flow.saveAs()
    },
}
