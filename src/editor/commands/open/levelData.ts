import { AssertError } from 'typebox/value'
import type { Chart } from '../../../chart'
import { parseLevelDataChart } from '../../../chart/parse/levelData'
import { parseSusChart } from '../../../chart/parse/sus'
import { parseUscChart } from '../../../chart/parse/usc'
import { ImportRefusal } from '../../../chart/refusal'
import { validateChart } from '../../../chart/validate'
import { chcyToUsc, isChcyLevelData } from '../../../chcy/convert'
import { inflateCapped, isGzip, LevelFileTooLarge } from '../../../levelData/gzip'
import { parseLevelData } from '../../../levelData/parse'
import { LevelDataReport } from '../../../levelData/report'
import { parseSus } from '../../../sus/parse'
import { parseUsc } from '../../../usc/parse'
import { interpolateRaw } from '../../../utils/interpolate'

// Open's content dispatch and parse, without the dialog: a loose file's bytes, or a package
// level's level data, become a chart or one of the refusals below. Kept free of the i18n module,
// so Node tests can run it and pass the English strings to `openErrorText`.

export type ImportType = 'levelData' | 'chcy' | 'usc' | 'sus'

/** A file whose format the editor cannot read. */
export class UnsupportedFileError extends Error {
    override name = 'UnsupportedFileError'
}

export class FileTooLargeError extends Error {
    override name = 'FileTooLargeError'
}

/** Any failure to read a package level's data: one message, whatever the cause. */
export class LevelUnreadableError extends Error {
    override name = 'LevelUnreadableError'
}

/** The picked file cannot be read any more (moved, or its provider revoked it). */
export class FileUnreadableError extends Error {
    override name = 'FileUnreadableError'
}

/** A chart that cannot be built. SUS, USC and Chart Cyanvas files are charts rather than levels. */
export class RefusedFileError extends Error {
    override name = 'RefusedFileError'
    constructor(
        readonly type: ImportType,
        readonly refusal: ImportRefusal,
    ) {
        super(`Refused: ${refusal.reason}`, { cause: refusal })
    }
}

export type OpenErrorStrings = {
    unsupported: string
    tooLarge: string
    invalidLevel: string
    invalidChart: string
    refusals: Record<ImportRefusal['reason'], string>
    levelUnreadable: string
    fileUnreadable: string
}

/** The message a loading dialog shows for one of the errors above; undefined for any other. */
export const openErrorText = (error: unknown, strings: OpenErrorStrings) => {
    if (error instanceof UnsupportedFileError) return strings.unsupported
    if (error instanceof FileTooLargeError) return strings.tooLarge
    if (error instanceof LevelUnreadableError) return strings.levelUnreadable
    if (error instanceof FileUnreadableError) return strings.fileUnreadable
    if (error instanceof RefusedFileError) {
        const { type, refusal } = error
        return interpolateRaw(
            type === 'levelData' ? strings.invalidLevel : strings.invalidChart,
            interpolateRaw(strings.refusals[refusal.reason], ...refusal.params),
        )
    }
    return
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

    throw new UnsupportedFileError('No format matches the content')
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
        if (error instanceof AssertError)
            throw new UnsupportedFileError('The schema refused the file', { cause: error })
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
        if (error instanceof LevelFileTooLarge)
            throw new FileTooLargeError('The file inflates past the limit')
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
