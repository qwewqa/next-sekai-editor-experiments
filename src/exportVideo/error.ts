import {
    FileError,
    type DiskState,
    type FileErrorCode,
    type FileErrorStep,
} from '../platform/types'

export const exportError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error))

export type ExportFailure = {
    name: string
    message: string
    file?: { code: FileErrorCode; disk?: DiskState; step?: FileErrorStep; fileName?: string }
}
export const serializeExportError = (error: unknown, name?: string): ExportFailure => {
    const failure = exportError(error)
    return {
        name: name ?? failure.name,
        message: failure.message,
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
        : Object.assign(new Error(failure.message), { name: failure.name })
