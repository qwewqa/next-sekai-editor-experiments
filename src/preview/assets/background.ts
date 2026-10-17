import type { LoadedBackground } from './types'

/** A synthetic background around one image URL. */
export const syntheticBackground = (url: string, aspectRatio: number): LoadedBackground => ({
    url,
    aspectRatio,
    fit: 'cover',
    color: 'transparent',
    blur: 0,
    mask: undefined,
})
