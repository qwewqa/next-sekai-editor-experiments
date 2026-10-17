import defaults, { firstPaintBackgroundUrl } from '#asset-defaults'
import { createAssetLoader } from './loader'

export type * from './types'
export { AssetError, sfxSlots } from './types'

/** The composition root: the only importer of #asset-defaults. */
export const assets = createAssetLoader({ defaults })

export { firstPaintBackgroundUrl }
