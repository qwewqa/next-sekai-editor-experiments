import type { RecordValue } from '../records/canonical'
import { recordPastLimit } from '../records/limits'
import { kindNames, type KindName } from '../records/schema'
import { stackKey, type DiffInput, type KindCandidates } from './diff'

// The worker's narrowing: two snapshots compared by hash, so equal roots, kind
// nodes, leaves and chunks are skipped and only the chunks one side has are read and decoded.
// Chunks that only changed place make their kind read in full, so its stacks keep their order.
// A shared chunk that holds part of a same-beat stack with records in a changed chunk is read on
// both sides, so the diff compares that stack whole.

type Rec = readonly RecordValue[]

export type RootParts = { header: string; kinds: ReadonlyMap<KindName, string> }

export type NodeParts = { depth: 0 | 1; children: readonly string[] }

/** Where the parts come from; undefined for a part missing or damaged. */
export type PartSource = {
    root: (hex: string) => Promise<RootParts | undefined>
    node: (hex: string) => Promise<NodeParts | undefined>
    chunk: (hex: string) => Promise<readonly Rec[] | undefined>
}

/** A part could not be read: the change is unknown. */
class Unreadable extends Error {
    override name = 'Unreadable'
}

const need = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Unreadable()
    return value
}

/** For each value of `a`, whether `b` has it, with multiplicity, first occurrences first. */
const matched = (a: readonly string[], b: readonly string[]) => {
    const counts = new Map<string, number>()
    for (const value of b) counts.set(value, (counts.get(value) ?? 0) + 1)
    return a.map((value) => {
        const count = counts.get(value) ?? 0
        if (count) counts.set(value, count - 1)
        return count > 0
    })
}

/** The values of `a` that `b` has (`shared`) or lacks, with their multiplicity, in `a`'s order. */
const pick = (a: readonly string[], b: readonly string[], shared: boolean) => {
    const found = matched(a, b)
    return a.filter((_, i) => found[i] === shared)
}

/** The values only one side has, with their multiplicity, in list order. */
const difference = (a: readonly string[], b: readonly string[]): [string[], string[]] => [
    pick(a, b, false),
    pick(b, a, false),
]

/** Whether the values both sides have come in the same order. */
const sameOrder = (a: readonly string[], b: readonly string[]) => {
    const x = pick(a, b, true)
    const y = pick(b, a, true)
    return x.length === y.length && x.every((value, i) => value === y[i])
}

/** A chunk, or a leaf both sides have; `shared` numbers the units both sides have, in order. */
type Unit = { hash: string; leaf: boolean; shared?: number }

type Read = (hash: string) => Promise<readonly Rec[]>

/**
 * The chunk hashes of a kind on each side that the other side lacks. A kind other than slides
 * also gives the shared chunks that hold part of a changed stack, and gives all of its chunks
 * when its shared leaves or chunks changed place.
 */
const kindChunks = async (
    source: PartSource,
    read: Read,
    kind: KindName,
    a?: string,
    b?: string,
): Promise<[string[], string[]]> => {
    const empty: NodeParts = { depth: 0, children: [] }
    const nodeA = a ? need(await source.node(a)) : empty
    const nodeB = b ? need(await source.node(b)) : empty
    const leafChunks = async (leaf: string) => {
        const found = need(await source.node(leaf))
        if (found.depth !== 0) throw new Unreadable()
        return found.children
    }
    const chunksOf = async (node: NodeParts, only?: readonly string[]) => {
        if (node.depth === 0) return [...node.children]
        const chunks: string[] = []
        for (const leaf of only ?? node.children) chunks.push(...(await leafChunks(leaf)))
        return chunks
    }
    // Two-level kinds skip the leaves they share.
    const twoLevel = nodeA.depth === 1 && nodeB.depth === 1
    if (kind === 'slides') {
        const [leavesA, leavesB] = twoLevel
            ? difference(nodeA.children, nodeB.children)
            : [undefined, undefined]
        return difference(await chunksOf(nodeA, leavesA), await chunksOf(nodeB, leavesB))
    }

    const unitsOf = async (node: NodeParts, other: NodeParts) => {
        if (!twoLevel) return (await chunksOf(node)).map((hash): Unit => ({ hash, leaf: false }))
        const kept = matched(node.children, other.children)
        const units: Unit[] = []
        for (const [i, leaf] of node.children.entries())
            if (kept[i]) units.push({ hash: leaf, leaf: true })
            else for (const hash of await leafChunks(leaf)) units.push({ hash, leaf: false })
        return units
    }
    const unitsA = await unitsOf(nodeA, nodeB)
    const unitsB = await unitsOf(nodeB, nodeA)
    const keysOf = (units: readonly Unit[]) =>
        units.map(({ hash, leaf }) => `${leaf ? 'leaf' : 'chunk'}:${hash}`)
    const keysA = keysOf(unitsA)
    const keysB = keysOf(unitsB)
    if (!sameOrder(keysA, keysB)) return [await chunksOf(nodeA), await chunksOf(nodeB)]
    for (const [units, found] of [
        [unitsA, matched(keysA, keysB)],
        [unitsB, matched(keysB, keysA)],
    ] as const) {
        let n = 0
        for (const [i, unit] of units.entries()) if (found[i]) unit.shared = n++
    }

    // The stacks with a record in a changed chunk, and the shared chunks that hold part of one.
    const stacks = new Set<string>()
    for (const unit of [...unitsA, ...unitsB])
        if (unit.shared === undefined)
            for (const record of await read(unit.hash)) stacks.add(stackKey(kind, record))
    const holdsStack = async (hash: string) =>
        (await read(hash)).some((record) => stacks.has(stackKey(kind, record)))
    const keptChunks = new Set<number>()
    const keptInLeaves = new Map<number, Set<number>>()
    // Records are in beat order, so a stack's chunks come one after another: from each changed
    // chunk, walk each way while the next chunk holds part of a changed stack.
    for (const units of [unitsA, unitsB])
        for (const [start, unit] of units.entries()) {
            if (unit.shared !== undefined) continue
            for (const step of [-1, 1])
                walk: for (let i = start + step; ; i += step) {
                    const next = units[i]
                    if (next?.shared === undefined) break
                    if (!next.leaf) {
                        if (!(await holdsStack(next.hash))) break
                        keptChunks.add(next.shared)
                        continue
                    }
                    const chunks = await leafChunks(next.hash)
                    const kept = keptInLeaves.get(next.shared) ?? new Set()
                    keptInLeaves.set(next.shared, kept)
                    for (let j = 0; j < chunks.length; j++) {
                        const at = step > 0 ? j : chunks.length - 1 - j
                        if (!(await holdsStack(need(chunks[at])))) break walk
                        kept.add(at)
                    }
                }
        }
    const listOf = async (units: readonly Unit[]) => {
        const list: string[] = []
        for (const { hash, leaf, shared } of units) {
            if (shared === undefined || (!leaf && keptChunks.has(shared))) list.push(hash)
            const kept = shared === undefined ? undefined : keptInLeaves.get(shared)
            if (leaf && kept?.size)
                for (const [at, chunk] of (await leafChunks(hash)).entries())
                    if (kept.has(at)) list.push(chunk)
        }
        return list
    }
    return [await listOf(unitsA), await listOf(unitsB)]
}

/**
 * The candidates for `diffChanges` from two roots, as hex; undefined when a part is missing or
 * damaged. Equal roots changed nothing.
 */
export const readCandidates = async (
    source: PartSource,
    before: string,
    after: string,
): Promise<DiffInput | undefined> => {
    if (before === after) return { header: false, kinds: [] }
    try {
        const a = need(await source.root(before))
        const b = need(await source.root(after))
        const read = new Map<string, Promise<readonly Rec[]>>()
        const chunk: Read = (hash) => {
            let records = read.get(hash)
            if (!records) read.set(hash, (records = source.chunk(hash).then(need)))
            return records
        }
        const kinds: KindCandidates[] = []
        for (const kind of kindNames) {
            const nodeA = a.kinds.get(kind)
            const nodeB = b.kinds.get(kind)
            if (nodeA === nodeB) continue
            const [chunksA, chunksB] = await kindChunks(source, chunk, kind, nodeA, nodeB)
            const records = async (chunks: readonly string[]) => {
                const list: Rec[] = []
                for (const hash of chunks)
                    for (const record of await chunk(hash)) {
                        // Past the limits is damage: building it would hang the grid.
                        if (recordPastLimit(kind, record)) throw new Unreadable()
                        list.push(record)
                    }
                return list
            }
            kinds.push({ kind, before: await records(chunksA), after: await records(chunksB) })
        }
        return { header: a.header !== b.header, kinds }
    } catch (error) {
        if (error instanceof Unreadable) return
        throw error
    }
}

/** Whether a parsed chunk holds records of its kind's form, as far as the diff reads them. */
export const isRecordList = (value: unknown): value is Rec[] =>
    Array.isArray(value) && value.every((record) => Array.isArray(record))
