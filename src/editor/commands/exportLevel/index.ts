import type { Command } from '..'
import { isPeeking } from '../../../history'
import { filename } from '../../../history/live'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import { platform } from '../../../platform'
import ExportIcon from './ExportIcon.vue'
import ExportModal from './ExportModal.vue'
import { validName } from './fileName'
import { copyName, exportMemory, loadExportTarget } from './memory'

/** Opens the Export dialog; the remembered target's handle is read here, never at startup (D24). */
const openExport = async () => {
    const target = platform.capabilities.writeBack ? await loadExportTarget() : undefined
    const { exportName, sourceName } = exportMemory
    // The name used last; else the source file's own name; else the displayed name, made
    // valid, as "<name> (2)" for a partial import so the picker never suggests the original.
    const fromSource = exportName === undefined && sourceName !== undefined
    const name = exportName ?? sourceName ?? copyName(validName(filename.value ?? ''))
    await showModal(ExportModal, {
        target,
        name,
        sourceName: fromSource,
        peeking: isPeeking.value,
    })
}

export const exportLevel: Command = {
    // Exports the live session while peeking, as Save does.
    readOnly: true,
    title: () => i18n.value.commands.exportLevel.title,
    icon: {
        is: ExportIcon,
    },

    execute() {
        void openExport()
    },
}
