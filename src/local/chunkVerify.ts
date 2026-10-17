import { Deflate, Inflate } from 'pako'
import { equalBytes, hash16 } from './hash'
import { chunkCrc32, type ChunkRow } from './records/rows'

// Chunks are stored as raw DEFLATE of their canonical bytes (§1.6.11.1). Every `chunks` put
// takes a `VerifiedChunk`, which only `verifyChunk` makes (§1.6.11.2): the stored form,
// inflated with the strict end check, equals the canonical bytes that were hashed (bytes this
// build deflated) or hashes to the chunk's hash (bytes from outside).

/** A stored form that isn't one whole raw DEFLATE stream: damage, as a wrong hash is. */
export class DeflateError extends Error {
    override name = 'DeflateError'
}

/** A chunk whose stored form doesn't hold what its hash names. */
export class ChunkVerifyError extends Error {
    override name = 'ChunkVerifyError'
}

const Z_FINISH = 4

/** The reader cap on a chunk's inflated size (§1.6.11.4): bytes from outside never inflate past it. */
export const CHUNK_CAP = 16 * 1024 * 1024

/**
 * Inflates one raw DEFLATE stream that must end exactly at the input's last byte (§1.6.11.1's
 * strict end check): trailing bytes, a truncated stream, or a last block that isn't final throw.
 */
export const inflateStrict = (stored: Uint8Array, maxSize = Infinity): Uint8Array => {
    const inflator = new Inflate({ raw: true })
    // pako updates `avail_in` as it consumes the input.
    let input = { avail_in: stored.length }
    inflator.onStart = (strm) => {
        input = strm
    }
    const chunks: Uint8Array[] = []
    let total = 0
    inflator.onData = (chunk) => {
        total += chunk.length
        if (total > maxSize) throw new DeflateError('Inflates past its size')
        chunks.push(chunk)
    }
    inflator.push(stored, Z_FINISH)
    if (!inflator.ended || inflator.err !== 0 || input.avail_in !== 0)
        throw new DeflateError('Not one whole raw DEFLATE stream')

    const out = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
        out.set(chunk, at)
        at += chunk.length
    }
    return out
}

let deflateHook: ((stored: Uint8Array) => Uint8Array) | undefined

/** A test hook that changes what `deflateChunk` returns, to prove verify on write catches it. */
export const setDeflateHookForTests = (hook: typeof deflateHook) => {
    deflateHook = hook
}

/** A chunk's stored form: raw DEFLATE at pako's default level. */
export const deflateChunk = (canonical: Uint8Array): Uint8Array => {
    const deflator = new Deflate({ raw: true })
    deflator.push(canonical, Z_FINISH)
    if (deflator.err !== 0) throw new DeflateError(deflator.msg || 'Deflate failed')
    const stored = deflator.result
    return deflateHook ? deflateHook(stored) : stored
}

declare const verified: unique symbol

/** A chunk whose stored form was checked against its hash; only `verifyChunk` makes one. */
export type VerifiedChunk = {
    readonly hash: Uint8Array
    readonly stored: Uint8Array
    /** The canonical bytes' length. */
    readonly size: number
    readonly [verified]: true
}

const made = new WeakSet()

export type ChunkToVerify =
    /** Bytes this build deflated from canonical bytes it hashed. */
    | { hash: Uint8Array; stored: Uint8Array; canonical: Uint8Array }
    /** Bytes from outside (a file): they must hash to `hash`, inflating to at most `maxSize`. */
    | { hash: Uint8Array; stored: Uint8Array; canonical?: undefined; maxSize?: number }

/**
 * The one check before a `chunks` put (§1.6.11.2). Runs before the transaction, since hashing
 * outside bytes awaits `crypto.subtle`. Throws `DeflateError` or `ChunkVerifyError` on a mismatch.
 */
export const verifyChunk = async (chunk: ChunkToVerify): Promise<VerifiedChunk> => {
    if (chunk.hash.length !== 16) throw new ChunkVerifyError('Unexpected hash length')
    // Verified and kept as copies, so the bytes stored are the bytes checked, whatever the
    // caller later does with its buffers.
    const hash = chunk.hash.slice()
    const stored = chunk.stored.slice()
    let size: number
    if (chunk.canonical) {
        const inflated = inflateStrict(stored, chunk.canonical.length)
        if (!equalBytes(inflated, chunk.canonical))
            throw new ChunkVerifyError('Deflated bytes do not inflate to the canonical bytes')
        size = inflated.length
    } else {
        const inflated = inflateStrict(stored, Math.min(chunk.maxSize ?? CHUNK_CAP, CHUNK_CAP))
        if (!equalBytes(await hash16(inflated), hash))
            throw new ChunkVerifyError('Stored bytes do not hash to the chunk’s hash')
        size = inflated.length
    }
    const result = { hash, stored, size } as VerifiedChunk
    made.add(result)
    return result
}

/** Whether a value came from `verifyChunk`: `putChunk` checks this as well as the type. */
export const isVerifiedChunk = (chunk: unknown): chunk is VerifiedChunk =>
    typeof chunk === 'object' && chunk !== null && made.has(chunk)

/**
 * The row `putChunk` stores for a verified chunk (§1.6.11.2): a compact copy of the stored
 * bytes, never a view into a larger buffer, and the CRC over the key and exactly those bytes.
 * Synchronous, so it runs inside the transaction.
 */
export const chunkRowOf = (chunk: VerifiedChunk, day: number): ChunkRow => {
    if (!isVerifiedChunk(chunk)) throw new ChunkVerifyError('Unverified chunk')
    const bytes = chunk.stored.slice()
    return { bytes, size: chunk.size, crc32: chunkCrc32(chunk.hash, bytes), day }
}
