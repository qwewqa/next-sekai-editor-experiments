import { EngineArchetypeDataName, EngineArchetypeName, type LevelDataEntity } from '@sonolus/core'
import type { GroupId } from '../../../chart/groups'
import { easeValues } from '../../../ease'
import type { OrderedStore } from '../../../local/records/extract'

/**
 * Time-scale changes in the records' order: by beat, then group, then their
 * order in the group, each group's chain linked in that order.
 */
export const serializeTimeScalesToLevelDataEntities = (
    groupEntities: Map<GroupId, LevelDataEntity>,
    ordered: OrderedStore,
    getName: () => string,
) => {
    const prevs = new Map<GroupId, LevelDataEntity>()

    return ordered.timeScales.map(({ entity: timeScale }) => {
        const timeScaleGroup = groupEntities.get(timeScale.groupId)
        if (!timeScaleGroup) throw new Error('Unexpected missing group')

        const entity: LevelDataEntity = {
            archetype: EngineArchetypeName.TimeScaleChange,
            data: [
                {
                    name: '#TIMESCALE_GROUP',
                    ref: (timeScaleGroup.name ??= getName()),
                },
                {
                    name: EngineArchetypeDataName.Beat,
                    value: timeScale.beat,
                },
                {
                    name: 'editorLane',
                    value: timeScale.editorLane,
                },
                {
                    name: EngineArchetypeDataName.TimeScale,
                    value: timeScale.timeScale,
                },
                {
                    name: '#TIMESCALE_SKIP',
                    value: timeScale.skip,
                },
                {
                    name: '#TIMESCALE_EASE',
                    value: easeValues[timeScale.timeScaleEase],
                },
                {
                    name: 'transitionStyle',
                    value: transitionStyles[timeScale.timeScaleTransition],
                },
                {
                    name: 'hideNotes',
                    value: +timeScale.hideNotes,
                },
            ],
        }

        const prev = prevs.get(timeScale.groupId)
        ;(prev ?? timeScaleGroup).data.push({
            name: prev ? 'next' : 'first',
            ref: (entity.name ??= getName()),
        })
        prevs.set(timeScale.groupId, entity)

        return entity
    })
}

const transitionStyles = {
    timeScale: 0,
    scroll: 1,
}
