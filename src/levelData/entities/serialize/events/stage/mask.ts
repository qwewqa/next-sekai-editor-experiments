import { EngineArchetypeDataName, type LevelDataEntity } from '@sonolus/core'
import { serializeStageEventsToLevelDataEntities } from '.'
import { getStoreEntities } from '../..'
import type { StageId } from '../../../../../chart/stages'
import { easeValues } from '../../../../../ease'
import type { OrderedStore } from '../../../../../local/records/extract'
import type { Store } from '../../../../../state/store'

export const serializeStageMaskEventsToLevelDataEntities = (
    isDynamicStages: boolean,
    stageEntities: Map<StageId, LevelDataEntity> | undefined,
    store: Store,
    ordered: OrderedStore,
    getName: () => string,
) => {
    if (!isDynamicStages) return []

    return serializeStageEventsToLevelDataEntities(
        ordered.stageMaskEvents.map(({ entity }) => entity),
        getStoreEntities(store.grid.stageMaskEventConnection),
        store.stageEventRanges.stageMaskEventJoint,
        getName,
        (joint) => ({
            archetype: 'StageMaskChange',
            data: [
                {
                    name: EngineArchetypeDataName.Beat,
                    value: joint.beat,
                },
                {
                    name: 'lane',
                    value: joint.maskLeft + joint.maskSize / 2,
                },
                {
                    name: 'size',
                    value: joint.maskSize / 2,
                },
                {
                    name: 'maskNotes',
                    value: +joint.isMaskNotes,
                },
                {
                    name: 'ease',
                    value: easeValues[joint.eventEase],
                },
            ],
        }),
        stageEntities,
        'firstMaskChange',
    )
}
