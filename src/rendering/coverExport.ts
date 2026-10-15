import { Deflate } from 'pako'
import { createBlob } from '../utils/canvas'
import { timeout } from '../utils/promise'
import { ImageSampler } from './imageSampling'

type Crop = { x: number; y: number; width: number; height: number }

const decodeVectorCrop = async (
    image: HTMLImageElement,
    crop: Crop,
    size: number,
    signal: AbortSignal,
) => {
    signal.throwIfAborted()
    // Keep the original SVG in its own image document: transplanting its nodes
    // changes :root selectors, root x/y attributes, and generic svg styles.
    // The outer viewport rasterizes only the requested square, even for very
    // wide/tall vectors. Firefox's combined bitmap crop/resize is incorrect.
    const namespace = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(namespace, 'svg')
    svg.setAttribute('width', String(size))
    svg.setAttribute('height', String(size))
    svg.setAttribute('viewBox', `${crop.x} ${crop.y} ${crop.width} ${crop.height}`)
    const original = document.createElementNS(namespace, 'image')
    original.setAttribute('href', image.currentSrc || image.src)
    original.setAttribute('width', String(image.naturalWidth))
    original.setAttribute('height', String(image.naturalHeight))
    svg.appendChild(original)
    const raster = new Image()
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            raster.onload = raster.onerror = null
            signal.removeEventListener('abort', abort)
        }
        const abort = () => {
            cleanup()
            raster.src = ''
            // AbortSignal accepts arbitrary reasons; preserve the caller's cancellation.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(signal.reason)
        }
        // decode() can resolve before embedded SVG images finish loading in
        // Firefox. The load event waits for those resources; no timed delay.
        raster.onload = () => {
            cleanup()
            resolve()
        }
        raster.onerror = () => {
            cleanup()
            reject(new Error('Unable to decode the SVG cover'))
        }
        signal.addEventListener('abort', abort, { once: true })
        raster.src =
            'data:image/svg+xml,' + encodeURIComponent(new XMLSerializer().serializeToString(svg))
    })
    signal.throwIfAborted()
    return createImageBitmap(raster, { premultiplyAlpha: 'premultiply' })
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    return value >>> 0
})

const pngChunk = (type: string, data: Uint8Array) => {
    const chunk = new Uint8Array(data.length + 12)
    const view = new DataView(chunk.buffer)
    view.setUint32(0, data.length)
    for (let i = 0; i < 4; i++) chunk[i + 4] = type.charCodeAt(i)
    chunk.set(data, 8)
    let crc = 0xffffffff
    for (let i = 4; i < chunk.length - 4; i++)
        crc = (crcTable[(crc ^ (chunk[i] ?? 0)) & 255] ?? 0) ^ (crc >>> 8)
    view.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0)
    return chunk
}

// Large exports use small GPU targets and stream scanline stripes to PNG. This
// avoids imposing the device's texture limit on the requested cover dimensions.
// Readback and encoding are bounded to stripes; oversized inputs may retain a
// decoded prefilter bitmap, whose phase must remain consistent across tiles.
const createTiledCoverBlob = async (
    sampler: ImageSampler,
    source: ImageBitmap,
    crop: Crop,
    requestedSize: number,
    limit: number,
    signal: AbortSignal,
) => {
    const size = Math.floor(requestedSize)
    const oversizedSource = source.width > limit || source.height > limit
    const scaleX = crop.width / requestedSize
    const scaleY = crop.height / requestedSize
    // Padding supplies cubic taps and the aligned first mip across tile edges.
    // Extra rounding room keeps every upload within the hardware limit.
    const tileWidth = Math.min(
        size,
        limit,
        oversizedSource ? Math.max(1, Math.floor((limit - 12) / scaleX)) : limit,
    )
    const tileHeight = Math.min(
        size,
        128,
        oversizedSource ? Math.max(1, Math.floor((limit - 12) / scaleY)) : limit,
    )
    const rowBytes = size * 4 + 1
    const stripe = new Uint8Array(rowBytes * tileHeight)
    const header = new Uint8Array(13)
    const view = new DataView(header.buffer)
    view.setUint32(0, size)
    view.setUint32(4, size)
    header[8] = 8
    header[9] = 6
    const parts: BlobPart[] = [
        Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('sRGB', Uint8Array.of(0)),
    ]
    const encoder = new Deflate()
    encoder.onData = (chunk) => parts.push(pngChunk('IDAT', chunk))
    let nextYield = performance.now() + 8
    const yieldIfNeeded = async () => {
        if (performance.now() >= nextYield) {
            await timeout(0)
            nextYield = performance.now() + 8
        }
        signal.throwIfAborted()
        if (sampler.isContextLost())
            throw new Error('The WebGL context was lost while generating the cover')
    }

    for (let y = 0; y < size; y += tileHeight) {
        const height = Math.min(tileHeight, size - y)
        for (let x = 0; x < size; x += tileWidth) {
            signal.throwIfAborted()
            const width = Math.min(tileWidth, size - x)
            let bitmap: ImageBitmap | undefined
            try {
                if (oversizedSource) {
                    // Even origins keep the first mip aligned with the whole image.
                    const left = Math.max(0, Math.floor((crop.x + x * scaleX - 4) / 2) * 2)
                    const top = Math.max(0, Math.floor((crop.y + y * scaleY - 4) / 2) * 2)
                    const right = Math.min(
                        source.width,
                        Math.ceil(crop.x + (x + width) * scaleX) + 4,
                    )
                    const bottom = Math.min(
                        source.height,
                        Math.ceil(crop.y + (y + height) * scaleY) + 4,
                    )
                    bitmap = await createImageBitmap(
                        source,
                        left,
                        top,
                        right - left,
                        bottom - top,
                        {
                            // Explicit dimensions materialize Firefox's crop;
                            // otherwise its GL upload can use the uncropped backing.
                            resizeWidth: right - left,
                            resizeHeight: bottom - top,
                            // WebKit premultiplies a cropped bitmap twice. Upload
                            // straight pixels and normalize once on the GPU instead.
                            premultiplyAlpha: 'none',
                        },
                    )
                    signal.throwIfAborted()
                    sampler.setSource(
                        bitmap,
                        {
                            x: left,
                            y: top,
                            width: source.width,
                            height: source.height,
                        },
                        true,
                    )
                    sampler.render(
                        [crop.x - left, crop.y - top, crop.width, crop.height],
                        width,
                        height,
                        requestedSize,
                        requestedSize,
                        x,
                        y,
                    )
                } else {
                    sampler.render(
                        [crop.x, crop.y, crop.width, crop.height],
                        width,
                        height,
                        requestedSize,
                        requestedSize,
                        x,
                        y,
                    )
                }
                const data = sampler.readPixels(0, 0, width, height)
                for (let row = 0; row < height; row++)
                    stripe.set(
                        data.subarray(row * width * 4, (row + 1) * width * 4),
                        row * rowBytes + 1 + x * 4,
                    )
            } finally {
                if (bitmap) {
                    bitmap.close()
                }
            }
            await yieldIfNeeded()
        }
        // Small compression chunks bound cancellation latency for very wide
        // images as well as the more usual square cover sizes.
        const bytes = height * rowBytes
        for (let offset = 0; offset < bytes; offset += 65536) {
            encoder.push(stripe.subarray(offset, Math.min(bytes, offset + 65536)))
            if (encoder.err) throw new Error(encoder.msg || 'Failed to encode cover')
            await yieldIfNeeded()
        }
    }
    encoder.push(new Uint8Array(), true)
    if (encoder.err) throw new Error(encoder.msg || 'Failed to encode cover')
    signal.throwIfAborted()
    parts.push(pngChunk('IEND', new Uint8Array()))
    return new Blob(parts, { type: 'image/png' })
}

const renderCoverBlob = async (
    sampler: ImageSampler,
    image: HTMLImageElement,
    requestedSize: number,
    signal: AbortSignal,
) => {
    signal.throwIfAborted()
    const extent = Math.min(image.width, image.height)
    const crop: Crop = {
        x: image.width > image.height ? Math.floor((image.width - image.height) / 2) : 0,
        y: image.height > image.width ? Math.floor((image.height - image.width) / 2) : 0,
        width: extent,
        height: extent,
    }
    let bitmap: ImageBitmap | undefined
    try {
        const limit = sampler.maxSurfaceSize
        const size = Math.floor(requestedSize)
        const oversizedSource = image.naturalWidth > limit || image.naturalHeight > limit
        const factor = 2 ** Math.max(0, Math.floor(Math.log2(extent / requestedSize)))
        const preWidth = Math.ceil(image.naturalWidth / factor)
        const preHeight = Math.ceil(image.naturalHeight / factor)
        let preparedCrop: Crop
        if (/^data:image\/svg\+xml[;,]/i.test(image.currentSrc || image.src)) {
            // SVG is rasterized by the browser at the requested scale. Applying
            // a raster mip prefilter first would blur its vector edges and draw
            // colors from outside the crop into small exports.
            const rasterSize = Math.ceil(requestedSize)
            bitmap = await decodeVectorCrop(image, crop, rasterSize, signal)
            preparedCrop = { x: 0, y: 0, width: rasterSize, height: rasterSize }
            signal.throwIfAborted()
            if (bitmap.width <= limit && bitmap.height <= limit) sampler.setSource(bitmap)
        } else {
            // Preserve the browser's whole-image prefilter phase before cropping.
            // A source exceeding the GPU limit is decoded to that same ceil-sized
            // level, then uploaded in bounded tiles if it still exceeds the limit.
            bitmap = await createImageBitmap(image, {
                ...(oversizedSource && factor > 1
                    ? {
                          resizeWidth: preWidth,
                          resizeHeight: preHeight,
                          resizeQuality: factor === 2 ? ('low' as const) : ('medium' as const),
                      }
                    : {}),
                premultiplyAlpha: 'premultiply',
            })
            signal.throwIfAborted()
            if (!oversizedSource || (bitmap.width <= limit && bitmap.height <= limit)) {
                sampler.setSource(bitmap)
                if (!oversizedSource && factor > 1) sampler.prefilter(preWidth, preHeight)
            }
            const scaleX = preWidth / image.naturalWidth
            const scaleY = preHeight / image.naturalHeight
            preparedCrop = {
                x: crop.x * scaleX,
                y: crop.y * scaleY,
                width: crop.width * scaleX,
                height: crop.height * scaleY,
            }
        }
        if (size > limit || bitmap.width > limit || bitmap.height > limit)
            return await createTiledCoverBlob(
                sampler,
                bitmap,
                preparedCrop,
                requestedSize,
                limit,
                signal,
            )
        sampler.render(
            [preparedCrop.x, preparedCrop.y, preparedCrop.width, preparedCrop.height],
            size,
            size,
            requestedSize,
            requestedSize,
        )
        const blob = await createBlob(sampler.canvas)
        signal.throwIfAborted()
        if (sampler.isContextLost())
            throw new Error('The WebGL context was lost while generating the cover')
        return blob
    } finally {
        bitmap?.close()
    }
}

/** One cover utility session; concurrent exports never share a drawing buffer. */
export class CoverExporter {
    private idle: ImageSampler | undefined
    private readonly active = new Map<ImageSampler, AbortController>()
    private disposed = false

    async createBlob(image: HTMLImageElement, requestedSize: number, signal: AbortSignal) {
        signal.throwIfAborted()
        if (this.disposed) throw new DOMException('The cover editor was closed', 'AbortError')

        let sampler = this.idle
        this.idle = undefined
        if (sampler?.isContextLost()) {
            sampler.dispose()
            sampler = undefined
        }
        sampler ??= new ImageSampler()
        const controller = new AbortController()
        const abort = () => {
            controller.abort(signal.reason)
        }
        const dispose = () => {
            sampler.dispose()
        }
        signal.addEventListener('abort', abort, { once: true })
        controller.signal.addEventListener('abort', dispose, { once: true })
        this.active.set(sampler, controller)
        let completed = false
        try {
            const blob = await renderCoverBlob(sampler, image, requestedSize, controller.signal)
            controller.signal.throwIfAborted()
            if (sampler.isContextLost())
                throw new Error('The WebGL context was lost while generating the cover')
            completed = true
            return blob
        } finally {
            signal.removeEventListener('abort', abort)
            controller.signal.removeEventListener('abort', dispose)
            this.active.delete(sampler)
            this.releaseSampler(sampler, completed)
        }
    }

    private releaseSampler(sampler: ImageSampler, completed: boolean): void {
        if (completed && !this.disposed && !this.idle && !sampler.isContextLost()) {
            try {
                sampler.releaseSource()
                this.idle = sampler
            } catch (error) {
                sampler.dispose()
                throw error
            }
        } else {
            sampler.dispose()
        }
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        this.idle?.dispose()
        this.idle = undefined
        for (const controller of this.active.values())
            controller.abort(new DOMException('The cover editor was closed', 'AbortError'))
    }
}

/** One-shot export for callers without a cover utility lifecycle. */
export const createCoverBlob = async (
    image: HTMLImageElement,
    requestedSize: number,
    signal: AbortSignal,
) => {
    const exporter = new CoverExporter()
    try {
        return await exporter.createBlob(image, requestedSize, signal)
    } finally {
        exporter.dispose()
    }
}
