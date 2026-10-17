import { groupFolderArchetype, stageFolderArchetype, type Folders } from '../../../chart/folders'
import type { Groups } from '../../../chart/groups'
import type { Stages } from '../../../chart/stages'
import { orderStore } from '../../../local/records/extract'
import type { Store } from '../../../state/store'
import { LATEST_REVISION } from '../../revision'
import { serializeBpmsToLevelDataEntities } from './bpm'
import { serializeCameraEventsToLevelDataEntities } from './events/camera'
import { serializeStageMaskEventsToLevelDataEntities } from './events/stage/mask'
import { serializeStagePivotEventsToLevelDataEntities } from './events/stage/pivot'
import { serializeStageStyleEventsToLevelDataEntities } from './events/stage/style'
import { serializeStageTransformEventsToLevelDataEntities } from './events/stage/transform'
import { serializeFoldersToLevelDataEntities } from './folder'
import { serializeGroupsToLevelDataEntities } from './group'
import { serializeSlidesToLevelDataEntities } from './slide'
import { serializeStagesToLevelDataEntities } from './stage'
import { serializeTimeScalesToLevelDataEntities } from './timeScale'

export const serializeToLevelDataEntities = (
    initialLife: number,
    isDynamicStages: boolean,
    store: Store,
    groups: Groups,
    stages: Stages,
    /** Editor-only folders; the clipboard leaves them out. */
    folders?: { groups: Folders; stages: Folders },
) => {
    let id = 0
    const getName = () => (id++).toString(16)
    // One order for every kind, the records' (§1.6.11.6): level data is a function of the state.
    const ordered = orderStore(store)

    const initialization = {
        archetype: 'Initialization',
        data: [
            {
                name: 'initialLife',
                value: initialLife,
            },
            {
                name: 'revision',
                value: LATEST_REVISION,
            },
        ],
    }

    const bpmEntities = serializeBpmsToLevelDataEntities(ordered)

    const groupFolderEntities =
        folders &&
        serializeFoldersToLevelDataEntities(groupFolderArchetype, folders.groups, getName)
    const stageFolderEntities =
        folders && isDynamicStages
            ? serializeFoldersToLevelDataEntities(stageFolderArchetype, folders.stages, getName)
            : undefined

    const groupEntities = serializeGroupsToLevelDataEntities(groups, groupFolderEntities)

    const stageEntities = serializeStagesToLevelDataEntities(
        isDynamicStages,
        stages,
        stageFolderEntities,
    )

    const cameraEventEntities = serializeCameraEventsToLevelDataEntities(
        isDynamicStages,
        initialization,
        store,
        ordered,
        getName,
    )

    const stageMaskEventEntities = serializeStageMaskEventsToLevelDataEntities(
        isDynamicStages,
        stageEntities,
        store,
        ordered,
        getName,
    )
    const stagePivotEventEntities = serializeStagePivotEventsToLevelDataEntities(
        isDynamicStages,
        stageEntities,
        store,
        ordered,
        getName,
    )
    const stageStyleEventEntities = serializeStageStyleEventsToLevelDataEntities(
        isDynamicStages,
        stageEntities,
        store,
        ordered,
        getName,
    )
    const stageTransformEventEntities = serializeStageTransformEventsToLevelDataEntities(
        isDynamicStages,
        stageEntities,
        store,
        ordered,
        getName,
    )

    const timeScaleEntities = serializeTimeScalesToLevelDataEntities(
        groupEntities,
        ordered,
        getName,
    )

    const slideEntities = serializeSlidesToLevelDataEntities(
        groupEntities,
        stageEntities,
        store,
        stages,
        getName,
        ordered,
    )

    return [
        initialization,
        ...bpmEntities,
        ...groupEntities.values(),
        ...(stageEntities?.values() ?? []),
        ...cameraEventEntities,
        ...stageMaskEventEntities,
        ...stagePivotEventEntities,
        ...stageStyleEventEntities,
        ...stageTransformEventEntities,
        ...timeScaleEntities,
        ...slideEntities,
        ...(groupFolderEntities?.values() ?? []),
        ...(stageFolderEntities?.values() ?? []),
    ]
}

export const getStoreEntities = <T>(map: Map<number, Set<T>>) => {
    const entities = new Set<T>()

    for (const set of map.values()) {
        for (const entity of set) {
            entities.add(entity)
        }
    }

    return entities
}
