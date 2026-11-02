import {
    bgm,
    groupFolders,
    groups,
    initialLife,
    isDynamicStages,
    stageFolders,
    stages,
    store,
} from '../../../history/live'
import { serializeToLevelData } from '../../../levelData/serialize'
import { gzipText } from '../../../utils/gzipStream'

const type = 'application/octet-stream'

/** The live session's level data as JSON text; never a peeked state. */
const levelDataText = () =>
    JSON.stringify(
        serializeToLevelData(
            initialLife.value,
            isDynamicStages.value,
            bgm.value.offset,
            store.value,
            groups.value,
            stages.value,
            { groups: groupFolders.value, stages: stageFolders.value },
        ),
    )

/** The live session as gzipped level data. The state is read before this returns a promise. */
export const buildLevelData = async () => new Blob([await gzipText(levelDataText())], { type })
