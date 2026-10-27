import { measureClip } from './audioLength'
import { TaskFailure } from './error'

/** The longest BGM the editor loads: 90 minutes. A limit on duration, not on memory. */
export const BGM_MAX_SECONDS = 90 * 60

/** The limit in minutes, as the texts give it. */
export const BGM_MAX_MINUTES = BGM_MAX_SECONDS / 60

/**
 * Decodes audio bytes, refusing audio over the limit. The container's bound, which may overstate
 * the length, refuses before decoding (`audioMayBeTooLong`); the exact duration refuses after
 * (`audioTooLong`). A file the browser cannot decode is an `audioUnreadable` failure.
 */
export const decodeWithinLimit = async (
    data: ArrayBuffer,
    decode: (data: ArrayBuffer) => Promise<AudioBuffer>,
): Promise<AudioBuffer> => {
    if ((measureClip(new Uint8Array(data))?.seconds ?? 0) > BGM_MAX_SECONDS)
        throw new TaskFailure('audioMayBeTooLong', 'The audio may be longer than the limit')
    let buffer: AudioBuffer
    try {
        buffer = await decode(data)
    } catch (error) {
        throw new TaskFailure(
            'audioUnreadable',
            error instanceof Error && error.message ? error.message : 'Unable to decode audio data',
            { cause: error },
        )
    }
    if (buffer.duration > BGM_MAX_SECONDS)
        throw new TaskFailure('audioTooLong', 'The audio is longer than the limit')
    return buffer
}
