import { chunkRowOf, ChunkVerifyError, isVerifiedChunk, type VerifiedChunk } from './chunkVerify'
import { hashKey } from './db'
import type { KvTx } from './kv/types'
import { isChunkRowIntact, type ChunkRow } from './records/rows'

// The one `chunks` writer (Part 1 §1.6.11.2): the flush, journal replay, the migration, the
// `.nxsp` import and Check's repair all put chunks through here. It takes only a `VerifiedChunk`,
// which only `verifyChunk` makes, so no caller can skip the check; inside the transaction it
// does only synchronous work and its own requests.

const isIntactRow = (key: Uint8Array, row: unknown): row is ChunkRow => {
    const value = row as Partial<ChunkRow> | undefined
    return (
        value?.bytes instanceof Uint8Array &&
        typeof value.crc32 === 'number' &&
        isChunkRowIntact(key, { bytes: value.bytes, crc32: value.crc32 })
    )
}

/**
 * Stores a verified chunk unless an intact row is already there, which keeps that row's first
 * `day` (GC's grace period). A row whose CRC fails (bit rot, a value under another key) is
 * replaced by the verified bytes, keeping its `day` when it has one. Returns the row it added
 * under a new key, or undefined.
 */
export const putChunk = async (
    tx: KvTx,
    chunk: VerifiedChunk,
    day: number,
): Promise<ChunkRow | undefined> => {
    if (!isVerifiedChunk(chunk)) throw new ChunkVerifyError('Unverified chunk')
    const key = hashKey(chunk.hash)
    const old = await tx.get('chunks', key)
    if (old === undefined) {
        const row = chunkRowOf(chunk, day)
        await tx.put('chunks', row, key)
        return row
    }
    if (isIntactRow(chunk.hash, old)) return
    const oldDay = (old as { day?: unknown } | undefined)?.day
    await tx.put(
        'chunks',
        chunkRowOf(chunk, Number.isSafeInteger(oldDay) ? (oldDay as number) : day),
        key,
    )
}
