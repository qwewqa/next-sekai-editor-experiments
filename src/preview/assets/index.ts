import defaults, { firstPaintBackgroundUrl } from '#asset-defaults'
import { settings } from '../../settings'
import { builtinProviders } from './builtin'
import { assetTypes } from './choice'
import { createAssetLoader } from './loader'
import { isAssetSafeMode } from './safeMode'
import { createAssetSession } from './session'
import type { AssetChoice, AssetType } from './types'

export type * from './types'
export { AssetError, sfxSlots } from './types'

/** The composition root: the only importer of #asset-defaults. */
export const assets = createAssetLoader({ defaults, builtin: builtinProviders })

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
