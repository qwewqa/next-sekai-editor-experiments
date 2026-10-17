import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { parseLevelDataChart } from '../../../src/chart/parse/levelData'
import { createState, type State } from '../../../src/state'

// The sample levels every round trip runs over (Node only).

/** Level data from a file: plain, gzipped, or a legacy auto save holding it. */
export const readLevelData = (path: string): { bgmOffset: number; entities: never[] } => {
    const bytes = readFileSync(path)
    const text = bytes[0] === 0x1f ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')
    const data = JSON.parse(text) as Record<string, unknown>
    const autoSave = data.autoSave as { levelData?: string } | undefined
    if (typeof autoSave?.levelData === 'string')
        return JSON.parse(gunzipSync(Buffer.from(autoSave.levelData, 'base64')).toString('utf8'))
    return data as never
}

/** The sample levels every round trip runs over. */
export const samplePaths = [
    'test_level_data/coconut-next-sekai-24887.json',
    'tests/fixtures/generated-large.json',
    'tests/browser/fixtures/legacy-colors.json',
]

export const sampleState = (path: string): State => {
    const { bgmOffset, entities } = readLevelData(path)
    return createState(parseLevelDataChart(entities), bgmOffset)
}
