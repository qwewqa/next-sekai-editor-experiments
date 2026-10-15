import type { Entity, EntityType } from '../../state/entities'
import type { Store } from '../../state/store'
import { isEntityInBeatRange } from '../entities/visibility'
import {
    chainOf,
    compareDrawKeys,
    drawKeyOf,
    orderEntities,
    toDrawSteps,
    type DrawStep,
    type EntityVisibility,
    type RaisedChains,
} from './ordering'

/** Complete source membership; camera motion never changes these arrays. */
export type DrawSection = {
    key: string
    steps: DrawStep[]
    pass: 'normal' | 'raised'
    minBeat: number
    maxBeat: number
    /** Unusual store tie orders use the existing visible traversal instead. */
    live?: boolean
}

export type SectionPlan = {
    source: Store
    sections: DrawSection[]
    labelSections: DrawSection[]
}

const spanOf = (entity: Entity): readonly [number, number] => {
    switch (entity.type) {
        case 'connector':
            return [entity.head.beat, entity.tail.beat]
        case 'cameraEventConnection':
        case 'stageMaskEventConnection':
        case 'stagePivotEventConnection':
        case 'stageStyleEventConnection':
        case 'stageTransformEventConnection':
            return [entity.min.beat, entity.max.beat]
        case 'bpm':
        case 'timeScale':
        case 'cameraEventJoint':
        case 'stageMaskEventJoint':
        case 'stagePivotEventJoint':
        case 'stageStyleEventJoint':
        case 'stageTransformEventJoint':
        case 'note':
            return [entity.beat, entity.beat]
    }
}

const sameStep = (a: DrawStep, b: DrawStep) =>
    a.entity === b.entity &&
    a.highlighted === b.highlighted &&
    a.raised === b.raised &&
    a.opacity === b.opacity &&
    a.part === b.part

type SourceGrid = ReadonlyMap<number, ReadonlySet<Entity>>
type Chain = NonNullable<ReturnType<typeof chainOf>>
type SourceChunk = {
    entities: Entity[]
    chains: Chain[]
    sections: DrawSection[]
    labels: DrawSection[]
    dirty: boolean
}
type TypeIndex = {
    grid: SourceGrid
    chunks: Map<number, SourceChunk>
    ambiguous: Set<Entity>
}

const isSpanning = (type: EntityType) => type === 'connector' || type.endsWith('Connection')
const sameEntities = (a: Entity[], b: Entity[]) =>
    a.length === b.length && a.every((entity, index) => entity === b[index])
const chunkChains = (entities: Entity[]): Chain[] => {
    // A source chunk contains one entity type, hence at most one chain family.
    // Cache unique keys when its membership changes, not on each selection.
    const first = entities[0] && chainOf(entities[0])
    if (!first) return []
    const keys = new Set<Chain[1]>()
    for (const entity of entities) {
        const chain = chainOf(entity)
        if (chain) keys.add(chain[1])
    }
    return [...keys].map((key) => [first[0], key])
}
const containsChain = (chains: RaisedChains, [type, key]: Chain) => {
    const keys = chains.get(type)
    return keys === 'all' || !!keys?.has(key)
}
const sameChains = (a: RaisedChains, b: RaisedChains) =>
    a.size === b.size &&
    [...a].every(([type, keys]) => {
        const next = b.get(type)
        return keys === 'all'
            ? next === 'all'
            : next !== undefined &&
                  next !== 'all' &&
                  keys.size === next.size &&
                  [...keys].every((key) => next.has(key))
    })
const compareSections = (a: DrawSection, b: DrawSection) => {
    const firstA = a.steps[0]
    const firstB = b.steps[0]
    return firstA && firstB ? compareDrawKeys(drawKeyOf(firstA), drawKeyOf(firstB)) : 0
}

/** One current source index serves both immutable edits and selection changes. */
export class SectionPlanner {
    private indexes = new Map<EntityType, TypeIndex>()
    private selected = new Set<Entity>()
    private visibility?: EntityVisibility
    private chains: RaisedChains = new Map()
    readonly stats = {
        builds: 0,
        entities: 0,
        sections: 0,
        liveSections: 0,
        // Per-build work, not timing: source visits may include the span tie audit.
        sourceBuckets: 0,
        sourceEntities: 0,
        projectedEntities: 0,
        projectedChunks: 0,
        spanningFamilies: 0,
    }

    constructor(readonly bucketBeats = 4) {
        if (!Number.isFinite(bucketBeats) || bucketBeats <= 0)
            throw new RangeError('Section length must be positive and finite')
    }

    private chunkOf(entity: Entity) {
        return Math.floor(entity.beat / this.bucketBeats)
    }

    private visit(bucket: ReadonlySet<Entity> | undefined) {
        if (bucket) {
            this.stats.sourceBuckets++
            this.stats.sourceEntities += bucket.size
        }
        return bucket ?? []
    }

    private replaceChunk(index: TypeIndex, key: number, entities: Entity[]) {
        const old = index.chunks.get(key)
        if (!entities.length) index.chunks.delete(key)
        else if (!old || !sameEntities(old.entities, entities))
            index.chunks.set(key, {
                entities,
                chains: chunkChains(entities),
                sections: old?.sections ?? [],
                labels: old?.labels ?? [],
                dirty: true,
            })
    }

    private refreshFamily(index: TypeIndex, grid: SourceGrid, spanning: boolean) {
        const buckets = [...grid.keys()].filter(Number.isFinite).sort((a, b) => a - b)
        const ranks = new Map<Entity, number>()
        for (const key of buckets)
            for (const entity of this.visit(grid.get(key)))
                if (!ranks.has(entity)) ranks.set(entity, ranks.size)
        const ties = new Set<number>()
        if (spanning) {
            this.stats.spanningFamilies++
            // Later buckets can reverse an equal-beat tie without changing membership.
            // Keep the existing full-family audit for edited spanning geometry.
            for (const key of buckets) {
                const previous = new Map<number, number>()
                for (const entity of this.visit(grid.get(key))) {
                    const rank = ranks.get(entity)
                    if (rank === undefined) continue
                    const last = previous.get(entity.beat)
                    if (last !== undefined && rank < last) ties.add(entity.beat)
                    previous.set(entity.beat, rank)
                }
            }
        }
        const grouped = new Map<number, Entity[]>()
        const ambiguous = new Set<Entity>()
        for (const entity of ranks.keys()) {
            const key = this.chunkOf(entity)
            let entities = grouped.get(key)
            if (!entities) grouped.set(key, (entities = []))
            entities.push(entity)
            if (ties.has(entity.beat)) ambiguous.add(entity)
        }
        for (const key of index.chunks.keys()) if (!grouped.has(key)) index.chunks.delete(key)
        for (const [key, entities] of grouped) {
            this.replaceChunk(index, key, entities)
            const chunk = index.chunks.get(key)
            if (
                chunk &&
                entities.some((entity) => index.ambiguous.has(entity) !== ambiguous.has(entity))
            )
                chunk.dirty = true
        }
        index.ambiguous = ambiguous
    }

    private sync(type: EntityType, grid: SourceGrid) {
        let index = this.indexes.get(type)
        if (index?.grid === grid) return index
        if (!index) {
            index = { grid, chunks: new Map(), ambiguous: new Set() }
            this.indexes.set(type, index)
            this.refreshFamily(index, grid, isSpanning(type))
        } else if (isSpanning(type)) {
            this.refreshFamily(index, grid, true)
        } else {
            // Transactions can clone a Map on read. Set identity distinguishes a
            // real bucket edit, including undo and redo, without history metadata.
            const keys = [...new Set([...index.grid.keys(), ...grid.keys()])]
                .filter(Number.isFinite)
                .sort((a, b) => a - b)
            const dirty = new Set<number>()
            for (const key of keys) {
                const before = index.grid.get(key)
                const after = grid.get(key)
                if (before === after) continue
                for (const bucket of [before, after])
                    for (const entity of this.visit(bucket)) dirty.add(this.chunkOf(entity))
            }
            for (const key of dirty) {
                const entities: Entity[] = []
                const min = Math.floor(key * this.bucketBeats) - 1
                const max = Math.ceil((key + 1) * this.bucketBeats) + 1
                for (const bucket of keys) {
                    // The exact filter also supports fractional chunk widths.
                    if (
                        Number.isFinite(min) &&
                        Number.isFinite(max) &&
                        (bucket < min || bucket > max)
                    )
                        continue
                    for (const entity of this.visit(grid.get(bucket)))
                        if (this.chunkOf(entity) === key) entities.push(entity)
                }
                this.replaceChunk(index, key, entities)
            }
        }
        index.grid = grid
        return index
    }

    private project(
        chunk: SourceChunk,
        index: TypeIndex,
        selected: ReadonlySet<Entity>,
        visibility: EntityVisibility,
        chains: RaisedChains,
    ) {
        const ordered = toDrawSteps(orderEntities(chunk.entities, selected, visibility, chains))
        const previous = new Map(
            [...chunk.sections, ...chunk.labels].map((section) => [section.key, section]),
        )
        const group = (steps: DrawStep[], labels: boolean) => {
            const sections: DrawSection[] = []
            for (const step of steps) {
                const { tier, isFull, layer, beat } = drawKeyOf(step)
                const pass = tier ? 'raised' : 'normal'
                const key = `${labels ? 'label' : 'body'}:${pass}:${tier}:${+isFull}:${layer}:${Math.floor(beat / this.bucketBeats)}`
                let section = sections[sections.length - 1]
                const [min, max] = spanOf(step.entity)
                if (section?.key !== key) {
                    section = { key, steps: [], pass, minBeat: min, maxBeat: max }
                    sections.push(section)
                }
                section.steps.push(step)
                section.minBeat = Math.min(section.minBeat, min)
                section.maxBeat = Math.max(section.maxBeat, max)
                if (index.ambiguous.has(step.entity)) section.live = true
            }
            return sections.map((section) => {
                const old = previous.get(section.key)
                return old &&
                    old.live === section.live &&
                    old.minBeat === section.minBeat &&
                    old.maxBeat === section.maxBeat &&
                    old.steps.length === section.steps.length &&
                    old.steps.every((step, i) => {
                        const current = section.steps[i]
                        return current !== undefined && sameStep(step, current)
                    })
                    ? old
                    : section
            })
        }
        chunk.sections = group(ordered.objects, false)
        chunk.labels = group(ordered.labels, true)
        chunk.dirty = false
        this.stats.projectedEntities += chunk.entities.length
        this.stats.projectedChunks++
    }

    build(
        source: Store,
        selected: ReadonlySet<Entity>,
        visibility: EntityVisibility,
        chains: RaisedChains,
    ): SectionPlan {
        this.stats.sourceBuckets = 0
        this.stats.sourceEntities = 0
        this.stats.projectedEntities = 0
        this.stats.projectedChunks = 0
        this.stats.spanningFamilies = 0
        // Read every input on every build, including no-op builds: Vue must keep
        // tracking in-place visibility/chain edits after a localized fast path.
        const snapshot: EntityVisibility = {
            scope: visibility.scope,
            visibilities: { ...visibility.visibilities },
            showOtherObjects: visibility.showOtherObjects,
        }
        const nextChains: RaisedChains = new Map(
            [...chains].map(([type, keys]) => [type, keys === 'all' ? 'all' : new Set(keys)]),
        )
        const nextSelected = new Set(selected)
        const broad =
            this.visibility?.scope !== snapshot.scope ||
            this.visibility.showOtherObjects !== snapshot.showOtherObjects ||
            Object.keys(snapshot.visibilities).some(
                (type) =>
                    this.visibility?.visibilities[type as EntityType] !==
                    snapshot.visibilities[type as EntityType],
            )
        const chainsChanged = !sameChains(this.chains, nextChains)
        const changedChunks = new Map<EntityType, Set<number>>()
        for (const [before, after] of [
            [this.selected, nextSelected],
            [nextSelected, this.selected],
        ] as const)
            for (const entity of before)
                if (!after.has(entity)) {
                    let keys = changedChunks.get(entity.type)
                    if (!keys) changedChunks.set(entity.type, (keys = new Set()))
                    keys.add(this.chunkOf(entity))
                }
        const sections: DrawSection[] = []
        const labelSections: DrawSection[] = []
        this.stats.entities = 0
        for (const type of Object.keys(source.grid) as EntityType[]) {
            const index = this.sync(type, source.grid[type])
            const changed = changedChunks.get(type)
            for (const [key, chunk] of index.chunks) {
                if (
                    broad ||
                    chunk.dirty ||
                    changed?.has(key) ||
                    (chainsChanged &&
                        chunk.chains.length > 0 &&
                        chunk.chains.some(
                            (chain) =>
                                containsChain(this.chains, chain) !==
                                containsChain(nextChains, chain),
                        ))
                )
                    this.project(chunk, index, nextSelected, snapshot, nextChains)
                sections.push(...chunk.sections)
                labelSections.push(...chunk.labels)
                this.stats.entities += chunk.entities.length
            }
        }
        sections.sort(compareSections)
        // Labels have a separate painter contract: every BPM before every time scale.
        labelSections.sort(
            (a, b) =>
                +(a.steps[0]?.entity.type === 'timeScale') -
                    +(b.steps[0]?.entity.type === 'timeScale') || compareSections(a, b),
        )
        this.selected = nextSelected
        this.visibility = snapshot
        this.chains = nextChains
        this.stats.builds++
        this.stats.sections = sections.length
        this.stats.liveSections = sections.filter((section) => section.live).length
        return { source, sections, labelSections }
    }
}

/** Exact-visible metadata stays separate from the complete body membership. */
export const selectSections = (
    plan: SectionPlan,
    min: number,
    max: number,
    minKey = Math.floor(min),
    maxKey = Math.floor(max),
) => {
    const sections = plan.sections.filter(
        (section) => section.minBeat <= max && section.maxBeat >= min,
    )
    let ranks: Map<Entity, number> | undefined
    if (sections.some((section) => section.live)) {
        ranks = new Map()
        for (const map of Object.values(plan.source.grid))
            for (let key = minKey; key <= maxKey; key++) {
                const bucket = map.get(key)
                if (!bucket) continue
                for (const entity of bucket) if (!ranks.has(entity)) ranks.set(entity, ranks.size)
            }
    }
    const visibleBySection = new Map<DrawSection, DrawStep[]>()
    const objects: DrawStep[] = []
    const owners = new Set<Entity>()
    for (const section of sections) {
        const visible = section.steps.filter((step) => isEntityInBeatRange(step.entity, min, max))
        if (section.live && ranks)
            visible.sort(
                (a, b) =>
                    b.entity.beat - a.entity.beat ||
                    (ranks.get(a.entity) ?? 0) - (ranks.get(b.entity) ?? 0),
            )
        visibleBySection.set(section, visible)
        for (const step of visible) {
            objects.push(step)
            owners.add(step.entity)
        }
    }
    const labels: DrawStep[] = []
    for (const section of plan.labelSections) {
        if (section.minBeat > max || section.maxBeat < min) continue
        for (const step of section.steps)
            if (isEntityInBeatRange(step.entity, min, max)) labels.push(step)
    }
    const raisedAt = objects.findIndex((step) => step.highlighted || step.raised)
    return {
        sections,
        visibleBySection,
        owners,
        objects,
        raisedAt: raisedAt < 0 ? objects.length : raisedAt,
        labels,
    }
}
