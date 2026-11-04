import { FileError } from '../../../platform'

/** The `save` message a failed file operation shows: never a browser's message. */
export type FileErrorKey =
    | 'buildFailed'
    | 'readFailed'
    | 'changedWhileWriting'
    | 'openedContentGone'
    | 'downloadFailed'
    | 'denied'
    | 'notFound'
    | 'notLocal'
    | 'noSpace'
    | 'writeFailed'

/** A failure before any write, or the error a Save or Export shows. */
export const fileError = (error: unknown) =>
    error instanceof FileError
        ? error
        : new FileError('io', error instanceof Error ? error.message : String(error))

/**
 * Whether Always Download is offered for a failure of the save picker or of a write through it:
 * the write was refused or failed, or read back wrong. A full disk, a file not on this device, a
 * missing file, a failed build and a changed file are not the picker's to blame.
 */
export const downloadHelps = (error: FileError) =>
    error.step === 'readBack' ||
    ((error.step === undefined || error.step === 'create' || error.step === 'close') &&
        ['io', 'read-only', 'denied'].includes(error.code))

export const fileErrorKey = (error: FileError): FileErrorKey => {
    switch (error.step) {
        case 'build':
            return 'buildFailed'
        case 'read':
            return 'readFailed'
        case 'readBack':
            return 'changedWhileWriting'
        case 'check':
            return 'openedContentGone'
        case 'download':
            return 'downloadFailed'
        // Steps the usage statistics tell apart; the user reads the failure's own words.
        case 'create':
        case 'close':
        case undefined:
            break
    }
    switch (error.code) {
        case 'denied':
            return 'denied'
        case 'not-found':
            return 'notFound'
        case 'conflict':
            return 'changedWhileWriting'
        case 'not-local':
            return 'notLocal'
        case 'no-space':
            return 'noSpace'
        case 'read-only':
        case 'io':
            return 'writeFailed'
    }
}
