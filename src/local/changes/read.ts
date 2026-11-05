import type { RecordValue } from '../records/canonical'
import { recordPastLimit } from '../records/limits'
import { kindNames, type KindName } from '../records/schema'
import { stackPlace, type DiffInput, type KindCandidates } from './diff'

// The worker's narrowing: two snapshots compared by hash, so equal roots, kind
// nodes, leaves and chunks are skipped and only the chunks one side has are read and decoded.
// Chunks that only changed place make their kind read in full, so its stacks keep their order.
// A shared chunk whose records span the place of a same-beat stack with records in a changed
// chunk is read on both sides, so the diff compares that stack whole. Spans are kept between
// reads, so a chunk is read for its span once.

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

/** A chunk, or a leaf; `shared` when the other side has it too, in the same place among those. */
type Unit = { hash: string; leaf: boolean; shared: boolean }

type Read = (hash: string) => Promise<readonly Rec[]>

/** A stack's place: its beat, then its track. */
type Place = readonly [number, number]

/** The lowest and highest places a part's records hold; undefined when it holds none. */
type Span = { low: Place; high: Place } | undefined

const comparePlaces = (a: Place, b: Place) => a[0] - b[0] || a[1] - b[1]

// Spans by kind and hash. A part's hash names its content, so a span once read holds; the map
// starts over past the limit.
const spans = new Map<string, Span>()
const SPAN_LIMIT = 100_000

const remember = (key: string, span: Span) => {
    if (spans.size >= SPAN_LIMIT) spans.clear()
    spans.set(key, span)
    return span
}

/** At most this many chunk reads in flight while spans are read. */
const SPAN_READS = 16

/** Runs `task` on each item, `limit` at a time; the first failure is thrown once all have stopped. */
const eachLimited = async <T>(
    items: readonly T[],
    limit: number,
    task: (item: T) => Promise<unknown>,
) => {
    let next = 0
    let failure: { error: unknown } | undefined
    const worker = async () => {
        while (!failure && next < items.length) {
            const item = items[next++] as T
            try {
                await task(item)
            } catch (error) {
                failure ??= { error }
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    if (failure) throw failure.error
}

const widen = (span: Span, place: Place): Span =>
    span
        ? {
              low: comparePlaces(place, span.low) < 0 ? place : span.low,
              high: comparePlaces(place, span.high) > 0 ? place : span.high,
          }
        : { low: place, high: place }

/**
 * The chunk hashes of a kind on each side that the other side lacks. A kind other than slides
 * also gives the shared chunks whose span reaches a changed stack, and gives all of its chunks
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
        const unit = (hash: string, leaf = false): Unit => ({ hash, leaf, shared: false })
        if (!twoLevel) return (await chunksOf(node)).map((hash) => unit(hash))
        const kept = matched(node.children, other.children)
        const units: Unit[] = []
        for (const [i, leaf] of node.children.entries())
            if (kept[i]) units.push(unit(leaf, true))
            else for (const hash of await leafChunks(leaf)) units.push(unit(hash))
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
    ] as const)
        for (const [i, unit] of units.entries()) unit.shared = !!found[i]

    // The places of the stacks with a record in a changed chunk, sorted. A shared part whose span
    // reaches one of them is read on both sides, wherever it is: readers do not rely on the
    // writer's order.
    const changed = new Map<string, Place>()
    for (const unit of [...unitsA, ...unitsB])
        if (!unit.shared)
            for (const record of await read(unit.hash)) {
                const place = stackPlace(kind, record)
                changed.set(place.join(), place)
            }
    const places = [...changed.values()].sort(comparePlaces)
    // A place that does not compare could be anywhere.
    const everywhere = !places.every((place) => place.every(Number.isFinite))
    const reaches = (span: Span) => {
        if (!span) return false
        if (everywhere) return true
        let low = 0
        let high = places.length
        while (low < high) {
            const mid = (low + high) >> 1
            if (comparePlaces(need(places[mid]), span.low) < 0) low = mid + 1
            else high = mid
        }
        const place = places[low]
        return !!place && comparePlaces(place, span.high) <= 0
    }
    const chunkSpan = async (hash: string) => {
        const key = `${kind}:${hash}`
        if (spans.has(key)) return spans.get(key)
        let span: Span
        for (const record of await read(hash)) {
            const place = stackPlace(kind, record)
            if (!place.every(Number.isFinite))
                return remember(key, { low: [-Infinity, -Infinity], high: [Infinity, Infinity] })
            span = widen(span, place)
        }
        return remember(key, span)
    }
    const leafSpan = async (hash: string) => {
        const key = `${kind}:leaf:${hash}`
        if (spans.has(key)) return spans.get(key)
        let span: Span
        for (const chunk of await leafChunks(hash)) {
            const part = await chunkSpan(chunk)
            if (part) span = widen(widen(span, part.low), part.high)
        }
        return remember(key, span)
    }
    const listOf = async (units: readonly Unit[]) => {
        const list: string[] = []
        for (const { hash, leaf, shared } of units)
            if (!shared || (!leaf && reaches(await chunkSpan(hash)))) list.push(hash)
            else if (leaf && reaches(await leafSpan(hash)))
                for (const chunk of await leafChunks(hash))
                    if (reaches(await chunkSpan(chunk))) list.push(chunk)
        return list
    }
    // Every shared chunk's span is needed. Reading them a few at a time overlaps the reads, which
    // matters the first time a kind's spans are read.
    const unread: string[] = []
    for (const { hash, leaf, shared } of unitsA)
        if (shared && !(leaf && spans.has(`${kind}:leaf:${hash}`)))
            unread.push(...(leaf ? await leafChunks(hash) : [hash]))
    await eachLimited(unread, SPAN_READS, chunkSpan)
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
