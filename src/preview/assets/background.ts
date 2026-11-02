import type { LoadedBackground } from './types'

/** A synthetic background around one image URL. */
export const syntheticBackground = async (
    url: string,
    aspectRatio: number,
    signal?: AbortSignal,
): Promise<LoadedBackground> => ({
    texture: await decodeBackground(await (await fetch(url, { signal })).blob()),
    aspectRatio,
    fit: 'cover',
    color: 'transparent',
    blur: 0,
    mask: undefined,
})

export const decodeBackground = (blob: Blob) =>
    createImageBitmap(blob, { premultiplyAlpha: 'premultiply' })
