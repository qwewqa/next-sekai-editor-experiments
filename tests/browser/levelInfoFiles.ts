import { deflateSync } from 'node:zlib'

// Small media files for Level Info's specs: a PNG of one colour and a WAV tone.

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
})

const crc32 = (bytes: Buffer) => {
    let c = 0xffffffff
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
}

/** A PNG of `width` × `height`, in one colour with a lighter left half so it is not flat. */
export const png = (width: number, height: number, [r, g, b]: [number, number, number]) => {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0)
    header.writeUInt32BE(height, 4)
    header[8] = 8
    header[9] = 2
    const rows = Buffer.alloc((width * 3 + 1) * height)
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const at = y * (width * 3 + 1) + 1 + x * 3
            const lift = x < width / 2 ? 60 : 0
            rows[at] = Math.min(255, r + lift)
            rows[at + 1] = Math.min(255, g + lift)
            rows[at + 2] = Math.min(255, b + lift)
        }
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
    ])
}

/** A mono 16-bit WAV of `seconds` of a sine tone at `tone` (samples per radian). */
export const wav = (seconds: number, tone = 5) => {
    const sampleRate = 8000
    const length = Math.round(seconds * sampleRate)
    const data = Buffer.alloc(44 + length * 2)
    data.write('RIFF', 0)
    data.writeUInt32LE(data.length - 8, 4)
    data.write('WAVEfmt ', 8)
    data.writeUInt32LE(16, 16)
    data.writeUInt16LE(1, 20)
    data.writeUInt16LE(1, 22)
    data.writeUInt32LE(sampleRate, 24)
    data.writeUInt32LE(sampleRate * 2, 28)
    data.writeUInt16LE(2, 32)
    data.writeUInt16LE(16, 34)
    data.write('data', 36)
    data.writeUInt32LE(length * 2, 40)
    for (let i = 0; i < length; i++)
        data.writeInt16LE(Math.round(Math.sin(i / tone) * 12000), 44 + i * 2)
    return data
}
