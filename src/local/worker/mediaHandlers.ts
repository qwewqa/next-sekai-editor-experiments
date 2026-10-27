import { hashKey } from '../db'
import { equalBytes, fromHex16, isHash16Hex, sha256, toHex } from '../hash'
import { isObject } from '../nxsp/json'
import type { WorkerContext } from './handlers'
import { transfer } from './rpc'

// The storage worker's media read: a stored item's bytes for a state that names
// its hash but holds no audio, as after a reload.

export const mediaHandlers = (context: WorkerContext) => ({
    /**
     * The bytes of a stored media item, re-hashed against its key (and the row's own digest), as
     * a transferred buffer. Undefined when the row is missing or its bytes are not whole: that is
     * "not held". A read that could not be made rejects, which is not an answer.
     */
    readMedia: async (hash: string): Promise<ArrayBuffer | undefined> => {
        if (!isHash16Hex(hash)) return
        const row: unknown = await context.core.read(['media'], (tx) =>
            tx.get('media', hashKey(fromHex16(hash))),
        )
        if (!isObject(row) || !(row.blob instanceof Blob)) return
        const bytes = await row.blob.arrayBuffer()
        const digest = await sha256(new Uint8Array(bytes))
        if (toHex(digest.subarray(0, 16)) !== hash) return
        if (row.sha256 instanceof Uint8Array && !equalBytes(row.sha256, digest)) return
        return transfer(bytes, [bytes])
    },
})
