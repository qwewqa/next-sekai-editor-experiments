import { Inflate } from 'pako'
import { ZipError } from './error'

const Z_BUF_ERROR = -5

/**
 * Inflates raw DEFLATE data that must come to exactly `size` bytes. Output past
 * `size`, a stream that ends early and trailing bytes are all damage, so a
 * bomb stops as soon as it passes what the entry declared.
 */
export const inflateExact = (data: Uint8Array, size: number) => {
    if (size === 0 && data.length === 0) return new Uint8Array(0)

    const inflator = new Inflate({ raw: true })
    const chunks: Uint8Array[] = []
    let total = 0
    // pako updates `avail_in` as it consumes the input.
    let input = { avail_in: data.length }
    inflator.onStart = (strm) => {
        input = strm
    }
    inflator.onData = (chunk) => {
        total += chunk.length
        if (total > size) throw new ZipError('size', 'inflates past its declared size')
        chunks.push(chunk)
    }
    inflator.push(data, true)

    // pako reports a stream that stops before its last block as a buffer error.
    if (inflator.err === Z_BUF_ERROR) throw new ZipError('truncated')
    if (!inflator.ended || inflator.err !== 0) throw new ZipError('inflate')
    if (input.avail_in > 0) throw new ZipError('size', 'bytes after the compressed stream')
    if (total !== size) throw new ZipError('size', 'inflates short of its declared size')

    const out = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
        out.set(chunk, at)
        at += chunk.length
    }
    return out
}
