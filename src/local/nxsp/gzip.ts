import { deflateRaw } from 'pako'
import { crc32 } from '../../zip/crc32'
import { inflateStrict } from '../chunkVerify'

export class GzipError extends Error {
    override name = 'GzipError'
}

export const gzipStoredCap = (levelCap: number) => 2 * levelCap + 1024

/** One deterministic member, with no timestamp, filename or comment. */
export const gzipLevel = (bytes: Uint8Array): Uint8Array => {
    const compressed = deflateRaw(bytes)
    const out = new Uint8Array(compressed.length + 18)
    out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255])
    out.set(compressed, 10)
    const trailer = new DataView(out.buffer, out.length - 8)
    trailer.setUint32(0, crc32(bytes), true)
    trailer.setUint32(4, bytes.length, true)
    return out
}

/** Gzip only: one complete member, checked wrapper and bounded output. */
export const gunzipLevel = (stored: Uint8Array, maxSize: number): Uint8Array => {
    const fail = (): never => {
        throw new GzipError('Not one whole gzip member')
    }
    if (stored.length > gzipStoredCap(maxSize)) throw new GzipError('Gzip is over its cap')
    if (stored.length < 18 || stored[0] !== 0x1f || stored[1] !== 0x8b || stored[2] !== 8) fail()
    const view = new DataView(stored.buffer, stored.byteOffset, stored.byteLength)
    const flags = view.getUint8(3)
    if (flags & 0xe0) fail()
    const end = stored.length - 8
    let at = 10
    if (flags & 4) {
        if (at + 2 > end) fail()
        const size = view.getUint16(at, true)
        at += 2 + size
        if (at > end) fail()
    }
    for (const flag of [8, 16]) {
        if (!(flags & flag)) continue
        while (at < end && stored[at] !== 0) at++
        if (at >= end) fail()
        at++
    }
    if (flags & 2) {
        if (at + 2 > end || (crc32(stored.subarray(0, at)) & 0xffff) !== view.getUint16(at, true))
            fail()
        at += 2
    }
    let bytes: Uint8Array
    try {
        bytes = inflateStrict(stored.subarray(at, end), maxSize)
    } catch {
        throw new GzipError('Invalid or oversized gzip data')
    }
    const trailer = new DataView(stored.buffer, stored.byteOffset + end, 8)
    if (trailer.getUint32(0, true) !== crc32(bytes) || trailer.getUint32(4, true) !== bytes.length)
        fail()
    return bytes
}
