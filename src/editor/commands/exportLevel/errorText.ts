import { FileError } from '../../../platform'

/** The `save` message a failed file operation shows: never a browser's message (§1.4.19). */
export type FileErrorKey =
    | 'buildFailed'
    | 'readFailed'
    | 'changedWhileWriting'
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

export const fileErrorKey = (error: FileError): FileErrorKey => {
    switch (error.step) {
        case 'build':
            return 'buildFailed'
        case 'read':
            return 'readFailed'
        case 'readBack':
        case 'check':
            return 'changedWhileWriting'
        case 'download':
            return 'downloadFailed'
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
