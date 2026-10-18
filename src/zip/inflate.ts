import { Inflate } from 'pako'
import { crc32 } from './crc32'
import { ZipError } from './error'

const Z_BUF_ERROR = -5

/**
 * Inflates raw DEFLATE data that must come to exactly `size` bytes, handing each piece of output
 * to `onData`. Output past `size`, a stream that ends early and trailing bytes are all damage, so
 * a bomb stops as soon as it passes what the entry declared.
 */
const inflateStream = (data: Uint8Array, size: number, onData: (chunk: Uint8Array) => void) => {
    if (size === 0 && data.length === 0) return

    const inflator = new Inflate({ raw: true })
    let total = 0
    // pako updates `avail_in` as it consumes the input.
    let input = { avail_in: data.length }
    inflator.onStart = (strm) => {
        input = strm
    }
    inflator.onData = (chunk) => {
        total += chunk.length
        if (total > size) throw new ZipError('size', 'inflates past its declared size')
        onData(chunk)
    }
    inflator.push(data, true)

    // pako reports a stream that stops before its last block as a buffer error.
    if (inflator.err === Z_BUF_ERROR) throw new ZipError('truncated')
    if (!inflator.ended || inflator.err !== 0) throw new ZipError('inflate')
    if (input.avail_in > 0) throw new ZipError('size', 'bytes after the compressed stream')
    if (total !== size) throw new ZipError('size', 'inflates short of its declared size')
}

/**
 * Inflates raw DEFLATE data that must come to exactly `size` bytes (see `inflateStream`), into
 * one buffer of that size, so the output is never held twice. Callers cap `size` first.
 */
export const inflateExact = (data: Uint8Array, size: number) => {
    const out = new Uint8Array(size)
    let at = 0
    inflateStream(data, size, (chunk) => {
        out.set(chunk, at)
        at += chunk.length
    })
    return out
}

/** The CRC-32 of what raw DEFLATE data inflates to, exactly `size` bytes, without keeping it. */
export const inflatedCrc = (data: Uint8Array, size: number) => {
    let crc = 0
    inflateStream(data, size, (chunk) => {
        crc = crc32(chunk, crc)
    })
    return crc
}
