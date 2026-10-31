import { isMpegHeader } from '../files/detect'
import { readImageSize } from '../preview/assets/files/image'
import type { BgmMeta } from '../state/bgm'
import { sha256, toHex } from './hash'
import { toWellFormed } from './records/wellFormed'

// Media captured at a pick: the original bytes are hashed before decoding, since
// decodeAudioData detaches the buffer it decodes, and kept as an `ArrayBuffer` copy for the life
// of the states using them. The flush stores them with the entry first naming them.

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
    signature.every((byte, i) => bytes[at + i] === byte)

/**
 * An audio file's MIME type from its magic numbers, the picked file's type only when
 * sniffing finds nothing, and "" when neither gives one.
 */
export const sniffAudioType = (bytes: Uint8Array, fallback = '') => {
    if (startsWith(bytes, [0x49, 0x44, 0x33]) || isMpegHeader(bytes)) return 'audio/mpeg'
    if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg'
    if (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)
    )
        return 'audio/wav'
    if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) return 'audio/flac'
    if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return 'audio/mp4'
    if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'audio/webm'
    return fallback
}

/**
 * An image file's MIME type from its magic numbers (PNG, JPEG, GIF, WebP), the picked file's type
 * only when sniffing finds nothing, and "" when neither gives one.
 */
export const sniffImageType = (bytes: Uint8Array, fallback = '') => {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
    if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
    if (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
    )
        return 'image/webp'
    return fallback
}

/** A picked file's bytes, held as `Bgm.source`, and its metadata before decoding. */
export type CapturedMedia = {
    readonly source: ArrayBuffer
    readonly meta: Omit<BgmMeta, 'durationMs'>
}

/**
 * Captures a picked file's bytes before they're decoded: a copy kept as the source, hashed
 * (the first 16 bytes of its SHA-256), with its size, sniffed type and name. A cover
 * (`image`) is sniffed as an image; a BGM or preview clip as audio.
 */
export const captureMedia = async (
    data: ArrayBuffer,
    file: { readonly name: string; readonly type: string },
    kind: 'audio' | 'image' = 'audio',
): Promise<CapturedMedia> => {
    const source = data.slice(0)
    const bytes = new Uint8Array(source)
    const digest = await sha256(bytes)
    return {
        source,
        meta: {
            hash: toHex(digest.subarray(0, 16)),
            filename: toWellFormed(file.name),
            size: source.byteLength,
            type: (kind === 'image' ? sniffImageType : sniffAudioType)(bytes, file.type),
        },
    }
}

/** A decoded length as the record keeps it. */
export const durationMsOf = (seconds: number) =>
    Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined

/** The largest canvas side Chromium and WebKit allow: a cover over it is never decoded. */
export const COVER_MAX_SIDE = 16_384

export type CoverSize = { width: number; height: number }

const u16le = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
const u24le = (bytes: Uint8Array, at: number) => u16le(bytes, at) | ((bytes[at + 2] ?? 0) << 16)

/**
 * A GIF's size as browsers take it: the logical screen, grown to hold the first frame. Undefined
 * when the file ends before the first frame.
 */
const gifSize = (bytes: Uint8Array): CoverSize | undefined => {
    if (bytes.length < 13) return
    let width = u16le(bytes, 6)
    let height = u16le(bytes, 8)
    const packed = bytes[10] ?? 0
    // A global colour table of 2^(n+1) entries follows the screen descriptor.
    let at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0)
    for (;;) {
        const block = bytes[at]
        if (block === 0x2c) {
            if (at + 9 > bytes.length) return
            width = Math.max(width, u16le(bytes, at + 1) + u16le(bytes, at + 5))
            height = Math.max(height, u16le(bytes, at + 3) + u16le(bytes, at + 7))
            return width > 0 && height > 0 ? { width, height } : undefined
        }
        // Extensions: an introducer, a label, then sub-blocks up to an empty one.
        if (block !== 0x21) return
        at += 2
        for (let size = bytes[at]; size; size = bytes[at]) at += size + 1
        if (at >= bytes.length) return
        at++
    }
}

/**
 * A cover's width and height from its header, for the four formats the editor sniffs (PNG, JPEG,
 * GIF and WebP): undefined when the header is cut off or invalid, `unknown` for another format,
 * which only decoding can measure.
 */
export const readCoverSize = (bytes: Uint8Array): CoverSize | 'unknown' | undefined => {
    const type = sniffImageType(bytes)
    if (type === 'image/png' || type === 'image/jpeg') {
        const size = readImageSize(bytes)
        return size && { width: size.width, height: size.height }
    }
    if (type === 'image/gif') return gifSize(bytes)
    if (type === 'image/webp') {
        if (bytes.length < 30) return
        const chunk = String.fromCharCode(...bytes.subarray(12, 16))
        if (chunk === 'VP8 ') {
            // A key frame's start code, then 14-bit sides.
            if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return
            return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
        }
        if (chunk === 'VP8L') {
            if (bytes[20] !== 0x2f) return
            const bits = u24le(bytes, 21) | ((bytes[24] ?? 0) << 24)
            return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
        }
        if (chunk === 'VP8X') return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
        return
    }
    return 'unknown'
}
