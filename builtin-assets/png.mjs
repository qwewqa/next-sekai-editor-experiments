import { crc32 } from 'node:zlib'
import { deflate, inflate } from 'pako'

const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
}

const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// One filtered row per type 0-4 (None, Sub, Up, Average, Paeth), as bytes after the type byte.
const filterRow = (type, row, previous, bpp) => {
    const out = new Uint8Array(row.length)
    for (let i = 0; i < row.length; i++) {
        const left = i >= bpp ? row[i - bpp] : 0
        const up = previous[i]
        const upLeft = i >= bpp ? previous[i - bpp] : 0
        let predicted = 0
        if (type === 1) predicted = left
        else if (type === 2) predicted = up
        else if (type === 3) predicted = (left + up) >> 1
        else if (type === 4) predicted = paeth(left, up, upLeft)
        out[i] = (row[i] - predicted) & 255
    }
    return out
}

const score = (bytes) => {
    let sum = 0
    for (const byte of bytes) sum += byte < 128 ? byte : 256 - byte
    return sum
}

/** An 8-bit PNG: RGBA (channels 4) or RGB (channels 3), no time or text chunks. */
export function encodePng({ width, height, channels, data }) {
    if (channels !== 3 && channels !== 4) throw new Error('PNG channels must be 3 or 4')
    if (data.length !== width * height * channels) throw new Error('PNG data size mismatch')
    const stride = width * channels
    const raw = new Uint8Array((stride + 1) * height)
    let previous = new Uint8Array(stride)
    for (let y = 0; y < height; y++) {
        const row = data.subarray(y * stride, (y + 1) * stride)
        let best
        let bestScore = Infinity
        for (let type = 0; type < 5; type++) {
            const filtered = filterRow(type, row, previous, channels)
            const s = score(filtered)
            if (s < bestScore) {
                best = { type, filtered }
                bestScore = s
            }
        }
        raw[y * (stride + 1)] = best.type
        raw.set(best.filtered, y * (stride + 1) + 1)
        previous = row
    }
    const header = new Uint8Array(13)
    const view = new DataView(header.buffer)
    view.setUint32(0, width)
    view.setUint32(4, height)
    header[8] = 8
    header[9] = channels === 4 ? 6 : 2
    const parts = [
        signature,
        chunk('IHDR', header),
        chunk('IDAT', deflate(raw, { level: 9 })),
        chunk('IEND', new Uint8Array(0)),
    ]
    return Buffer.concat(parts)
}

/** Decodes a PNG made by encodePng (8-bit RGB or RGBA, one or more IDAT chunks). */
export function decodePng(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i < 8; i++) if (bytes[i] !== signature[i]) throw new Error('Not a PNG')
    let width = 0
    let height = 0
    let channels = 0
    const idat = []
    for (let at = 8; at < bytes.length;) {
        const length = view.getUint32(at)
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
        const body = bytes.subarray(at + 8, at + 8 + length)
        if (type === 'IHDR') {
            width = view.getUint32(at + 8)
            height = view.getUint32(at + 12)
            if (body[8] !== 8 || (body[9] !== 2 && body[9] !== 6))
                throw new Error('Unsupported PNG')
            channels = body[9] === 6 ? 4 : 3
        } else if (type === 'IDAT') idat.push(body)
        at += 12 + length
    }
    const raw = inflate(Buffer.concat(idat))
    const stride = width * channels
    const data = new Uint8Array(stride * height)
    for (let y = 0; y < height; y++) {
        const type = raw[y * (stride + 1)]
        for (let i = 0; i < stride; i++) {
            const value = raw[y * (stride + 1) + 1 + i]
            const left = i >= channels ? data[y * stride + i - channels] : 0
            const up = y > 0 ? data[(y - 1) * stride + i] : 0
            const upLeft = y > 0 && i >= channels ? data[(y - 1) * stride + i - channels] : 0
            const predicted =
                type === 0
                    ? 0
                    : type === 1
                      ? left
                      : type === 2
                        ? up
                        : type === 3
                          ? (left + up) >> 1
                          : paeth(left, up, upLeft)
            data[y * stride + i] = (value + predicted) & 255
        }
    }
    return { width, height, channels, data }
}
