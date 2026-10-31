import { readImageSize } from './image'
import { LIMITS } from './limits'

// The pictures of a list's first rows: small PNG or JPEG images, checked by their headers before
// anything decodes them. Shared by the chooser and Open's package list.

/** How many rows of a list get a picture; the rest show their glyph. */
export const PICTURED_ROWS = 50

export type PictureSource = {
    key: string
    /** The picture's bytes, read within the thumbnail cap; undefined when there is none. */
    read: () => Promise<Uint8Array | undefined>
}

/**
 * Loads the first rows' pictures one at a time, handing each object URL to `loaded` while
 * `isCurrent` holds. The caller revokes them. A picture that cannot be read is no picture.
 */
export const loadThumbnails = async (
    sources: readonly PictureSource[],
    isCurrent: () => boolean,
    loaded: (key: string, url: string) => void,
) => {
    for (const { key, read } of sources.slice(0, PICTURED_ROWS)) {
        if (!isCurrent()) return
        try {
            const bytes = await read()
            const size = bytes && readImageSize(bytes)
            if (!bytes || !size || !isCurrent()) continue
            if (size.width > LIMITS.thumbnailSide || size.height > LIMITS.thumbnailSide) continue
            const type = size.format === 'jpeg' ? 'image/jpeg' : 'image/png'
            loaded(key, URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type })))
        } catch {
            // Nothing to show; Use or Open reports real problems.
        }
    }
}
