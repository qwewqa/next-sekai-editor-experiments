import { inflate } from 'pako'

const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** A small independent PNG decoder for the tests: 8-bit RGB or RGBA, as { width, height, channels, data }. */
export function decode(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let width = 0
    let height = 0
    let colorType = 0
    const idat = []
    for (let at = 8; at < bytes.length;) {
        const length = view.getUint32(at)
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
        if (type === 'IHDR') {
            width = view.getUint32(at + 8)
            height = view.getUint32(at + 12)
            colorType = bytes[at + 17]
        }
        if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length))
        at += 12 + length
    }
    const channels = colorType === 6 ? 4 : 3
    const raw = inflate(Buffer.concat(idat))
    const stride = width * channels
    const data = new Uint8Array(stride * height)
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? data[y * stride + x - channels] : 0
            const b = y > 0 ? data[(y - 1) * stride + x] : 0
            const c = x >= channels && y > 0 ? data[(y - 1) * stride + x - channels] : 0
            const add = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]
            data[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + add) & 255
        }
    }
    return { width, height, channels, colorType, data }
}

/** The pixel at (x, y) as [r, g, b, a], with alpha 255 for RGB images. */
export const pixelAt = ({ width, channels, data }, x, y) => {
    const at = (y * width + x) * channels
    return [data[at], data[at + 1], data[at + 2], channels === 4 ? data[at + 3] : 255]
}
