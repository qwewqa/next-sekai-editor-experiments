import { inflateRaw } from 'pako'
import { isObject, parseJsonBytes } from '../nxsp/json'
import { checkPart, type SegmentForm } from '../nxsp/manifest'
import { PlanError, type PinnedSource, type PlannedEntry, type WritePlan } from '../nxsp/plan'

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
        parts.push(
            (checkPart(segment, `segments[${i}]`, false).part as SegmentForm | undefined) ??
                fail(`segment ${i}`),
        )
    parts.push(
        (checkPart(parsed.manifest, 'manifest', true).part as SegmentForm | undefined) ??
            fail('manifest'),
    )
    return parts
}

/** The plan's own `project.json`. */
export const plannedProject = (plan: WritePlan) => {
    const entry =
        plan.entries.find((each) => each.name === 'project.json') ?? fail('no project.json')
    const project = plannedJson(entry)
    return isObject(project) ? project : fail('project.json')
}

/**
 * The written file's history parts in order: the source's copied segments as their parsed values,
 * then the plan's new segments and manifest.
 */
export const plannedParts = (plan: WritePlan, source: PinnedSource | undefined): SegmentForm[] => {
    const history = plannedProject(plan).history
    if (!isObject(history)) return []
    const names = Array.isArray(history.segments) ? (history.segments as string[]) : []
    const copied = source ? sourceParts(source).slice(0, -1) : []
    const parts: SegmentForm[] = []
    for (const [i, name] of [...names, history.manifest as string].entries()) {
        const entry = plan.entries.find((each) => each.name === name) ?? fail(`no ${String(name)}`)
        const [part] = entry.parts
        if (part?.kind === 'copy')
            parts.push(copied[i] ?? fail(`${name} copies an unknown segment`))
        else parts.push(plannedJson(entry) as SegmentForm)
    }
    return parts
}

/** Throws a `PlanError` unless `plan` is an append to `source` (§1.6.11.6 step 3). */
export const assertAppend = (plan: WritePlan, source: PinnedSource) => {
    const project = isObject(source.projectJson) ? source.projectJson : fail('source project.json')
    const pointers = isObject(project.history) ? project.history : fail('the source has no history')
    const names = Array.isArray(pointers.segments) ? (pointers.segments as unknown[]) : []
    const entryOf = (name: unknown) => {
        const found = source.entries.filter((entry) => entry.name === name)
        return found.length === 1 && found[0] ? found[0] : fail(`source entry ${String(name)}`)
    }
    const planned = (name: string) => plan.entries.find((entry) => entry.name === name)

    // Every source segment, copied whole by entryCrc, in order and at its position.
    for (const [i, name] of names.entries()) {
        const from = entryOf(name)
        const entry =
            planned(`history/segments/${i + 1}.json`) ?? fail(`segment ${i + 1} is missing`)
        const [part] = entry.parts
        if (
            entry.parts.length !== 1 ||
            part?.kind !== 'copy' ||
            part.source !== source.token ||
            part.entryIndex !== from.index ||
            part.dataOffset !== from.dataOffset ||
            part.check.kind !== 'entryCrc' ||
            part.inflate
        )
            fail(`segment ${i + 1} is not a whole copy of the source’s`)
    }
    // `chunks.bin` begins with the source's, whole.
    const chunksFrom = entryOf(pointers.chunks)
    const chunks = planned('history/chunks.bin') ?? fail('no chunks.bin')
    const [prefix] = chunks.parts
    if (
        prefix?.kind !== 'copy' ||
        prefix.source !== source.token ||
        prefix.entryIndex !== chunksFrom.index ||
        prefix.dataOffset !== chunksFrom.dataOffset ||
        prefix.check.kind !== 'entryCrc' ||
        !!prefix.inflate !== (chunksFrom.method === 8) ||
        chunks.parts.slice(1).some((part) => part.kind !== 'bytes')
    )
        fail('chunks.bin does not begin with the source’s whole')

    // The source manifest's values, unchanged, at the start of the new parts.
    const old = sourceParts(source).at(-1) ?? fail('source manifest')
    const written = plannedParts(plan, source)
    const next = written[names.length] ?? fail('no part after the copied segments')
    if (!sameValue(next.entries.slice(0, old.entries.length), old.entries))
        fail('the source’s rows are not carried as they are')
    if (!sameValue(next.chunks.slice(0, old.chunks.length), old.chunks))
        fail('the source’s chunk index is not carried as it is')
    for (const [key, value] of Object.entries(old.roots))
        if (!sameValue(next.roots[key], value)) fail(`root ${key} is not carried`)
    for (const [key, value] of Object.entries(old.nodes))
        if (!sameValue(next.nodes[key], value)) fail(`node ${key} is not carried`)

    // `history.entries` is the source's plus the new rows.
    const history = plannedProject(plan).history
    const total = written.reduce((sum, part) => sum + part.entries.length, 0)
    if (
        !isObject(history) ||
        typeof pointers.entries !== 'number' ||
        history.entries !== total ||
        total < pointers.entries ||
        written.slice(0, names.length + 1).reduce((sum, part) => sum + part.entries.length, 0) <
            pointers.entries
    )
        fail('history.entries is not the source’s plus the new rows')
}
