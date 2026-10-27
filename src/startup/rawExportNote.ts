import { PRODUCT_NAME } from '../product'
import { interpolateRaw } from '../utils/interpolate'

// What Export Raw Data says when it did not go through whole. Apart from the
// action so a Node test can read it.

export type RawExportRun =
    /** The file was handed over; `started` when the browser began a download. */
    | { kind: 'done'; name: string; size: number; started: boolean; databaseUnreadable: boolean }
    /** The hand-over failed. */
    | { kind: 'failed'; name: string; error: unknown }
    /** The user closed the Loading dialog before the hand-over. */
    | { kind: 'cancelled' }

export type RawExportTexts = {
    /** `save.downloadFailed`: "“{0}” could not be downloaded." */
    downloadFailed: string
    /** `settings.localData.exportRawUnreadable`. */
    unreadable: string
}

/** The line for a run that did not go through whole: the download failed, or the stored work was left out. */
export const rawExportNote = (run: RawExportRun, texts: RawExportTexts) => {
    if (run.kind === 'cancelled') return undefined
    if (run.kind === 'failed') return interpolateRaw(texts.downloadFailed, run.name)
    return run.databaseUnreadable ? texts.unreadable : undefined
}

/** A local date as 2026-10-23. */
export const dateStamp = (date: Date) =>
    [date.getFullYear(), date.getMonth() + 1, date.getDate()]
        .map((part, i) => String(part).padStart(i === 0 ? 4 : 2, '0'))
        .join('-')

/** "Next SEKAI Editor raw data 2026-10-23.zip", the pattern being the locale's. */
export const rawExportName = (pattern: string, now: Date = new Date()) =>
    interpolateRaw(pattern, PRODUCT_NAME, dateStamp(now))
