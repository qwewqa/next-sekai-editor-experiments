import { Deflate } from 'pako'
import type { WaveformTilePixels } from './tiles'

// The alpha value is its own palette index, preserving all 256 values exactly.
const palette = new Uint8Array(256 * 3).fill(255)
const transparency = Uint8Array.from({ length: 256 }, (_, value) => value)

// A real task boundary lets input and cancellation run without nested timer
// clamping. Each short-lived channel closes both ports before resuming.
const yieldEncoding = () =>
    new Promise<void>((resolve) => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
            channel.port1.close()
            channel.port2.close()
            resolve()
        }
        channel.port2.postMessage(null)
    })

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    return value >>> 0
})

const chunk = (type: string, data: Uint8Array) => {
    const result = new Uint8Array(data.length + 12)
    const view = new DataView(result.buffer)
    view.setUint32(0, data.length)
    for (let i = 0; i < 4; i++) result[i + 4] = type.charCodeAt(i)
    result.set(data, 8)
    let crc = 0xffffffff
    for (let i = 4; i < result.length - 4; i++)
        crc = (crcTable[(crc ^ (result[i] ?? 0)) & 255] ?? 0) ^ (crc >>> 8)
    view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0)
    return result
}

// Waveform PNGs contain only white and the already computed alpha samples.
// Encode those bytes directly: uploading and reading them back through a
// temporary renderer wastes work and acquires an unnecessary graphics context.
export const createWaveformTileBlob = async (
    { width, height, alpha }: WaveformTilePixels,
    checkCancelled: () => void,
) => {
    checkCancelled()
    const header = new Uint8Array(13)
    const view = new DataView(header.buffer)
    view.setUint32(0, width)
    view.setUint32(4, height)
    header[8] = 8
    header[9] = 3 // Indexed white/alpha, with no color or alpha quantization.
    const parts: BlobPart[] = [
        Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('sRGB', Uint8Array.of(0)),
        chunk('PLTE', palette),
        chunk('tRNS', transparency),
    ]
    const encoder = new Deflate({ level: 1 })
    encoder.onData = (data) => parts.push(chunk('IDAT', data))
    const rowBytes = width + 1
    const stripe = new Uint8Array(rowBytes * 32)
    let nextYield = performance.now() + 8
    for (let y = 0; y < height; y += 32) {
        checkCancelled()
        const rows = Math.min(32, height - y)
        for (let row = 0; row < rows; row++) {
            const start = row * rowBytes
            stripe[start] = 1 // PNG Sub filter, one palette index per pixel.
            let previous = 0
            for (let x = 0; x < width; x++) {
                const value = alpha[(y + row) * width + x] ?? 0
                stripe[start + 1 + x] = value - previous
                previous = value
            }
        }
        encoder.push(stripe.subarray(0, rows * rowBytes), y + rows === height)
        if (encoder.err) throw new Error(encoder.msg || 'Unable to encode the waveform')
        if (performance.now() >= nextYield || y + rows === height) {
            await yieldEncoding()
            nextYield = performance.now() + 8
        }
    }
    checkCancelled()
    parts.push(chunk('IEND', new Uint8Array()))
    return new Blob(parts, { type: 'image/png' })
}
