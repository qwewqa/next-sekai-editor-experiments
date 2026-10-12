import type { Entity, EntityType } from '../../state/entities'
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

const isFullyVisible = (entity: Entity, visibility: EntityVisibility) =>
    entityScopeVisibility(entity, visibility.scope) === 'full' &&
    visibility.visibilities[entity.type]

// The full event connections either side of selected joints, and their joints.
const raisedEntities = (
    entities: Entity[],
    selected: ReadonlySet<Entity>,
    visibility: EntityVisibility,
) => {
    const raised = new Set<Entity>()
    if (!selected.size) return raised
    for (const entity of entities) {
        // Only event connections have a min and max.
        if (!('min' in entity) || !(selected.has(entity.min) || selected.has(entity.max))) continue
        // Faint lines stay under, and so do their joints.
        if (!isFullyVisible(entity, visibility)) continue
        raised.add(entity).add(entity.min).add(entity.max)
    }
    return raised
}

/**
 * Painter order and opacity for the main editor. An entity is drawn unless its
 * group/stage scope is hidden or its type is hidden (with other objects not
 * shown); it is drawn at full opacity only when both are fully visible. The
 * lines either side of selected joints draw above unselected objects.
 */
export const orderEntities = (
    entities: Entity[],
    selected: ReadonlySet<Entity>,
    visibility: EntityVisibility,
) => {
    const raised = raisedEntities(entities, selected, visibility)
    return entities
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
                tier: isSelected ? 2 : raised.has(entity) && isFull ? 1 : 0,
                layer: getLayer(entity),
            }
        })
        .filter((info) => info.isDrawn)
        .sort(
            (a, b) =>
                a.tier - b.tier ||
                +a.isFull - +b.isFull ||
                a.layer - b.layer ||
                b.entity.beat - a.entity.beat,
        )
        .map((info) => ({
            entity: info.entity,
            highlighted: info.isSelected,
            raised: info.tier === 1,
            opacity: info.isFull ? 1 : 0.25,
        }))
}

export type DrawStep = ReturnType<typeof orderEntities>[number] & { part?: EventPart }

/**
 * Objects, with time scale markers above slides and notes, the index where the
 * raised and selected ones start, and the BPM and time scale labels.
 */
export const toDrawSteps = (ordered: ReturnType<typeof orderEntities>) => {
    const markers: DrawStep[] = []
    const bpmLabels: DrawStep[] = []
    const timeScaleLabels: DrawStep[] = []
    const steps = ordered.map((step): DrawStep => {
        const { type } = step.entity
        if (type === 'bpm') bpmLabels.push({ ...step, part: 'label' })
        else if (type === 'timeScale') {
            markers.push({ ...step, part: 'marker' })
            timeScaleLabels.push({ ...step, part: 'label' })
        } else return step
        return { ...step, part: 'line' }
    })
    const raisedAt = steps.findIndex(({ highlighted, raised }) => highlighted || raised)
    return {
        objects: [...steps, ...markers],
        raisedAt: raisedAt < 0 ? steps.length : raisedAt,
        // Time scale labels paint above every BPM label, as at their markers.
        labels: [...bpmLabels, ...timeScaleLabels],
    }
}
