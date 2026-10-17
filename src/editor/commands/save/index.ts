import { gzip } from 'pako'
import type { Command } from '..'
import { levelDataHandle, setLevelDataHandle } from '../../../history'
import {
    bgm,
    filename,
    groupFolders,
    groups,
    initialLife,
    isDynamicStages,
    stageFolders,
    stages,
    store,
} from '../../../history/live'
import { i18n } from '../../../i18n'
import { serializeToLevelData } from '../../../levelData/serialize'
import { showModal } from '../../../modals'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { platform } from '../../../platform'
import { timeout } from '../../../utils/promise'
import { notify } from '../../notification'
import SaveIcon from './SaveIcon.vue'

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
                    build: () => {
                        const levelData = serializeToLevelData(
                            initialLife.value,
                            isDynamicStages.value,
                            bgm.value.offset,
                            store.value,
                            groups.value,
                            stages.value,
                            { groups: groupFolders.value, stages: stageFolders.value },
                        )

                        const file = gzip(JSON.stringify(levelData), {
                            level: 9,
                        })
                        return Promise.resolve(
                            new Blob([file], {
                                type: 'application/octet-stream',
                            }),
                        )
                    },
                })
                if (result.status === 'cancelled') return

                // A download replaces the handle: the next save asks again.
                setLevelDataHandle(
                    result.status === 'saved' && result.target.kind === 'handle'
                        ? result.target.handle
                        : undefined,
                )

                notify(() => i18n.value.commands.save.saved)
            },
        })
    },
}
