import type { GroupId } from '../../chart/groups'
import type { StageId } from '../../chart/stages'
import type { State } from '../../state'
import type { Entity, EntityType } from '../../state/entities'
import type { EventJointEntityType } from '../../state/entities/events/joints'
import { entityScopeVisibility, type ScopeLookup } from '../scopeRules'
import type { ToolName } from '../tools'
import type { EventPart } from './events'

const layers = {
    timeScale: 0,
    bpm: 1,

    cameraEventConnection: 10,
    cameraEventJoint: 11,

    stageMaskEventConnection: 12,
    stageMaskEventJoint: 13,

    stagePivotEventConnection: 14,
    stagePivotEventJoint: 15,

    stageStyleEventConnection: 16,
    stageStyleEventJoint: 17,

    stageTransformEventConnection: 18,
    stageTransformEventJoint: 19,

    // A time scale's marker; its line is under everything.
    timeScaleMarker: 19.5,

    connector: {
        under: {
            active: 20,
            damage: 21,
            guide: 22,
        },
        bottom: {
            active: 23,
            damage: 24,
            guide: 25,
        },
        top: {
            active: 26,
            damage: 27,
            guide: 28,
        },
        over: {
            active: 40,
            damage: 41,
            guide: 42,
        },
    },

    note: 30,
}

const getLayer = (entity: Entity) => {
    switch (entity.type) {
        case 'bpm':
        case 'cameraEventJoint':
        case 'cameraEventConnection':
        case 'stageMaskEventJoint':
        case 'stageMaskEventConnection':
        case 'stagePivotEventJoint':
        case 'stagePivotEventConnection':
        case 'stageStyleEventJoint':
        case 'stageStyleEventConnection':
        case 'stageTransformEventJoint':
        case 'stageTransformEventConnection':
        case 'timeScale':
        case 'note':
            return layers[entity.type]
        case 'connector':
            return layers.connector[entity.head.connectorLayer][entity.head.connectorType]
    }
}

export type EntityVisibility = {
    scope: ScopeLookup
    visibilities: Record<EntityType, boolean>
    showOtherObjects: boolean
}

type ChainType = EventJointEntityType | 'timeScale'
type ChainKey = StageId | GroupId | undefined

/**
 * Chain types with a selected joint, and their keys: an event's stage (camera's is undefined)
 * or a time scale's group. A tool working on every stage or group raises all of its type.
 */
export type RaisedChains = ReadonlyMap<ChainType, ReadonlySet<ChainKey> | 'all'>

/** The chains a tool raises: its type, and one key or every key. */
export type ToolChain = readonly [ChainType, ChainKey | 'all']

const toolChainTypes: Partial<Record<ToolName, ChainType>> = {
    cameraEvent: 'cameraEventJoint',
    stageMaskEvent: 'stageMaskEventJoint',
    stagePivotEvent: 'stagePivotEventJoint',
    stageStyleEvent: 'stageStyleEventJoint',
    stageTransformEvent: 'stageTransformEventJoint',
    timeScale: 'timeScale',
}

/** The chains a tool works on: the current stage's or group's, every one's under All; camera's one. */
export const toolChainOf = (
    tool: ToolName,
    stageId: StageId | undefined,
    groupId: GroupId | undefined,
): ToolChain | undefined => {
    const type = toolChainTypes[tool]
    if (!type) return
    if (type === 'cameraEventJoint') return [type, undefined]
    return [type, (type === 'timeScale' ? groupId : stageId) ?? 'all']
}

// The chain an entity is in; a connection is in its min's.
export const chainOf = (entity: Entity): [ChainType, ChainKey] | undefined => {
    switch (entity.type) {
        case 'cameraEventJoint':
            return [entity.type, undefined]
        case 'stageMaskEventJoint':
        case 'stagePivotEventJoint':
        case 'stageStyleEventJoint':
        case 'stageTransformEventJoint':
            return [entity.type, entity.stageId]
        case 'timeScale':
            return [entity.type, entity.groupId]
        case 'cameraEventConnection':
        case 'stageMaskEventConnection':
        case 'stagePivotEventConnection':
        case 'stageStyleEventConnection':
        case 'stageTransformEventConnection':
            return chainOf(entity.min)
        case 'bpm':
        case 'note':
        case 'connector':
            return undefined
    }
}

/** The chains of the selected joints, and the tool's. */
export const raisedChains = (selected: Iterable<Entity>, tool?: ToolChain): RaisedChains => {
    const chains = new Map<ChainType, Set<ChainKey> | 'all'>()
    const raise = (type: ChainType, key: ChainKey | 'all') => {
        const keys = chains.get(type)
        if (keys === 'all') return
        chains.set(type, key === 'all' ? 'all' : (keys ?? new Set()).add(key))
    }
    for (const entity of selected) {
        const chain = chainOf(entity)
        if (chain) raise(...chain)
    }
    if (tool) raise(...tool)
    return chains
}

export type Raised = { selected: ReadonlySet<Entity>; chains: RaisedChains }

// Keyed on the selection array, which a committed state never mutates, for the latest tool.
const bySelection = new WeakMap<readonly Entity[], { tool?: ToolChain; raised: Raised }>()

/** A state's selection as a set, with its raised chains and the tool's. */
export const raisedOf = ({ selectedEntities }: State, tool?: ToolChain): Raised => {
    const cached = bySelection.get(selectedEntities)
    if (cached && cached.tool?.[0] === tool?.[0] && cached.tool?.[1] === tool?.[1])
        return cached.raised
    const raised = {
        selected: new Set(selectedEntities),
        chains: raisedChains(selectedEntities, tool),
    }
    bySelection.set(selectedEntities, { tool, raised })
    return raised
}

/** Whether an event joint, connection or time scale is in a raised chain. */
export const isInRaisedChain = (chains: RaisedChains, entity: Entity) => {
    if (!chains.size) return false
    const chain = chainOf(entity)
    if (!chain) return false
    const keys = chains.get(chain[0])
    return keys === 'all' || !!keys?.has(chain[1])
}

type DrawKey = { tier: number; isFull: boolean; layer: number; beat: number }

// Selected above raised above the rest, faded under full, by layer, earlier beats on top.
export const compareDrawKeys = (a: DrawKey, b: DrawKey) =>
    a.tier - b.tier || +a.isFull - +b.isFull || a.layer - b.layer || b.beat - a.beat

/**
 * Painter order and opacity for the main editor. An entity is drawn unless its
 * group/stage scope is hidden or its type is hidden (with other objects not
 * shown); it is drawn at full opacity only when both are fully visible. The
 * full joints and lines of event chains with a selected joint draw above
 * unselected objects.
 */
export const orderEntities = (
    entities: Entity[],
    selected: ReadonlySet<Entity>,
    visibility: EntityVisibility,
    chains = raisedChains(selected),
) =>
    entities
        .map((entity) => {
            const scope = entityScopeVisibility(entity, visibility.scope)
            const isVisibleByType = visibility.visibilities[entity.type]
            const isSelected = selected.has(entity)
            const isFull = scope === 'full' && isVisibleByType
            return {
                entity,
                isSelected,
                isDrawn: scope !== 'hidden' && (visibility.showOtherObjects || isVisibleByType),
                isFull,
                tier: isSelected ? 2 : isFull && isInRaisedChain(chains, entity) ? 1 : 0,
                layer: getLayer(entity),
                beat: entity.beat,
            }
        })
        .filter((info) => info.isDrawn)
        .sort(compareDrawKeys)
        .map((info) => ({
            entity: info.entity,
            highlighted: info.isSelected,
            raised: info.tier === 1,
            opacity: info.isFull ? 1 : 0.25,
        }))

export type DrawStep = ReturnType<typeof orderEntities>[number] & { part?: EventPart }

export const drawKeyOf = (step: DrawStep): DrawKey => ({
    tier: step.highlighted ? 2 : step.raised ? 1 : 0,
    isFull: step.opacity === 1,
    layer: step.part === 'marker' ? layers.timeScaleMarker : getLayer(step.entity),
    beat: step.entity.beat,
})

/**
 * Objects, with time scale markers above event joints, the index where the
 * raised and selected ones start, and the BPM and time scale labels.
 */
export const toDrawSteps = (ordered: ReturnType<typeof orderEntities>) => {
    const bpmLabels: DrawStep[] = []
    const timeScaleLabels: DrawStep[] = []
    const objects: DrawStep[] = []
    const markers: { step: DrawStep; key: DrawKey }[] = []
    for (const step of ordered) {
        const { type } = step.entity
        if (type === 'bpm') {
            bpmLabels.push({ ...step, part: 'label' })
            objects.push({ ...step, part: 'line' })
        } else if (type === 'timeScale') {
            timeScaleLabels.push({ ...step, part: 'label' })
            objects.push({ ...step, part: 'line' })
            const marker: DrawStep = { ...step, part: 'marker' }
            markers.push({ step: marker, key: drawKeyOf(marker) })
        } else objects.push(step)
    }
    // Only time scale markers change layer. Objects and markers each retain
    // their sorted order, so merge them without sorting the entire view again.
    const steps = markers.length ? [] : objects
    if (markers.length) {
        let index = 0
        for (const object of objects) {
            if (index < markers.length) {
                const key = drawKeyOf(object)
                while (index < markers.length) {
                    const marker = markers[index]
                    if (!marker || compareDrawKeys(marker.key, key) >= 0) break
                    steps.push(marker.step)
                    index++
                }
            }
            steps.push(object)
        }
        for (; index < markers.length; index++) {
            const marker = markers[index]
            if (marker) steps.push(marker.step)
        }
    }
    const raisedAt = steps.findIndex(({ highlighted, raised }) => highlighted || raised)
    return {
        objects: steps,
        raisedAt: raisedAt < 0 ? steps.length : raisedAt,
        // Time scale labels paint above every BPM label, as at their markers.
        labels: [...bpmLabels, ...timeScaleLabels],
    }
}
