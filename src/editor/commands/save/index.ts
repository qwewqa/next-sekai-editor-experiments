import type { Command } from '..'
import { levelDataHandle, setLevelDataHandle } from '../../../history'
import { filename } from '../../../history/live'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import { showChoice } from '../../../modals/choice'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { platform, type ReadyPrompt } from '../../../platform'
import { interpolate } from '../../../utils/interpolate'
import { timeout } from '../../../utils/promise'
import { notify } from '../../notification'
import { buildLevelData } from '../exportLevel/build'
import { formatSize } from '../exportLevel/format'
import { exportMemory, sameEntry } from '../exportLevel/memory'
import SaveIcon from './SaveIcon.vue'

// A download that outlasted the gesture asks for a tap first (§1.5.6).
const ready: ReadyPrompt = async (file) =>
    (await showChoice({
        title: () => i18n.value.commands.save.title,
        message: interpolate(() => i18n.value.save.preparing, file.name, formatSize(file.size)),
        choices: [{ value: true, label: () => i18n.value.save.download, default: true }],
    })) === true

export const save: Command = {
    readOnly: true,
    title: () => i18n.value.commands.save.title,
    icon: {
        is: SaveIcon,
    },

    execute() {
        void showModal(LoadingModal, {
            title: () => i18n.value.commands.save.title,
            async *task(signal: AbortSignal) {
                yield () => i18n.value.commands.save.exporting
                await timeout(50)
                signal.throwIfAborted()

                const name = filename.value ?? 'LevelData'

                const result = await platform.saveFile({
                    kind: 'nsld',
                    suggestedName: name,
                    target: levelDataHandle && { kind: 'handle', handle: levelDataHandle },
                    signal,
                    ready,
                    build: () => Promise.resolve(buildLevelData()),
                })
                if (result.status === 'cancelled') return

                // A download replaces the handle: the next save asks again.
                const handle =
                    result.status === 'saved' && result.target.kind === 'handle'
                        ? result.target.handle
                        : undefined
                setLevelDataHandle(handle)

                // Until Step 6: a write to the Export target is that target's state now, so
                // Shift+P after p is no conflict.
                const { target } = exportMemory
                if (
                    handle &&
                    result.status === 'saved' &&
                    result.disk &&
                    target &&
                    (await sameEntry(handle, target.handle))
                )
                    target.disk = result.disk

                notify(() => i18n.value.commands.save.saved)
            },
        })
    },
}
