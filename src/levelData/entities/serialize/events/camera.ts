import { EngineArchetypeDataName, type LevelDataEntity } from '@sonolus/core'
import { serializeEventsToLevelDataEntities } from '.'
import { getStoreEntities } from '..'
import { easeValues } from '../../../../ease'
import type { OrderedStore } from '../../../../local/records/extract'
import type { Store } from '../../../../state/store'

export const serializeCameraEventsToLevelDataEntities = (
    isDynamicStages: boolean,
    initialization: LevelDataEntity,
    store: Store,
    ordered: OrderedStore,
    getName: () => string,
) => {
    if (!isDynamicStages) return []

    const entities = serializeEventsToLevelDataEntities(
        ordered.cameraEvents.map(({ entity }) => entity),
        getStoreEntities(store.grid.cameraEventConnection),
        getName,
        (joint) => ({
            archetype: 'CameraChange',
            data: [
                {
                    name: EngineArchetypeDataName.Beat,
                    value: joint.beat,
                },
                {
                    name: 'lane',
                    value: joint.cameraLeft + joint.cameraSize / 2,
                },
                {
                    name: 'size',
                    value: joint.cameraSize / 2,
                },
                {
                    name: 'zoom',
                    value: joint.cameraZoom,
                },
                {
                    name: 'zoomTargetLane',
                    value: joint.cameraZoomTargetLane,
                },
                {
                    name: 'zoomTargetY',
                    value: joint.cameraZoomTargetY,
                },
                {
                    name: 'zoomVerticalAlign',
                    value: zoomVerticalAligns[joint.cameraZoomVerticalAlign],
                },
                {
                    name: 'rotate',
                    value: joint.cameraRotation,
                },
                {
                    name: 'stageTilt',
                    value: joint.cameraStageTilt,
                },
                {
                    name: 'ease',
                    value: easeValues[joint.eventEase],
                },
            ],
        }),
    )

    const range = store.globalEventRanges.cameraEventJoint
    if (range) {
        const first = entities.get(range.min)
        if (!first) throw new Error('Unexpected missing joint')

        initialization.data.push({
            name: 'firstCamera',
            ref: (first.name ??= getName()),
        })
    }

    return entities.values()
}

const zoomVerticalAligns = {
    default: 0,
    center: 1,
}
