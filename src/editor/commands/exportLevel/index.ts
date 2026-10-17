import type { Command } from '..'
import { isPeeking } from '../../../history'
import { filename } from '../../../history/live'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import { platform } from '../../../platform'
import ExportIcon from './ExportIcon.vue'
import ExportModal from './ExportModal.vue'
import { validName } from './fileName'
import { exportMemory } from './memory'

export const exportLevel: Command = {
    // Exports the live session while peeking, as Save does.
    readOnly: true,
    title: () => i18n.value.commands.exportLevel.title,
    icon: {
        is: ExportIcon,
    },

    execute() {
        const { exportName, sourceName } = exportMemory
        const target = platform.capabilities.writeBack ? exportMemory.target : undefined
        // The name used last; else the source file's own name; else the displayed name, made valid.
        const fromSource = exportName === undefined && sourceName !== undefined
        const name = exportName ?? sourceName ?? validName(filename.value ?? '')
        void showModal(ExportModal, {
            target,
            name,
            sourceName: fromSource,
            peeking: isPeeking.value,
        })
    },
}
