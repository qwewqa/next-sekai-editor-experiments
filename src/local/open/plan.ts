import type { ReadHistory } from '../nxsp'
import { distinctRootChunks } from '../nxsp/manifest'

// The open's background import (Part 1 §1.5.4, r12-arch-web M9), in batches, each its own
// transaction: the history's entry rows, the other roots and nodes, then the other chunks (the
// undo stack's states first, nearest the head first), then the batch that clears `importPending`.

export type ImportBatch =
    | { kind: 'entries'; from: number; to: number }
    | { kind: 'records'; keys: string[] }
    | { kind: 'chunks'; hashes: string[] }
    | { kind: 'finish' }

/** Rows per entries batch, roots and nodes per records batch. */
export const BATCH_ROWS = 2000
/** Chunks per batch, and their stored bytes at most. */
export const BATCH_CHUNKS = 2000
export const BATCH_CHUNK_BYTES = 4 * 1024 * 1024

/** Distinct chunks a root reaches, in first-use order. */
export const chunksOfRoot = (history: Pick<ReadHistory, 'roots' | 'nodes'>, hex: string) => [
    ...distinctRootChunks(history, [hex]),
]

/** Every node a root reaches, kind nodes at every depth. */
export const nodesOfRoot = (history: Pick<ReadHistory, 'roots' | 'nodes'>, hex: string) => {
    const root = history.roots.get(hex)
    if (!root) return []
    const out: string[] = []
    const seen = new Set<string>()
    const node = (hash: string) => {
        if (seen.has(hash)) return
        seen.add(hash)
        const json = history.nodes.get(hash)
        if (!json) return
        out.push(hash)
        if (json[1] === 1) for (const child of json[2] as string[]) node(child)
    }
    for (const [, top] of root[2] as [string, string][]) node(top)
    return out
}

/** The undo stack's roots, the head first, then outward from it: what Undo reaches first. */
export const stackOrder = (history: Pick<ReadHistory, 'undoStack'>) => {
    const { base, slots, index } = history.undoStack
    const at = index - base
    const order: string[] = []
    const seen = new Set<string>()
    for (let step = 0; step < slots.length; step++)
        for (const i of step ? [at - step, at + step] : [at]) {
            const slot = slots[i]
            if (slot && !seen.has(slot.snapshot)) {
                seen.add(slot.snapshot)
                order.push(slot.snapshot)
            }
        }
    return order
}

/**
 * The batches after the first transaction. `stored` names what that transaction stored (the
 * head's parts, the stack's roots and nodes), so they aren't sent again, and `entriesStored` says
 * it stored the rows too.
 */
export const planImport = (
    history: ReadHistory,
    stored: ReadonlySet<string>,
    entriesStored = false,
): ImportBatch[] => {
    const batches: ImportBatch[] = []
    const count = entriesStored ? 0 : history.entries.length
    for (let from = 0; from < count; from += BATCH_ROWS)
        batches.push({ kind: 'entries', from, to: Math.min(count, from + BATCH_ROWS) })

    const records = [...history.roots.keys(), ...history.nodes.keys()].filter(
        (key) => !stored.has(key),
    )
    for (let i = 0; i < records.length; i += BATCH_ROWS)
        batches.push({ kind: 'records', keys: records.slice(i, i + BATCH_ROWS) })

    // The stack's states first, then every other root's.
    const chunks: string[] = []
    const seen = new Set<string>(stored)
    const take = (hash: string) => {
        if (seen.has(hash) || !history.index.has(hash)) return
        seen.add(hash)
        chunks.push(hash)
    }
    // A chunk no root reaches isn't imported (§1.6.11.5).
    for (const hash of distinctRootChunks(history, [
        ...stackOrder(history),
        ...history.roots.keys(),
    ]))
        take(hash)
    let batch: string[] = []
    let bytes = 0
    for (const hash of chunks) {
        const length = history.index.get(hash)?.length ?? 0
        if (batch.length && (batch.length >= BATCH_CHUNKS || bytes + length > BATCH_CHUNK_BYTES)) {
            batches.push({ kind: 'chunks', hashes: batch })
            batch = []
            bytes = 0
        }
        batch.push(hash)
        bytes += length
    }
    if (batch.length) batches.push({ kind: 'chunks', hashes: batch })
    batches.push({ kind: 'finish' })
    return batches
}
