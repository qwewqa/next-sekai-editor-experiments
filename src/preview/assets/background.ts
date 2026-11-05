import type { LoadedBackground } from './types'

/** A synthetic background around one image URL, covering, at the image's own aspect ratio. */
export const syntheticBackground = async (
    url: string,
    signal?: AbortSignal,
): Promise<LoadedBackground> => {
    const texture = await decodeBackground(await (await fetch(url, { signal })).blob())
    return {
        texture,
        aspectRatio: texture.width / texture.height,
        fit: 'cover',
        color: 'transparent',
        blur: 0,
        mask: undefined,
    }
}

export const decodeBackground = (blob: Blob) =>
    createImageBitmap(blob, { premultiplyAlpha: 'premultiply' })
