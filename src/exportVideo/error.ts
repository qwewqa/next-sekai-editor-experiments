import {
    FileError,
    type DiskState,
    type FileErrorCode,
    type FileErrorStep,
} from '../platform/types'

export const exportError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error))

/** No route to a file in this browser, or a staged file the export worker cannot open for writing. */
export class VideoOutputUnavailable extends Error {
    constructor(readonly reason: 'output' | 'staging') {
        super(`Video output unavailable: ${reason}`)
    }
}

/** The sound could not be encoded or mixed: preparing, feeding or ending the audio failed. */
export class AudioFailure extends Error {
    constructor(cause: unknown) {
        super(exportError(cause).message, { cause })
        this.name = 'AudioFailure'
    }
}

/** Earlier failures behind an export's error, such as a failed cleanup. */
export const failureDetails = (error: unknown): string[] => {
    const details = error instanceof Error && (error as { details?: unknown }).details
    return Array.isArray(details) ? details.filter((d): d is string => typeof d === 'string') : []
}

/** Adds earlier failures to the error that an export reports. */
export const withFailureDetails = (error: unknown, earlier: readonly unknown[]): Error => {
    const failure = exportError(error)
    if (!earlier.length) return failure
    const describe = (e: unknown) => {
        const cause = exportError(e)
        return `${cause.name}: ${cause.message}`
    }
    // A cleanup can fail with the export's own error, or one already listed.
    const seen = new Set<string>()
    Object.assign(failure, {
        details: [
            ...failureDetails(failure),
            ...earlier.flatMap((e) => (e === failure ? [] : [describe(e), ...failureDetails(e)])),
        ].filter((line) => {
            if (seen.has(line)) return false
            seen.add(line)
            return true
        }),
    })
    return failure
}

export type ExportFailure = {
    name: string
    message: string
    details?: string[]
    output?: VideoOutputUnavailable['reason']
    file?: { code: FileErrorCode; disk?: DiskState; step?: FileErrorStep; fileName?: string }
}
export const serializeExportError = (error: unknown, name?: string): ExportFailure => {
    const failure = exportError(error)
    return {
        name: name ?? failure.name,
        message: failure.message,
        details: failureDetails(failure).length ? failureDetails(failure) : undefined,
        output: failure instanceof VideoOutputUnavailable ? failure.reason : undefined,
        file:
            failure instanceof FileError
                ? {
                      code: failure.code,
                      disk: failure.disk,
                      step: failure.step,
                      fileName: failure.fileName,
                  }
                : undefined,
    }
}
const restoreFailure = (failure: ExportFailure): Error =>
    failure.file
        ? new FileError(
              failure.file.code,
              failure.message,
              failure.file.disk,
              failure.file.step,
              failure.file.fileName,
          )
        : failure.output
          ? new VideoOutputUnavailable(failure.output)
          : failure.name === 'AudioFailure'
            ? new AudioFailure(failure.message)
            : failure.name === 'RangeError'
              ? new RangeError(failure.message)
              : Object.assign(new Error(failure.message), { name: failure.name })
export const restoreExportError = (failure: ExportFailure): Error => {
    const error = restoreFailure(failure)
    if (failure.details?.length) Object.assign(error, { details: failure.details })
    return error
}
