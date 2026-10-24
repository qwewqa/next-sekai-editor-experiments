// Shelf packing with a transparent or extruded gutter, and texture composition.
import { createHash } from 'node:crypto'

/** Pixels around every packed image. */
export const gutter = 2

/** The key of an image: its pixels, size and whether it stretches. */
export const imageKey = ({ width, height, data, stretch }) =>
    createHash('sha256')
        .update(`${width}x${height}${stretch ? 's' : 'n'}`)
        .update(data)
        .digest('hex')

const byShelfOrder = (a, b) => b.height - a.height || b.width - a.width || (a.key < b.key ? -1 : 1)

const shelfPack = (images, size) => {
    const placements = new Map()
    let x = 0
    let y = 0
    let rowHeight = 0
    for (const image of [...images].sort(byShelfOrder)) {
        const w = image.width + 2 * gutter
        const h = image.height + 2 * gutter
        if (w > size) return
        if (x + w > size) {
            y += rowHeight
            x = 0
            rowHeight = 0
        }
        if (y + h > size) return
        placements.set(image.key, { x: x + gutter, y: y + gutter })
        x += w
        rowHeight = Math.max(rowHeight, h)
    }
    return placements
}

/**
 * Packs the images into the smallest square power of two up to maxSize.
 * Each image is { key, width, height }; the result has the size, the placements by key and the fill ratio.
 */
export function packImages(images, maxSize, label = 'texture') {
    const area = images.reduce(
        (sum, { width, height }) => sum + (width + 2 * gutter) * (height + 2 * gutter),
        0,
    )
    for (let size = 64; size <= maxSize; size *= 2) {
        if (area > size * size) continue
        const placements = shelfPack(images, size)
        if (placements) return { size, placements, fill: area / (size * size) }
    }
    throw new Error(
        `The ${label} doesn't fit in ${maxSize}x${maxSize} (${area} pixels with gutters)`,
    )
}

/** Composes the RGBA texture: stretch images extrude their edge pixels into the gutter. */
export function composeTexture(size, images, placements) {
    const texture = new Uint8Array(size * size * 4)
    for (const image of images) {
        const { x, y } = placements.get(image.key)
        const { width, height, data } = image
        for (let row = 0; row < height; row++)
            texture.set(
                data.subarray(row * width * 4, (row + 1) * width * 4),
                ((y + row) * size + x) * 4,
            )
        if (!image.stretch) continue
        for (let gy = -gutter; gy < height + gutter; gy++)
            for (let gx = -gutter; gx < width + gutter; gx++) {
                if (gx >= 0 && gx < width && gy >= 0 && gy < height) continue
                const sx = Math.min(width - 1, Math.max(0, gx))
                const sy = Math.min(height - 1, Math.max(0, gy))
                const from = (sy * width + sx) * 4
                texture.set(data.subarray(from, from + 4), ((y + gy) * size + x + gx) * 4)
            }
    }
    return texture
}
