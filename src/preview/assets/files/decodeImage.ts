import type { ImageSize } from './image'

/**
 * Decodes an image to check its body, then lets it go (Part 2, 2.5.5): `createImageBitmap`
 * decodes off the main thread. Run only after the header's size passed its cap.
 */
export const decodeImageToCheck = async (bytes: Uint8Array, format: ImageSize['format']) => {
    const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: format === 'jpeg' ? 'image/jpeg' : 'image/png' }),
    )
    bitmap.close()
}

export type DecodeImage = typeof decodeImageToCheck
