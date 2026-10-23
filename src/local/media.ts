import { isMpegHeader } from '../files/detect'
import type { BgmMeta } from '../state/bgm'
import { sha256, toHex } from './hash'
import { toWellFormed } from './records/wellFormed'

// Media captured at a pick (Part 1 §1.6.8.4): the original bytes are hashed before decoding, since
// decodeAudioData detaches the buffer it decodes, and kept as an `ArrayBuffer` copy for the life
// of the states using them. The flush stores them with the entry first naming them.

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
    signature.every((byte, i) => bytes[at + i] === byte)

/**
 * An audio file's MIME type from its magic numbers (§1.5.2), the picked file's type only when
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
 * (the first 16 bytes of its SHA-256, §1.6.11.1), with its size, sniffed type and name. A cover
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

/** A decoded length as the record keeps it (§1.6.11.1). */
export const durationMsOf = (seconds: number) =>
    Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined
