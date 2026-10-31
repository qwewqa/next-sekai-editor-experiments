import { AssertError } from 'typebox/value'
import type { Chart } from '../../../chart'
import { parseLevelDataChart } from '../../../chart/parse/levelData'
import { parseSusChart } from '../../../chart/parse/sus'
import { parseUscChart } from '../../../chart/parse/usc'
import { ImportRefusal } from '../../../chart/refusal'
import { validateChart } from '../../../chart/validate'
import { chcyToUsc, isChcyLevelData } from '../../../chcy/convert'
import { i18n } from '../../../i18n'
import { inflateCapped, isGzip, LevelFileTooLarge } from '../../../levelData/gzip'
import { parseLevelData } from '../../../levelData/parse'
import { LevelDataReport } from '../../../levelData/report'
import { parseSus } from '../../../sus/parse'
import { parseUsc } from '../../../usc/parse'
import { interpolateRaw } from '../../../utils/interpolate'

// Open's content dispatch and parse, without the dialog: a loose file's bytes, or a package
// level's level data, become a chart or one of the refusals below.

export type ImportType = 'levelData' | 'chcy' | 'usc' | 'sus'

/** A file whose format the editor cannot read. */
export class UnsupportedFileError extends Error {
    constructor() {
        super(i18n.value.commands.open.unsupported)
    }
}

export class FileTooLargeError extends Error {
    constructor() {
        super(i18n.value.commands.open.tooLarge)
    }
}

// SUS, USC and Chart Cyanvas files are charts rather than levels.
export class RefusedFileError extends Error {
    constructor(type: ImportType, refusal: ImportRefusal) {
        const { open } = i18n.value.commands
        super(
            interpolateRaw(
                type === 'levelData' ? open.invalidLevel : open.invalidChart,
                interpolateRaw(open.refusals[refusal.reason], ...refusal.params),
            ),
            { cause: refusal },
        )
    }
}

/** What a parse made: the chart, its offset, and for level data what the reader left out. */
export type Parsed =
    | {
          type: 'levelData'
          chart: Chart
          offset: number
          levelData: ReturnType<typeof parseLevelData>
          report: LevelDataReport
      }
    | { type: 'chcy' | 'usc' | 'sus'; chart: Chart; offset: number }

const isLevelDataLike = (data: unknown) =>
    typeof data === 'object' && data !== null && 'entities' in data

/** Level data's branch of the dispatch: Chart Cyanvas level data, else level data. */
export const levelDataType = (json: unknown): 'chcy' | 'levelData' | undefined =>
    isLevelDataLike(json) ? (isChcyLevelData(json) ? 'chcy' : 'levelData') : undefined

/**
 * Detects the format from the content: level data (gzipped, as Sonolus serves
 * it, or plain JSON), which is Chart Cyanvas level data when it has the
 * format's `TimeScaleGroup` entities; a USC chart; or a SUS chart.
 */
export const tryImport = (buffer: ArrayBuffer) => {
    const json = tryParseJson(buffer)
    const level = levelDataType(json)
    if (level) return [level, json] as const
    if (json !== undefined) return ['usc', json] as const

    const sus = tryImportSus(buffer)
    if (sus) return ['sus', sus] as const

    throw new UnsupportedFileError()
}

/**
 * Parses what the dispatch found. A schema's refusal is a file the editor cannot read; a chart
 * that cannot be built is refused with its reason.
 */
export const parseImported = (type: ImportType, data: unknown): Parsed => {
    try {
        switch (type) {
            case 'chcy': {
                const { offset, objects } = chcyToUsc(parseLevelData(data))
                const chart = parseUscChart(objects)
                validateChart(chart)
                return { type, chart, offset }
            }
            case 'levelData': {
                const levelData = parseLevelData(data)
                const report = new LevelDataReport()
                const chart = parseLevelDataChart(levelData.entities, undefined, undefined, report)
                validateChart(chart)
                return { type, chart, offset: levelData.bgmOffset, levelData, report }
            }
            case 'usc': {
                const { usc } = parseUsc(data)
                const chart = parseUscChart(usc.objects)
                validateChart(chart)
                return { type, chart, offset: usc.offset }
            }
            case 'sus': {
                const sus = parseSus(data as string[])
                const chart = parseSusChart(sus)
                validateChart(chart)
                return { type, chart, offset: sus.offset }
            }
        }
    } catch (error) {
        if (error instanceof AssertError) throw new UnsupportedFileError()
        if (error instanceof ImportRefusal) throw new RefusedFileError(type, error)
        throw error
    }
}

const tryParseJson = (buffer: ArrayBuffer): unknown => {
    const bytes = new Uint8Array(buffer)
    let text: string
    try {
        text = new TextDecoder().decode(isGzip(buffer) ? inflateCapped(bytes) : bytes)
    } catch (error) {
        // The refusal is not a file that is not JSON: it must not fall through to SUS.
        if (error instanceof LevelFileTooLarge) throw new FileTooLargeError()
        return
    }
    try {
        return JSON.parse(text)
    } catch {
        return
    }
}

const tryImportSus = (buffer: ArrayBuffer) => {
    try {
        const data = new TextDecoder().decode(buffer).split('\n')
        if (data.filter((line) => line.startsWith('#')).length < 10) return

        return data
    } catch {
        return
    }
}
