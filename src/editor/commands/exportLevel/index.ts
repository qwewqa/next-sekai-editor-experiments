import type { Command } from '..'
import { isPeeking } from '../../../history'
import { filename } from '../../../history/live'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import { platform } from '../../../platform'
import type { ReadResult } from '../../save/pickSession'
import ExportIcon from './ExportIcon.vue'
import ExportModal from './ExportModal.vue'
import { validName } from './fileName'
import { copyName, exportMemory, loadExportTarget } from './memory'

// One Export dialog at a time, from the key press to its close: a second press while the target
// is being read would open a second dialog over the first, with its own read flags.
let opening = false

/** Opens the Export dialog; the remembered target's handle is read here, never at startup (D24). */
const openExport = async () => {
    if (opening) return
    opening = true
    try {
        await openExportDialog()
    } finally {
        opening = false
    }
}

const openExportDialog = async () => {
    const target = platform.capabilities.writeBack ? await loadExportTarget() : undefined
    const { exportName, sourceName } = exportMemory
    // The name used last; else the source file's own name; else the displayed name, made
    // valid, as "<name> (2)" for a partial import so the picker never suggests the original.
    const fromSource = exportName === undefined && sourceName !== undefined
    const name = exportName ?? sourceName ?? copyName(validName(filename.value ?? ''))
    // The chain's own file is read first when a pick of it could lose what it holds (R2).
    const read: Promise<ReadResult> = import('../../save/exportPick').then(
        (pick) => pick.startExportRead(),
        () => ({ kind: 'noAccess' }) as const,
    )
    await showModal(ExportModal, {
        target,
        name,
        sourceName: fromSource,
        peeking: isPeeking.value,
        read,
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
