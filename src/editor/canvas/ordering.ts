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

/**
 * Painter order and opacity for the main editor. An entity is drawn unless its
 * group/stage scope is hidden or its type is hidden (with other objects not
 * shown); it is drawn at full opacity only when both are fully visible.
 */
export const orderEntities = (
    entities: Entity[],
    selected: ReadonlySet<Entity>,
    visibility: EntityVisibility,
) =>
    entities
        .map((entity) => {
            const scope = entityScopeVisibility(entity, visibility.scope)
            const isVisibleByType = visibility.visibilities[entity.type]
            return {
                entity,
                isSelected: selected.has(entity),
                isDrawn: scope !== 'hidden' && (visibility.showOtherObjects || isVisibleByType),
                isFull: scope === 'full' && isVisibleByType,
                layer: getLayer(entity),
            }
        })
        .filter((info) => info.isDrawn)
        .sort(
            (a, b) =>
                +a.isSelected - +b.isSelected ||
                +a.isFull - +b.isFull ||
                a.layer - b.layer ||
                b.entity.beat - a.entity.beat,
        )
        .map((info) => ({
            entity: info.entity,
            highlighted: info.isSelected,
            opacity: info.isFull ? 1 : 0.25,
        }))

export type DrawStep = ReturnType<typeof orderEntities>[number] & { part?: EventPart }

/** Objects, with time scale markers above slides and notes, and the BPM and time scale labels. */
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
    // Time scale labels paint above every BPM label, as at their markers.
    return { objects: [...steps, ...markers], labels: [...bpmLabels, ...timeScaleLabels] }
}
