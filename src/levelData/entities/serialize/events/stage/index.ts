import type { LevelDataEntity } from '@sonolus/core'
import { serializeEventsToLevelDataEntities } from '..'
import type { StageId } from '../../../../../chart/stages'
import type { BaseStageEventConnectionEntity } from '../../../../../state/entities/events/connections/stage'
import type { StageEventJointEntity } from '../../../../../state/entities/events/joints/stage'
import type { Range } from '../../../../../utils/range'

export const serializeStageEventsToLevelDataEntities = <T extends StageEventJointEntity>(
    joints: readonly T[],
    connectionEntities: Iterable<BaseStageEventConnectionEntity<T>>,
    ranges: Map<StageId, Range<T>>,
    getName: () => string,
    create: (joint: T) => LevelDataEntity,
    stageEntities: Map<StageId, LevelDataEntity> | undefined,
    refDataName: string,
) => {
    const entities = serializeEventsToLevelDataEntities(joints, connectionEntities, getName, create)

    // Stages in their own order, so first refs are named the same way every time.
    for (const [id, stage] of stageEntities ?? []) {
        const range = ranges.get(id)
        if (!range) continue

        const first = entities.get(range.min)
        if (!first) throw new Error('Unexpected missing joint')

        stage.data.push({
            name: refDataName,
            ref: (first.name ??= getName()),
        })
    }
    for (const id of ranges.keys())
        if (!stageEntities?.has(id)) throw new Error('Unexpected stage not found')

    return [...entities.values()]
}
