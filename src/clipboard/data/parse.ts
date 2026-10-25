import { assert } from '../../chart/parse/levelData/check'
import { restoreNullSegmentAlphas } from '../../levelData/parse'
import { clipboardDataSchema, type ClipboardData } from './schema'

export const parseClipboardData = (data: unknown): ClipboardData => {
    restoreNullSegmentAlphas(data)
    assert(clipboardDataSchema, data)
    return data
}
