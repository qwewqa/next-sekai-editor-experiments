import { inflateRaw } from 'pako'
import { isObject, parseJsonBytes } from '../nxsp/json'
import { checkPart, type SegmentForm } from '../nxsp/manifest'
import {
    PlanError,
    type PinnedSource,
    type PlannedEntry,
    type PlanPart,
    type WritePlan,
} from '../nxsp/plan'

// The append assertion (Part 1 §1.6.11.6 step 3, r12-history-critique §3.2): an independent check
// that a plan is an append, run before it's executed. The builder's layout makes it hold by
// construction; this check reads only the plan and the source's metadata, so a builder bug (or a
// test hook that alters the plan) fails as a plan error, with nothing written.

const fail = (message: string): never => {
    throw new PlanError(`Not an append: ${message}`)
}

/** A planned entry's JSON when it's one `bytes` part (deflated for method 8). */
const plannedJson = (entry: PlannedEntry): unknown => {
    const [part] = entry.parts
    if (entry.parts.length !== 1 || part?.kind !== 'bytes')
        return fail(`${entry.name} is not new bytes`)
    return parseJsonBytes(entry.method === 8 ? inflateRaw(part.data) : part.data)
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The source's parts in order, each checked: its segments, then its manifest. */
export const sourceParts = (source: PinnedSource): SegmentForm[] => {
    const parsed = source.manifest ?? fail('the source has no history')
    const parts: SegmentForm[] = []
    for (const [i, segment] of parsed.segments.entries())
        parts.push(checkPart(segment, `segments[${i}]`, false).part ?? fail(`segment ${i}`))
    parts.push(checkPart(parsed.manifest, 'manifest', true).part ?? fail('manifest'))
    return parts
}

/** The source's history pointers and its segments' entries, in `history.segments` order. */
const sourceHistory = (source: PinnedSource) => {
    const project = isObject(source.projectJson) ? source.projectJson : fail('source project.json')
    const pointers = isObject(project.history) ? project.history : fail('the source has no history')
    const entryOf = (name: unknown) => {
        const found = source.entries.filter((entry) => entry.name === name)
        return found.length === 1 && found[0] ? found[0] : fail(`source entry ${String(name)}`)
    }
    const names = Array.isArray(pointers.segments) ? (pointers.segments as unknown[]) : []
    return { pointers, entryOf, segments: names.map(entryOf) }
}

/** A part that copies a source entry whole, by its index and offset (checked by its CRC). */
const isWholeCopy = (
    part: PlanPart | undefined,
    source: PinnedSource,
    from: { index: number; dataOffset: number },
): part is Extract<PlanPart, { kind: 'copy' }> =>
    part?.kind === 'copy' &&
    part.source === source.token &&
    part.entryIndex === from.index &&
    part.dataOffset === from.dataOffset

/** The plan's own `project.json`. */
export const plannedProject = (plan: WritePlan) => {
    const entry =
        plan.entries.find((each) => each.name === 'project.json') ?? fail('no project.json')
    const project = plannedJson(entry)
    return isObject(project) ? project : fail('project.json')
}

/**
 * The written file's history parts in order, by the planned `project.json`'s names: a copy of the
 * source's i-th segment, by its entry index, as that segment's parsed value (copies only at the
 * source's positions), else the plan's new segment or manifest.
 */
export const plannedParts = (plan: WritePlan, source: PinnedSource | undefined): SegmentForm[] => {
    const history = plannedProject(plan).history
    if (!isObject(history)) return []
    const names = Array.isArray(history.segments) ? (history.segments as unknown[]) : []
    const copied = source ? sourceParts(source).slice(0, -1) : []
    const copiedEntries = source ? sourceHistory(source).segments : []
    const parts: SegmentForm[] = []
    for (const [i, name] of [...names, history.manifest].entries()) {
        const entry = plan.entries.find((each) => each.name === name) ?? fail(`no ${String(name)}`)
        const [part] = entry.parts
        if (part?.kind === 'copy') {
            const from = copiedEntries[i]
            if (
                !source ||
                i >= names.length ||
                !from ||
                entry.parts.length !== 1 ||
                part.entryIndex !== from.index
            )
                fail(`${entry.name} copies something other than the source’s segment ${i + 1}`)
            parts.push(copied[i] ?? fail(`${entry.name} copies an unknown segment`))
        } else parts.push(plannedJson(entry) as SegmentForm)
    }
    return parts
}

/** Throws a `PlanError` unless `plan` is an append to `source` (§1.6.11.6 step 3). */
export const assertAppend = (plan: WritePlan, source: PinnedSource) => {
    const { pointers, entryOf, segments } = sourceHistory(source)
    const planned = (name: unknown) => {
        const found = plan.entries.filter((entry) => entry.name === name)
        return found.length === 1 ? found[0] : undefined
    }
    const history = plannedProject(plan).history
    if (!isObject(history)) return fail('the plan has no history')
    const names = Array.isArray(history.segments) ? (history.segments as unknown[]) : []

    // Every source segment, copied whole by entryCrc, in order and at its position, under the
    // names the planned `project.json` gives first.
    for (const [i, from] of segments.entries()) {
        const name = `history/segments/${i + 1}.json`
        if (names[i] !== name) fail(`history.segments[${i}] is not ${name}`)
        const entry = planned(name) ?? fail(`segment ${i + 1} is missing`)
        const [part] = entry.parts
        if (entry.parts.length !== 1 || !isWholeCopy(part, source, from) || part.inflate)
            fail(`segment ${i + 1} is not a whole copy of the source’s`)
    }
    const listed = [...names, history.manifest, history.chunks]
    if (new Set(listed).size !== listed.length || listed.some((name) => typeof name !== 'string'))
        fail('the history’s entry names')

    // `chunks.bin`, as the planned `project.json` names it, begins with the source's, whole.
    const chunksFrom = entryOf(pointers.chunks)
    const chunks = planned(history.chunks) ?? fail('no chunks.bin')
    const [prefix] = chunks.parts
    if (
        !isWholeCopy(prefix, source, chunksFrom) ||
        !!prefix.inflate !== (chunksFrom.method === 8) ||
        chunks.parts.slice(1).some((part) => part.kind !== 'bytes')
    )
        fail('chunks.bin does not begin with the source’s whole')

    // The source manifest's values, unchanged, at the start of the new parts.
    const old = sourceParts(source).at(-1) ?? fail('source manifest')
    const written = plannedParts(plan, source)
    const next = written[segments.length] ?? fail('no part after the copied segments')
    if (!sameValue(next.entries.slice(0, old.entries.length), old.entries))
        fail('the source’s rows are not carried as they are')
    if (!sameValue(next.chunks.slice(0, old.chunks.length), old.chunks))
        fail('the source’s chunk index is not carried as it is')
    for (const [key, value] of Object.entries(old.roots))
        if (!sameValue(next.roots[key], value)) fail(`root ${key} is not carried`)
    for (const [key, value] of Object.entries(old.nodes))
        if (!sameValue(next.nodes[key], value)) fail(`node ${key} is not carried`)

    // `history.entries` is the source's plus the new rows.
    const total = written.reduce((sum, part) => sum + part.entries.length, 0)
    const kept = written
        .slice(0, segments.length + 1)
        .reduce((sum, part) => sum + part.entries.length, 0)
    if (
        typeof pointers.entries !== 'number' ||
        history.entries !== total ||
        kept < pointers.entries
    )
        fail('history.entries is not the source’s plus the new rows')
}
