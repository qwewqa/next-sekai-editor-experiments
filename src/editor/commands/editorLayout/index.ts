import type { Command } from '..'
import { isDynamicStages } from '../../../history/dynamicStages.ts'
import { i18n } from '../../../i18n'
import { notify } from '../../notification'
import { view } from '../../view'
import EditorLayoutIcon from './EditorLayoutIcon.vue'

export const editorLayout: Command = {
    title: () => i18n.value.commands.editorLayout.title,
    icon: { is: EditorLayoutIcon },

    readOnly: true,

    execute() {
        // Without dynamic stages both layouts are the same.
        if (!isDynamicStages.value) {
            notify(() => i18n.value.workspace.stages.disabled)
            return
        }
        view.layout = view.layout === 'basic' ? 'composed' : 'basic'
        const layout = view.layout
        notify(() => i18n.value.commands.editorLayout[layout])
    },
}
