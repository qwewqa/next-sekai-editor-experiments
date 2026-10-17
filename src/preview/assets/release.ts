import type { AssetType, Loaded } from './types'

/** Releases what a replaced asset holds: the GPU-bound bitmap, the object URL. */
export const release = (type: AssetType, value: Loaded[AssetType] | undefined) => {
    if (!value) return
    if (type === 'skin' || type === 'particle') (value as Loaded['skin']).texture.close()
    else if (type === 'background') (value as Loaded['background']).dispose?.()
}
