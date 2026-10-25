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
import { gzipLevel9, gzipText, hasGzipStreams } from '../../../utils/gzipStream'

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

/**
 * The same level data once for each way it has been compressed: on the browser's stream, and at
 * level 9, which every export wrote before streams and Firefox before 113 still writes. A file
 * written by either is rebuilt byte for byte by the matching one.
 */
export const buildLevelDataVariants = async () => {
    const text = levelDataText()
    return [...(hasGzipStreams() ? [await gzipText(text)] : []), gzipLevel9(text)].map(
        (blob) => new Blob([blob], { type }),
    )
}
