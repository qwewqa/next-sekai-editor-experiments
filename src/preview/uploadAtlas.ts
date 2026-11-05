import type { PreviewSurface, TextureSlot } from './gl'

/**
 * Uploads an atlas to the preview's renderer, and throws when the upload fails. Each host recovers
 * from the throw: the main thread shows the graphics error, and a worker hands over.
 */
export const uploadAtlas = (
    renderer: PreviewSurface,
    slot: TextureSlot,
    bitmap: ImageBitmap,
    interpolation: boolean,
) => {
    const error = renderer.setTexture(slot, bitmap, interpolation)
    if (error) throw new Error(`Preview texture upload failed with GL error ${error}`)
}
