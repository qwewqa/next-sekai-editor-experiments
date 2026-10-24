// Hashes are SHA-256 truncated to 16 bytes. Records under about 1 KB use the
// synchronous SHA-256 below: faster for small inputs, and it can't be awaited into a
// transaction by mistake. Larger inputs use `crypto.subtle`.

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const W = new Uint32Array(64)

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/** SHA-256 of `data`, synchronously (FIPS 180-4). */
export const sha256Sync = (data: Uint8Array): Uint8Array => {
    // The message, a 0x80 byte, zeros, and the bit length in the last 8 bytes.
    const blocks = Math.ceil((data.length + 9) / 64)
    const padded = new Uint8Array(blocks * 64)
    padded.set(data)
    padded[data.length] = 0x80
    const view = new DataView(padded.buffer)
    const bits = data.length * 8
    view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
    view.setUint32(padded.length - 4, bits >>> 0)

    let h0 = 0x6a09e667
    let h1 = 0xbb67ae85
    let h2 = 0x3c6ef372
    let h3 = 0xa54ff53a
    let h4 = 0x510e527f
    let h5 = 0x9b05688c
    let h6 = 0x1f83d9ab
    let h7 = 0x5be0cd19

    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let t = 0; t < 16; t++) W[t] = view.getUint32(offset + t * 4)
        for (let t = 16; t < 64; t++) {
            const w15 = W[t - 15] ?? 0
            const w2 = W[t - 2] ?? 0
            const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
            const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
            W[t] = (W[t - 16] ?? 0) + s0 + (W[t - 7] ?? 0) + s1
        }

        let a = h0
        let b = h1
        let c = h2
        let d = h3
        let e = h4
        let f = h5
        let g = h6
        let h = h7
        for (let t = 0; t < 64; t++) {
            const t1 =
                (h +
                    (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
                    ((e & f) ^ (~e & g)) +
                    (K[t] ?? 0) +
                    (W[t] ?? 0)) |
                0
            const t2 =
                ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
            h = g
            g = f
            f = e
            e = (d + t1) | 0
            d = c
            c = b
            b = a
            a = (t1 + t2) | 0
        }

        h0 = (h0 + a) | 0
        h1 = (h1 + b) | 0
        h2 = (h2 + c) | 0
        h3 = (h3 + d) | 0
        h4 = (h4 + e) | 0
        h5 = (h5 + f) | 0
        h6 = (h6 + g) | 0
        h7 = (h7 + h) | 0
    }

    const out = new Uint8Array(32)
    const outView = new DataView(out.buffer)
    for (const [i, word] of [h0, h1, h2, h3, h4, h5, h6, h7].entries())
        outView.setUint32(i * 4, word)
    return out
}

/** The size below which the synchronous SHA-256 is used. */
export const SYNC_HASH_LIMIT = 1024

/** A record's hash: the first 16 bytes of SHA-256, as a compact 16-byte array. */
export const hash16Sync = (data: Uint8Array) => sha256Sync(data).slice(0, 16)

/** A record's or media item's hash, by the synchronous SHA-256 for small inputs. */
export const hash16 = async (data: Uint8Array): Promise<Uint8Array> => {
    if (data.length < SYNC_HASH_LIMIT) return hash16Sync(data)
    return (await sha256(data)).slice(0, 16)
}

/** The full SHA-256, by `crypto.subtle`. */
export const sha256 = async (data: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))

const hexDigits = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

/** Lowercase hex of bytes: a hash's form outside IndexedDB. */
export const toHex = (bytes: Uint8Array) => {
    let text = ''
    for (const byte of bytes) text += hexDigits[byte] ?? ''
    return text
}

const hash16Pattern = /^[0-9a-f]{32}$/

/** Whether a string is a 16-byte hash in its JSON form. */
export const isHash16Hex = (text: unknown): text is string =>
    typeof text === 'string' && hash16Pattern.test(text)

/** The 16 bytes of a hash's JSON form; throws on anything else. */
export const fromHex16 = (text: string) => {
    if (!isHash16Hex(text)) throw new TypeError(`Unexpected hash ${JSON.stringify(text)}`)
    const bytes = new Uint8Array(16)
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
    return bytes
}

/** Whether two hashes (or any byte arrays) hold the same bytes. */
export const equalBytes = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i])
