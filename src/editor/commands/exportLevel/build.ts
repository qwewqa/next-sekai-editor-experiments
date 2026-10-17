import { gzip } from 'pako'
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

/** The live session as gzipped level data (level 9), exactly today's Save output; never a peeked state. */
export const buildLevelData = () => {
    const levelData = serializeToLevelData(
        initialLife.value,
        isDynamicStages.value,
        bgm.value.offset,
        store.value,
        groups.value,
        stages.value,
        { groups: groupFolders.value, stages: stageFolders.value },
    )
    return new Blob([gzip(JSON.stringify(levelData), { level: 9 })], {
        type: 'application/octet-stream',
    })
}
