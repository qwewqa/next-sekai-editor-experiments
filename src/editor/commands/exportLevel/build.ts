import { gzip, ungzip } from 'pako'
import { isChcyLevelData } from '../../../chcy/convert'
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

/** JSON from bytes that may be gzipped, or undefined. */
export const readJson = (bytes: Uint8Array): unknown => {
    const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b
    try {
        return JSON.parse(new TextDecoder().decode(isGzip ? ungzip(bytes) : bytes))
    } catch {
        return
    }
}

/** This engine's level data by content (§1.5.2), gzipped or plain; a ChCy level is not. */
export const isLevelDataContent = (bytes: Uint8Array) => {
    const json = readJson(bytes)
    return (
        typeof json === 'object' &&
        json !== null &&
        'entities' in json &&
        Array.isArray(json.entities) &&
        !isChcyLevelData(json)
    )
}
