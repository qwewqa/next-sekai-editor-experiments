import { Inflate } from 'pako'

/** Output past the cap, found while inflating. */
export class CapExceeded extends Error {
    override name = 'CapExceeded'
}

/** Inflates gzip (or zlib) data, stopping as soon as the output passes `max`. */
export const gunzipCapped = (data: Uint8Array, max: number) => {
    const inflator = new Inflate()
    const chunks: Uint8Array[] = []
    let total = 0
    inflator.onData = (chunk) => {
        total += chunk.length
        if (total > max) throw new CapExceeded()
        chunks.push(chunk)
    }
    inflator.push(data, true)
    if (!inflator.ended || inflator.err !== 0) throw new Error('Not valid gzip data')

    const out = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
        out.set(chunk, at)
        at += chunk.length
    }
    return out
}
