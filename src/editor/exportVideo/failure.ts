// What an export's failure says, and the reason its usage event records.

import { VideoOutputUnavailable } from '../../exportVideo/error'
import { i18n } from '../../i18n'
import { FileError } from '../../platform/types'
import { inlineName } from '../../utils/inlineName'
import { interpolate } from '../../utils/interpolate'
import { fileErrorText } from '../commands/exportLevel/ui'
import type { VideoReportEnd } from './report'

/** A pick the video cannot be written to, with what the pick session did with the file. */
export class VideoPickRefused extends Error {
    constructor(
        readonly fileName: string,
        readonly reason: 'ownProject' | 'known' | 'other',
    ) {
        super(`${fileName} cannot take the video`)
    }
}

export type VideoFailure = {
    reason: NonNullable<VideoReportEnd['reason']>
    message: () => string
    /** English detail, behind Error Details. */
    detail?: string
}

const text = (pick: (messages: (typeof i18n)['value']['exportVideo']['errors']) => string) => () =>
    pick(i18n.value.exportVideo.errors)

export const describeVideoFailure = (error: unknown, name: string): VideoFailure => {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (error instanceof VideoPickRefused) {
        const file = inlineName(error.fileName)
        return error.reason === 'ownProject'
            ? {
                  reason: 'ownProject',
                  message: interpolate(() => i18n.value.exportVideo.errors.ownProject, file),
              }
            : {
                  reason: 'refused',
                  message: interpolate(
                      () =>
                          error.reason === 'other'
                              ? i18n.value.exportVideo.errors.refusedOther
                              : i18n.value.exportVideo.errors.refused,
                      file,
                  ),
              }
    }
    if (error instanceof VideoOutputUnavailable)
        return error.reason === 'memoryLimit'
            ? { reason: 'memoryLimit', message: text((m) => m.memoryLimit), detail }
            : { reason: 'io', message: text((m) => m.unavailable), detail }
    if (error instanceof FileError)
        return { reason: error.code, message: () => fileErrorText(name, error), detail }
    const failure = error instanceof Error ? error : new Error(String(error))
    if (failure.name === 'background')
        return { reason: 'hidden', message: text((m) => m.hidden), detail }
    if (failure.name === 'graphics')
        return { reason: 'graphics', message: text((m) => m.graphics), detail }
    if (failure instanceof RangeError || failure.name === 'QuotaExceededError')
        return { reason: 'memory', message: text((m) => m.memory), detail }
    if (failure.message.startsWith('Encoder configuration unavailable'))
        return { reason: 'config', message: text((m) => m.config), detail }
    if (/audio|mix/i.test(failure.message))
        return { reason: 'audio', message: text((m) => m.audio), detail }
    return { reason: 'encoder', message: text((m) => m.encoder), detail }
}
