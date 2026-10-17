import type { LevelDataEntity } from '@sonolus/core'
import type { BaseEventConnectionEntity } from '../../../../state/entities/events/connections'
import type { EventJointEntity } from '../../../../state/entities/events/joints'

/**
 * Event entities in the given order (the records' order, §1.6.11.6), each linked to the
 * next joint on its chain; names follow the order, so level data is a function of the state.
 */
export const serializeEventsToLevelDataEntities = <T extends EventJointEntity>(
    joints: readonly T[],
    connectionEntities: Iterable<BaseEventConnectionEntity<T>>,
    getName: () => string,
    create: (joint: T) => LevelDataEntity,
) => {
    const entities = new Map(joints.map((joint) => [joint, create(joint)]))

    const next = new Map<T, T>()
    for (const { min, max } of connectionEntities) next.set(min, max)

    for (const [joint, entity] of entities) {
        const max = next.get(joint)
        if (!max) continue

        const target = entities.get(max)
        if (!target) throw new Error('Unexpected missing joint')

        entity.data.push({
            name: 'next',
            ref: (target.name ??= getName()),
        })
    }

    return entities
}
