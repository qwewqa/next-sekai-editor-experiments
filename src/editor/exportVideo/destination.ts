import type { VideoFormat } from '../../exportVideo/codecs'
import type { JobDestination } from '../../exportVideo/job'
import { removeVideoPick } from '../../exportVideo/worker/target'
import { fileErrorOf } from '../../platform/handover'
import type { Platform, StagedVideo, VideoOutput } from '../../platform/types'
import type { PickedVideo, VideoPick, pickVideo } from '../save/videoPick'

export const VIDEO_MEMORY_ESTIMATE_LIMIT = 100_000_000
export const VIDEO_MEMORY_LIMIT = 150_000_000
export type VideoDestination =
    | { kind: 'picked'; pick: VideoPick }
    | { kind: 'staged'; id: string; stage: StagedVideo; output: VideoOutput }
    | { kind: 'memory'; limit: number }
    | { kind: 'unavailable'; reason: 'output' | 'memoryLimit' }
    | Exclude<PickedVideo, { kind: 'accepted' }>

/** Selects a destination after preparation; the pick session checks activation. */
export const prepareVideoDestination = async (options: {
    platform: Pick<Platform, 'pickSaveFile' | 'videoOutput'>
    pick: typeof pickVideo
    pickOptions: Parameters<typeof pickVideo>[0]
    id: string
    format: VideoFormat
    estimatedBytes: number
    /** False when the export worker cannot write a staged file: memory is the route. */
    syncAccess?: boolean
}): Promise<VideoDestination> => {
    const { platform, pickOptions } = options
    pickOptions.signal?.throwIfAborted()
    if (platform.pickSaveFile) {
        const result = await options.pick({
            ...pickOptions,
            type: { ...pickOptions.type, extension: `.${options.format}` },
        })
        return result.kind === 'accepted' ? { kind: 'picked', pick: result.pick } : result
    }
    const output = platform.videoOutput
    if (!output) return { kind: 'unavailable', reason: 'output' }
    const memory = (): VideoDestination =>
        !Number.isFinite(options.estimatedBytes) ||
        options.estimatedBytes < 0 ||
        options.estimatedBytes > VIDEO_MEMORY_ESTIMATE_LIMIT
            ? { kind: 'unavailable', reason: 'memoryLimit' }
            : { kind: 'memory', limit: VIDEO_MEMORY_LIMIT }
    if (options.syncAccess === false) return memory()
    try {
        const stage = await output.stage(options.id, options.format)
        if (pickOptions.signal?.aborted) {
            await output.remove(options.id)
            pickOptions.signal.throwIfAborted()
        }
        return { kind: 'staged', id: options.id, stage, output }
    } catch (error) {
        pickOptions.signal?.throwIfAborted()
        // A full disk or an I/O failure must retain its own error, not choose memory.
        if (
            !(error instanceof DOMException) ||
            !['SecurityError', 'NotSupportedError'].includes(error.name)
        )
            throw fileErrorOf(error)
        return memory()
    }
}

/**
 * Cancellation after picking may end the export before the worker opens the target.
 * Cleanup removes the picked file only while it remains empty and unchanged.
 */
export const pickedDestination = (pick: VideoPick): JobDestination => ({
    worker: { kind: 'picked', pick },
    discard: () => removeVideoPick(pick),
})
