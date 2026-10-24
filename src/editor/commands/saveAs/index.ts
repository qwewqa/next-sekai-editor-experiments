import type { Command } from '..'
import { i18n } from '../../../i18n'
import SaveAsIcon from './SaveAsIcon.vue'

// Save As… (no default key): the Save dialog, then a new file with a new `docId`.

export const saveAs: Command = {
    readOnly: true,
    title: () => i18n.value.commands.saveAs.title,
    icon: {
        is: SaveAsIcon,
    },

    async execute() {
        const { saveAs: run } = await import('../../save/flow')
        await run()
    },
}
