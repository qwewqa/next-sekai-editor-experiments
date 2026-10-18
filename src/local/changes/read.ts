import type { RecordValue } from '../records/canonical'
import { kindNames, type KindName } from '../records/schema'
import type { DiffInput, KindCandidates } from './diff'

// The worker's narrowing (Part 1 §1.6.5): two snapshots compared by hash, so equal roots, kind
// nodes, leaves and chunks are skipped and only the chunks one side has are read and decoded.

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

/** The values only one side has, with their multiplicity. */
const difference = (a: readonly string[], b: readonly string[]): [string[], string[]] => {
    const counts = new Map<string, number>()
    for (const value of a) counts.set(value, (counts.get(value) ?? 0) + 1)
    const onlyB: string[] = []
    for (const value of b) {
        const count = counts.get(value) ?? 0
        if (count) counts.set(value, count - 1)
        else onlyB.push(value)
    }
    const onlyA: string[] = []
    for (const [value, count] of counts) for (let i = 0; i < count; i++) onlyA.push(value)
    return [onlyA, onlyB]
}

/** The chunk hashes of a kind on each side that the other side lacks. */
const kindChunks = async (source: PartSource, a?: string, b?: string) => {
    const empty: NodeParts = { depth: 0, children: [] }
    const nodeA = a ? need(await source.node(a)) : empty
    const nodeB = b ? need(await source.node(b)) : empty
    const leaves = async (node: NodeParts, only?: readonly string[]) => {
        if (node.depth === 0) return node.children
        const chunks: string[] = []
        for (const leaf of only ?? node.children) {
            const found = need(await source.node(leaf))
            if (found.depth !== 0) throw new Unreadable()
            for (const chunk of found.children) chunks.push(chunk)
        }
        return chunks
    }
    // Two-level kinds skip the leaves they share.
    const [leavesA, leavesB] =
        nodeA.depth === 1 && nodeB.depth === 1
            ? difference(nodeA.children, nodeB.children)
            : [undefined, undefined]
    return difference(await leaves(nodeA, leavesA), await leaves(nodeB, leavesB))
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
        const kinds: KindCandidates[] = []
        for (const kind of kindNames) {
            const nodeA = a.kinds.get(kind)
            const nodeB = b.kinds.get(kind)
            if (nodeA === nodeB) continue
            const [chunksA, chunksB] = await kindChunks(source, nodeA, nodeB)
            const records = async (chunks: readonly string[]) => {
                const list: Rec[] = []
                for (const chunk of chunks)
                    for (const record of need(await source.chunk(chunk))) list.push(record)
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
