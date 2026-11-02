import type { AssetType, Loaded } from './types'

/** Releases what a replaced asset holds: its GPU-bound bitmap. */
export const release = (type: AssetType, value: Loaded[AssetType] | undefined) => {
    if (!value) return
    if (type === 'skin' || type === 'particle') (value as Loaded['skin']).texture.close()
    else if (type === 'background') (value as Loaded['background']).texture.close()
}
