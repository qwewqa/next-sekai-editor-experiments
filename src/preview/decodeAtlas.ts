import { readImageSize } from './assets/files/image'
import { maxTextureSide } from './assets/files/textureLimit'

const options = { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' } as const

/**
 * The size to decode an atlas at on a device whose textures are at most `limit` wide: halved until
 * both sides fit, so each texel of the result averages a square block of the original and the
 * Built-in atlases' 2 px gutters still keep neighbouring sprites out.
 */
export const decodeSize = (width: number, height: number, limit: number) => {
    let factor = 1
    while (width / factor > limit || height / factor > limit) factor *= 2
    return {
        width: Math.max(1, Math.floor(width / factor)),
        height: Math.max(1, Math.floor(height / factor)),
    }
}

/**
 * Decodes a skin or particle atlas for the GPU, scaled down to the device's texture limit when it
 * is larger. Sprite coordinates are fractions of the atlas, so they hold at any size.
 */
export const decodeAtlas = async (bytes: Uint8Array, limit = maxTextureSide()) => {
    const blob = new Blob([new Uint8Array(bytes)])
    const size = readImageSize(bytes)
    const target = size && decodeSize(size.width, size.height, limit)
    if (!size || !target || (target.width === size.width && target.height === size.height))
        return createImageBitmap(blob, options)
    // A 2x2 average at 2:1, with no wider filter that would reach past the gutters.
    const bitmap = await createImageBitmap(blob, {
        ...options,
        resizeWidth: target.width,
        resizeHeight: target.height,
        resizeQuality: 'medium',
    })
    if (bitmap.width === target.width && bitmap.height === target.height) return bitmap
    // A browser that ignores the resize options: scale it on a canvas instead.
    if (typeof OffscreenCanvas === 'undefined') return bitmap
    try {
        const canvas = new OffscreenCanvas(target.width, target.height)
        const context = canvas.getContext('2d')
        if (!context) return bitmap
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'medium'
        context.drawImage(bitmap, 0, 0, target.width, target.height)
        const scaled = await createImageBitmap(canvas, options)
        bitmap.close()
        return scaled
    } catch {
        return bitmap
    }
}
