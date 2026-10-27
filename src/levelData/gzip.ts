import { Inflate } from 'pako'
import { LEVEL_FILE_MAX_BYTES } from './fileLimit'

/** A level file inflated past the limit. */
export class LevelFileTooLarge extends Error {}

export const isGzip = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength))
    return bytes[0] === 0x1f && bytes[1] === 0x8b
}

/**
 * Inflates a gzip, stopping with `LevelFileTooLarge` once the output passes `cap`. Any other
 * failure is the gzip's own.
 */
export const inflateCapped = (bytes: Uint8Array, cap = LEVEL_FILE_MAX_BYTES) => {
    const chunks: Uint8Array[] = []
    let total = 0
    const inflate = new Inflate()
    inflate.onData = (chunk) => {
        total += chunk.length
        if (total > cap) throw new LevelFileTooLarge('The level file inflates past the limit')
        chunks.push(chunk)
    }
    if (!inflate.push(bytes, true)) throw new Error(inflate.msg)
    const out = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
        out.set(chunk, at)
        at += chunk.length
    }
    return out
}
