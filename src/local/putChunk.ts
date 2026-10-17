import { chunkRowOf, ChunkVerifyError, isVerifiedChunk, type VerifiedChunk } from './chunkVerify'
import { hashKey } from './db'
import type { KvTx } from './kv/types'
import type { ChunkRow } from './records/rows'

// The one `chunks` writer (Part 1 §1.6.11.2): the flush, journal replay, the migration, the
// `.nxsp` import and Check's repair all put chunks through here. It takes only a `VerifiedChunk`,
// which only `verifyChunk` makes, so no caller can skip the check; inside the transaction it
// does only synchronous work and its own requests.

/**
 * Stores a verified chunk unless its row is already there, which keeps that row's first `day`
 * (GC's grace period). Returns the row it put, or undefined.
 */
export const putChunk = async (
    tx: KvTx,
    chunk: VerifiedChunk,
    day: number,
): Promise<ChunkRow | undefined> => {
    if (!isVerifiedChunk(chunk)) throw new ChunkVerifyError('Unverified chunk')
    const key = hashKey(chunk.hash)
    if ((await tx.getKey('chunks', key)) !== undefined) return
    const row = chunkRowOf(chunk, day)
    await tx.put('chunks', row, key)
    return row
}
