import defaults, { firstPaintBackgroundUrl } from '#asset-defaults'
import { settings } from '../../settings'
import { builtinProviders } from './builtin'
import { assetTypes, choiceKey } from './choice'
import { lazyStoredProviders } from './files/lazy'
import { createAssetLoader } from './loader'
import { isAssetSafeMode } from './safeMode'
import { createAssetSession } from './session'
import type { AssetChoice, AssetType } from './types'

export type * from './types'
export { AssetError, sfxSlots } from './types'

/** The composition root: the only importer of #asset-defaults. */
export const assets = createAssetLoader({
    defaults,
    builtin: builtinProviders,
    providers: lazyStoredProviders(),
})

export { firstPaintBackgroundUrl }

const defaultChoices = Object.fromEntries(
    assetTypes.map((type) => [type, { source: 'default' }]),
) as Record<AssetType, AssetChoice>

type AudioDecoder = (data: ArrayBuffer) => Promise<AudioBuffer>
let decodeAudio: AudioDecoder = () => Promise.reject(new Error('No audio context to decode with'))

/** The player's audio context decodes the sound effects. */
export const setAudioDecoder = (decode: AudioDecoder) => {
    decodeAudio = decode
}

const safeMode = isAssetSafeMode()

/** What the preview shows of each type; a choice change reloads that type in place. */
export const assetSession = createAssetSession({
    loader: assets,
    choices: () => (safeMode ? defaultChoices : settings.previewAssets),
    decodeAudio: (data) => decodeAudio(data),
})

/** Whether the choices are being ignored (the dialog says so in place of a reason). */
export const isAssetSafeModeActive = safeMode

/**
 * Stores the choices an import made. Importing a package again keeps its key. The session's
 * watcher reacts only to a changed key, so a type whose key is unchanged loads again here.
 */
export const applyAssetChoices = (choices: Partial<Record<AssetType, AssetChoice>>) => {
    const before = settings.previewAssets
    settings.previewAssets = { ...before, ...choices }
    for (const type of assetTypes) {
        const choice = choices[type]
        if (choice && choiceKey(choice) === choiceKey(before[type])) assetSession.reload(type)
    }
}
