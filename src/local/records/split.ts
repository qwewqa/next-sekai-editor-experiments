import type { KeyedRecord } from './records'
import type { KindName } from './schema'

// The split, pinned in v1 (§1.6.11.1): a 16-beat window holding more than 24 records splits at
// 4-beat boundaries, a 4-beat part holding more than 24 at 1-beat boundaries, and only a 1-beat
// part holding more than 24 into runs of 24. A kind other than `slides` with at most 64
// records in all is one chunk. The kind node groups the chunks 16 at a time; both are pinned.

export const PART_LIMIT = 24
export const SMALL_KIND_LIMIT = 64
export const NODE_FANOUT = 16

const widths = [16, 4, 1] as const

/** Consecutive runs of records whose keys fall in the same `width`-beat part. */
const partsOf = <T extends KeyedRecord>(records: readonly T[], width: number) => {
    const parts: T[][] = []
    let part: T[] = []
    let current: number | undefined
    for (const item of records) {
        const at = Math.floor(item.key / width)
        if (part.length && at !== current) {
            parts.push(part)
            part = []
        }
        current = at
        part.push(item)
    }
    if (part.length) parts.push(part)
    return parts
}

const split = <T extends KeyedRecord>(records: readonly T[], level: number, chunks: T[][]) => {
    const width = widths[level]
    if (width === undefined) {
        for (let at = 0; at < records.length; at += PART_LIMIT)
            chunks.push(records.slice(at, at + PART_LIMIT))
        return
    }
    for (const part of partsOf(records, width)) {
        if (part.length <= PART_LIMIT) chunks.push(part)
        else split(part, level + 1, chunks)
    }
}

/** A kind's records, already in the v1 order, as its chunks in key order. */
export const splitKind = <T extends KeyedRecord>(kind: KindName, records: readonly T[]): T[][] => {
    if (!records.length) return []
    if (kind !== 'slides' && records.length <= SMALL_KIND_LIMIT) return [[...records]]
    const chunks: T[][] = []
    split(records, 0, chunks)
    return chunks
}

/** A kind's chunk hashes as kind-node levels: depth 0 for at most 16, else 16 per depth-0 node. */
export const groupChunks = <H>(hashes: readonly H[]): H[][] => {
    const groups: H[][] = []
    for (let at = 0; at < hashes.length; at += NODE_FANOUT)
        groups.push(hashes.slice(at, at + NODE_FANOUT))
    return groups
}
