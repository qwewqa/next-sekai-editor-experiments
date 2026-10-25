import type { MediaRef } from '../state/levelInfo'
import { mediaTimeoutMs } from './flush'
import { heldItem } from './heldMedia'
import { storageWorker } from './start'

// A media item as a Blob, for a thumbnail, playing, or a utility to start from: the bytes this tab holds, else the media store's, which re-hashes them against the key.

export type MediaBlob =
    | { kind: 'blob'; blob: Blob }
    /** Neither this tab nor the store has the bytes: "not loaded". */
    | { kind: 'absent' }
    /** The store could not be asked, which says nothing about the item. */
    | { kind: 'failed' }

/** The Blob of the item a state names, with the state's own type. */
export const readMediaBlob = async (ref: MediaRef): Promise<MediaBlob> => {
    const held = heldItem(ref.hash)
    if (held) return { kind: 'blob', blob: new Blob([held.bytes], { type: ref.type || held.type }) }
    const worker = storageWorker
    if (!worker) return { kind: 'absent' }
    try {
        const bytes = await worker.call('readMedia', ref.hash, {
            timeoutMs: mediaTimeoutMs(ref.size),
        })
        return bytes
            ? { kind: 'blob', blob: new Blob([bytes], { type: ref.type }) }
            : { kind: 'absent' }
    } catch {
        return { kind: 'failed' }
    }
}
