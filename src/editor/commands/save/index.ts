import type { Command } from '..'
import { levelDataHandle, setLevelDataHandle } from '../../../history'
import { filename } from '../../../history/live'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import { showChoice } from '../../../modals/choice'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { FileError, platform, type ReadyPrompt } from '../../../platform'
import { interpolate } from '../../../utils/interpolate'
import { timeout } from '../../../utils/promise'
import { notify } from '../../notification'
import { buildLevelData } from '../exportLevel/build'
import { formatSize } from '../exportLevel/format'
import { copyName, exportMemory, sameEntry } from '../exportLevel/memory'
import { downloadOpened, refusePick, type RefusedPick } from '../exportLevel/pick'
import { fileErrorText, showNotPutBack } from '../exportLevel/ui'
import SaveIcon from './SaveIcon.vue'

// A download that outlasted the gesture asks for a tap first (§1.5.6).
const ready: ReadyPrompt = async (file) =>
    (await showChoice({
        title: () => i18n.value.commands.save.title,
        message: interpolate(() => i18n.value.save.preparing, file.name, formatSize(file.size)),
        choices: [{ value: true, label: () => i18n.value.save.download, default: true }],
    })) === true

const title = () => i18n.value.commands.save.title

/** A refused pick, shown as Save's failure, or with Download when the file was left empty. */
const refusal = async (refused: RefusedPick) => {
    const { name } = refused
    if (refused.restored)
        throw new Error(
            interpolate(
                () =>
                    refused.reason === 'notLevelData'
                        ? i18n.value.export.notLevelData
                        : i18n.value.export.unsupportedParts,
                name,
            )(),
        )
    if ((await showNotPutBack(title, name)) !== 'download') return
    const result = await downloadOpened(refused)
    if (result.status === 'download-started')
        notify(
            interpolate(
                () => i18n.value.save.downloadStarted,
                result.name,
                formatSize(refused.bytes.byteLength),
            ),
        )
}

export const save: Command = {
    readOnly: true,
    title,
    icon: {
        is: SaveIcon,
    },

    execute() {
        void showModal(LoadingModal, {
            title,
            async *task(signal: AbortSignal) {
                yield () => i18n.value.commands.save.exporting
                await timeout(50)
                signal.throwIfAborted()

                // A partial import's picker suggests "<name> (2)", never the original (§1.4.7).
                const name = copyName(filename.value ?? 'LevelData')

                let refused: RefusedPick | undefined
                let result
                try {
                    result = await platform.saveFile({
                        kind: 'nsld',
                        suggestedName: name,
                        target: levelDataHandle && { kind: 'handle', handle: levelDataHandle },
                        signal,
                        ready,
                        build: () => Promise.resolve(buildLevelData()),
                        picked: async (target) => {
                            refused = await refusePick(target)
                            return !refused
                        },
                    })
                } catch (error) {
                    if (!(error instanceof FileError)) throw error
                    throw new Error(fileErrorText(name, error), { cause: error })
                }
                if (refused) await refusal(refused)
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
