import { EngineArchetypeDataName, EngineArchetypeName, type LevelDataEntity } from '@sonolus/core'
import type { OrderedStore } from '../../../local/records/extract'

/** BPM changes in the records' order. */
export const serializeBpmsToLevelDataEntities = (ordered: OrderedStore) =>
    ordered.bpms.map(({ entity: bpm }): LevelDataEntity => ({
        archetype: EngineArchetypeName.BpmChange,
        data: [
            {
                name: EngineArchetypeDataName.Beat,
                value: bpm.beat,
            },
            {
                name: EngineArchetypeDataName.Bpm,
                value: bpm.bpm,
            },
            {
                name: 'meter',
                value: bpm.meter,
            },
        ],
    }))
