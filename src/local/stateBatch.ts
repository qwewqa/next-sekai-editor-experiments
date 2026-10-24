import type { State } from '../state'
import { ChunkBatch, Extractor, runToEnd } from './chunks'
import { summaryOf } from './flush'
import type { BatchSnapshot, ChainSummary } from './flushWrite'

// One state as a batch for the storage worker, every chunk new, as a fresh memo plans it: what
// journal replay and the auto save migration store. The worker deflates,
// verifies and hashes it as it does a flush's (`prepareFlush`).

export type StateBatch = {
    /** The chunks' canonical bytes, one after another; `ends` gives each one's end. */
    text: Uint8Array
    ends: number[]
    snapshot: BatchSnapshot
    summary: ChainSummary
}

const encoder = new TextEncoder()

export const stateBatch = (state: State): StateBatch => {
    const batch = new ChunkBatch()
    const plan = runToEnd(new Extractor().plan(state, batch))
    const parts = batch.texts.map((text) => encoder.encode(text))
    const ends: number[] = []
    let total = 0
    for (const part of parts) ends.push((total += part.length))
    const text = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
        text.set(part, at)
        at += part.length
    }
    const snapshot: BatchSnapshot = {
        header: plan.header,
        kinds: plan.kinds.map(({ kind, chunks }) => ({
            kind,
            chunks: chunks.map((chunk) => {
                const id = chunk.memo.pending?.id
                if (id === undefined) throw new Error('A fresh memo has a stored chunk')
                return id
            }),
        })),
        noteCount: plan.noteCount,
        media: [...plan.media],
    }
    return { text, ends, snapshot, summary: summaryOf(state, plan.noteCount) }
}
