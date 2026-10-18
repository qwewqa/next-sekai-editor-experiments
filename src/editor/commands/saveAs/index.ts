import type { Command } from '..'
import { i18n } from '../../../i18n'
import SaveIcon from '../save/SaveIcon.vue'

// Save As… (no default key; Part 1 §1.4.7): the Save dialog, then a new file with a new `docId`.

export const saveAs: Command = {
    readOnly: true,
    title: () => i18n.value.commands.saveAs.title,
    icon: {
        is: SaveIcon,
    },

    async execute() {
        const { saveAs: run } = await import('../../save/flow')
        await run()
    },
}
