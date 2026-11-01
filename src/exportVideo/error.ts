import {
    FileError,
    type DiskState,
    type FileErrorCode,
    type FileErrorStep,
} from '../platform/types'

export const exportError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error))

/** No route to a file in this browser, or too large for the in-memory route. */
export class VideoOutputUnavailable extends Error {
    constructor(readonly reason: 'output' | 'memoryLimit') {
        super(`Video output unavailable: ${reason}`)
    }
}

export type ExportFailure = {
    name: string
    message: string
    output?: VideoOutputUnavailable['reason']
    file?: { code: FileErrorCode; disk?: DiskState; step?: FileErrorStep; fileName?: string }
}
export const serializeExportError = (error: unknown, name?: string): ExportFailure => {
    const failure = exportError(error)
    return {
        name: name ?? failure.name,
        message: failure.message,
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
export const restoreExportError = (failure: ExportFailure): Error =>
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
          : failure.name === 'RangeError'
            ? new RangeError(failure.message)
            : Object.assign(new Error(failure.message), { name: failure.name })
