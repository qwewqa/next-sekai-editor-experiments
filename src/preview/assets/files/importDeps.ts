import { applyAssetChoices } from '..'
import { decodeToCheck } from './audio'
import { decodeImageToCheck } from './decodeImage'
import type { ImportDeps } from './importStore'
import { importMessage } from './importText'
import { refreshStored, workerStore } from './store'
import { maxTextureSide } from './textureLimit'

/** What the page's imports use: the storage worker's store, the device's decoders and limits. */
export const pageImportDeps = () =>
    ({
        store: workerStore,
        maxTextureSide,
        decodeAudio: decodeToCheck,
        decodeImage: decodeImageToCheck,
        describe: importMessage,
        apply: applyAssetChoices,
        onStorageChanged: () => void refreshStored(),
    }) satisfies ImportDeps & Record<string, unknown>
