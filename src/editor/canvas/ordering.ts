import type { GroupId } from '../../chart/groups'
import type { StageId } from '../../chart/stages'
import type { State } from '../../state'
import type { Entity, EntityType } from '../../state/entities'
import type { EventJointEntityType } from '../../state/entities/events/joints'
import { entityScopeVisibility, type ScopeLookup } from '../scopeRules'
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
 * or a time scale's group.
 */
export type RaisedChains = ReadonlyMap<ChainType, ReadonlySet<ChainKey>>

// The chain an entity is in; a connection is in its min's.
const chainOf = (entity: Entity): [ChainType, ChainKey] | undefined => {
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

export const raisedChains = (selected: Iterable<Entity>): RaisedChains => {
    const chains = new Map<ChainType, Set<ChainKey>>()
    for (const entity of selected) {
        const chain = chainOf(entity)
        if (!chain) continue
        const [type, key] = chain
        chains.set(type, (chains.get(type) ?? new Set()).add(key))
    }
    return chains
}

export type Raised = { selected: ReadonlySet<Entity>; chains: RaisedChains }

// Keyed on the selection array, which a committed state never mutates.
const bySelection = new WeakMap<readonly Entity[], Raised>()

/** A state's selection as a set, with its raised chains. */
export const raisedOf = ({ selectedEntities }: State): Raised => {
    let raised = bySelection.get(selectedEntities)
    if (!raised) {
        raised = { selected: new Set(selectedEntities), chains: raisedChains(selectedEntities) }
        bySelection.set(selectedEntities, raised)
    }
    return raised
}

/** Whether an event joint, connection or time scale is in a chain with a selected one. */
export const isInRaisedChain = (chains: RaisedChains, entity: Entity) => {
    if (!chains.size) return false
    const chain = chainOf(entity)
    return !!chain && !!chains.get(chain[0])?.has(chain[1])
}

type DrawKey = { tier: number; isFull: boolean; layer: number; beat: number }

// Selected above raised above the rest, faded under full, by layer, earlier beats on top.
const compareDrawKeys = (a: DrawKey, b: DrawKey) =>
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

const drawKeyOf = (step: DrawStep): DrawKey => ({
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
    const steps = ordered
        .flatMap((step): DrawStep[] => {
            const { type } = step.entity
            if (type === 'bpm') {
                bpmLabels.push({ ...step, part: 'label' })
                return [{ ...step, part: 'line' }]
            }
            if (type !== 'timeScale') return [step]
            timeScaleLabels.push({ ...step, part: 'label' })
            return [
                { ...step, part: 'line' },
                { ...step, part: 'marker' },
            ]
        })
        // Markers move to their layer; the rest keep their order.
        .map((step) => ({ step, key: drawKeyOf(step) }))
        .sort((a, b) => compareDrawKeys(a.key, b.key))
        .map(({ step }) => step)
    const raisedAt = steps.findIndex(({ highlighted, raised }) => highlighted || raised)
    return {
        objects: steps,
        raisedAt: raisedAt < 0 ? steps.length : raisedAt,
        // Time scale labels paint above every BPM label, as at their markers.
        labels: [...bpmLabels, ...timeScaleLabels],
    }
}
