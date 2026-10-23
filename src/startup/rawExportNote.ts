import { interpolateRaw } from '../utils/interpolate'

// What Export Raw Data… says when it did not go through whole (Part 1 §1.4.14). Apart from the
// action so a Node test can read it.

export type RawExportRun =
    /** The file was handed over; `started` when the browser began a download. */
    | { kind: 'done'; name: string; size: number; started: boolean; databaseUnreadable: boolean }
    /** The hand-over failed. */
    | { kind: 'failed'; name: string; error: unknown }

export type RawExportTexts = {
    /** `save.downloadFailed`: ""{0}" could not be downloaded." */
    downloadFailed: string
    /** `settings.localData.exportRawUnreadable`. */
    unreadable: string
}

/** The line for a run that did not go through whole: the download failed, or the stored work was left out. */
export const rawExportNote = (run: RawExportRun, texts: RawExportTexts) => {
    if (run.kind === 'failed') return interpolateRaw(texts.downloadFailed, run.name)
    return run.databaseUnreadable ? texts.unreadable : undefined
}
