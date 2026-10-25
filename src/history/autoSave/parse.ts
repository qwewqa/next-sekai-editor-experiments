import type { LevelData } from '@sonolus/core'
import { ungzip } from 'pako'
import { assert } from '../../chart/parse/levelData/check'
import { parseLevelData, restoreNullSegmentAlphas } from '../../levelData/parse'
import { autoSaveSchema } from './schema'

type ParsedAutoSave = {
    filename?: string
    levelData: LevelData
    defaultGuideColors?: number[]
}

export const parseAutoSave = (data: unknown): ParsedAutoSave => {
    // The unversioned format is the level data itself.
    restoreNullSegmentAlphas(data)
    assert(autoSaveSchema, data)

    if (!('version' in data))
        return {
            levelData: data,
        }

    const buffer = Uint8Array.from(atob(data.levelData), (c) => c.charCodeAt(0))

    return {
        filename: data.filename,
        levelData: parseLevelData(JSON.parse(new TextDecoder().decode(ungzip(buffer)))),
        ...(data.defaultGuideColors ? { defaultGuideColors: data.defaultGuideColors } : {}),
    }
}
