// What an export's failure says, and the reason its usage event records.

import { AudioFailure, failureDetails, VideoOutputUnavailable } from '../../exportVideo/error'
import type { ExportSettings } from '../../exportVideo/types'
import { i18n } from '../../i18n'
import { FileError } from '../../platform/types'
import { interpolateRaw } from '../../utils/interpolate'
import { fileErrorText } from '../commands/exportLevel/ui'
import { soundList } from './messages'
import type { VideoReportEnd } from './report'

export type VideoFailure = {
    reason: NonNullable<VideoReportEnd['reason']>
    message: () => string
    /** English detail, behind Error Details. */
    detail?: string
}

const text = (pick: (messages: (typeof i18n)['value']['exportVideo']['errors']) => string) => () =>
    pick(i18n.value.exportVideo.errors)

/** The sound sources the attempt used, which a sound failure names. */
type Sound = Pick<ExportSettings, 'bgm' | 'sfx'>

const describeFailure = (error: unknown, name: string, sound: Sound): VideoFailure => {
    // Earlier failures, such as a refused first attempt or a failed cleanup, follow the cause.
    const detail = [
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ...failureDetails(error),
    ].join('\n')
    if (error instanceof VideoOutputUnavailable)
        return { reason: 'io', message: text((m) => m.unavailable), detail }
    if (error instanceof AudioFailure)
        return {
            reason: 'audio',
            message: () => interpolateRaw(i18n.value.exportVideo.errors.audio, soundList(sound)),
            detail,
        }
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
    return { reason: 'encoder', message: text((m) => m.encoder), detail }
}

/** Reads after cleanup, so removed or unreadable targets are never described as empty. */
export const describeVideoFailure = async (
    error: unknown,
    name: string,
    sound: Sound,
    handle?: FileSystemFileHandle,
): Promise<VideoFailure> => {
    const failure = describeFailure(error, handle?.name ?? name, sound)
    const file = await handle?.getFile().catch(() => undefined)
    return handle && file?.size === 0
        ? { ...failure, message: () => `${failure.message()} ${i18n.value.save.fileNowEmpty}` }
        : failure
}
