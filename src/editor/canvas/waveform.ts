import type { WebGLDrawContext } from '../../rendering/context'
import type { Range } from '../../utils/range'
import { waveformDuration, type Waveform } from '../../waveform'
import {
    createWaveformTileImage,
    getWaveformTilePixels,
    reduceWaveformTilePixels,
    type WaveformTilePixels,
} from '../../waveform/tiles'
import type { EditorDrawContext } from './types'

const MAX_TILE_BYTES = 16 * 1024 * 1024
const MAX_TILES = 32

type Reduction = {
    pixels: WaveformTilePixels
    image?: ImageData
}

type Tile = {
    image?: HTMLImageElement
    pixels?: WaveformTilePixels
    raster?: ImageData
    reductions: Reduction[]
    bytes: number
}

// URL-only waveforms can still come from callers outside the BGM importer.
// Decode their alpha once on a temporary GPU surface; subsequent zoom levels
// use the same CPU reductions as imported audio, with no further readbacks.
const readTilePixels = (ctx: WebGLDrawContext, image: HTMLImageElement): WaveformTilePixels => {
    const width = image.naturalWidth
    const height = image.naturalHeight
    const surface = ctx.createSurface(width, height)
    try {
        const target = surface.getContext()
        target.drawImage(image, 0, 0)
        const source = target.getImageData(0, 0, width, height).data
        const alpha = new Uint8Array(width * height)
        for (let i = 0; i < alpha.length; i++) alpha[i] = source[i * 4 + 3] ?? 0
        return { width, height, alpha }
    } finally {
        surface.dispose()
    }
}

export const createWaveformRenderer = (invalidate: () => void) => {
    let source: Waveform | undefined
    const images = new Map<string, Tile>()
    const visible = new Set<string>()
    const contexts = new Set<WebGLDrawContext>()
    let bytes = 0

    const release = (entry: Tile) => {
        if (entry.image) entry.image.onload = null
        for (const ctx of contexts) {
            if (entry.image) ctx.releaseImage(entry.image)
            if (entry.raster) ctx.releaseImage(entry.raster)
            for (const reduction of entry.reductions) {
                if (reduction.image) ctx.releaseImage(reduction.image)
            }
        }
    }

    const prune = () => {
        for (const [href, entry] of images) {
            if (bytes <= MAX_TILE_BYTES && images.size <= MAX_TILES) break
            // Never evict part of the current frame's working set: doing so can
            // trigger a decode/redraw loop when many tiles are visible together.
            if (visible.has(href)) continue
            release(entry)
            images.delete(href)
            bytes -= entry.bytes
        }
    }

    const clear = () => {
        for (const entry of images.values()) release(entry)
        images.clear()
        visible.clear()
        contexts.clear()
        bytes = 0
        source = undefined
    }

    const addBytes = (entry: Tile, count: number) => {
        entry.bytes += count
        bytes += count
    }

    return {
        clear,
        draw(
            { ctx, ups }: EditorDrawContext,
            waveform: Waveform | undefined,
            offset: number,
            times: Range<number>,
        ) {
            if (source !== waveform) {
                clear()
                source = waveform
            }
            visible.clear()
            if (!waveform) return
            contexts.add(ctx)

            const min = Math.max(0, Math.floor((times.min + offset) / waveformDuration))
            const max = Math.min(
                waveform.images.length - 1,
                Math.floor((times.max + offset) / waveformDuration),
            )
            for (let index = min; index <= max; index++) {
                const href = waveform.images[index]
                if (href) visible.add(href)
            }
            // Use the actual backing-pixel transform, whose native precision is
            // preserved by the context. Rounding here would change which peak
            // reduction is chosen at exact zoom boundaries in some browsers.
            const tilePixels = waveformDuration * Math.abs(ups * ctx.getTransform().d)
            ctx.save()
            ctx.globalAlpha = 0.25
            ctx.translate(0, offset * -ups)
            ctx.scale(4, waveformDuration * -ups)
            for (let index = min; index <= max; index++) {
                const href = waveform.images[index]
                if (!href) continue
                let entry = images.get(href)
                if (!entry) {
                    const pixels = getWaveformTilePixels(href)
                    const created: Tile = { pixels, reductions: [], bytes: 0 }
                    entry = created
                    images.set(href, entry)
                    if (!pixels) {
                        const image = (created.image = new Image())
                        image.onload = () => {
                            if (images.get(href) !== created) return
                            addBytes(created, image.naturalWidth * image.naturalHeight * 4)
                            // Retained tiles can finish loading after a scroll. Only
                            // the latest visible range needs another chart draw.
                            if (visible.has(href)) invalidate()
                            prune()
                        }
                        image.src = href
                    }
                }
                // Keep recently used tiles within both decoded-pixel and count
                // limits; pending images have no known decoded dimensions yet.
                images.delete(href)
                images.set(href, entry)
                const { image } = entry
                if (image && (!image.complete || !image.naturalWidth)) continue
                let height = entry.pixels?.height ?? image?.naturalHeight ?? 0
                let reduction: Reduction | undefined
                if (waveform.style.imageRendering === 'pixelated') {
                    if (height > Math.max(1, tilePixels) && !entry.pixels && image) {
                        entry.pixels = readTilePixels(ctx, image)
                        addBytes(entry, entry.pixels.alpha.byteLength)
                    }
                    let pixels = entry.pixels
                    for (let level = 0; pixels && height > Math.max(1, tilePixels); level++) {
                        reduction = entry.reductions[level]
                        if (!reduction) {
                            reduction = { pixels: reduceWaveformTilePixels(pixels) }
                            entry.reductions.push(reduction)
                            addBytes(entry, reduction.pixels.alpha.byteLength)
                        }
                        pixels = reduction.pixels
                        height = pixels.height
                    }
                    ctx.imageSmoothingEnabled = false
                } else {
                    ctx.imageSmoothingEnabled = true
                }
                let rendered: HTMLImageElement | ImageData | undefined
                if (reduction) {
                    if (!reduction.image) {
                        reduction.image = createWaveformTileImage(reduction.pixels)
                        addBytes(entry, reduction.image.data.byteLength)
                    }
                    rendered = reduction.image
                } else if (image) {
                    rendered = image
                } else if (entry.pixels) {
                    if (!entry.raster) {
                        entry.raster = createWaveformTileImage(entry.pixels)
                        addBytes(entry, entry.raster.data.byteLength)
                    }
                    rendered = entry.raster
                }
                if (!rendered) continue
                const drawMethod =
                    waveform.style.imageRendering === 'pixelated' ? 'drawWaveform' : 'drawImage'
                ctx[drawMethod](rendered, 0, -index - 1, 1, 1)
                ctx.save()
                ctx.scale(-1, 1)
                ctx[drawMethod](rendered, 0, -index - 1, 1, 1)
                ctx.restore()
            }
            ctx.restore()
            prune()
        },
    }
}
