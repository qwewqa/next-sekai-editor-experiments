import type { VideoFormat } from '../../exportVideo/codecs'
import type { JobDestination } from '../../exportVideo/job'
import { stagingRefused } from '../../exportVideo/route'
import { removeVideoPick } from '../../exportVideo/worker/target'
import { fileErrorOf } from '../../platform/handover'
import type { Platform, StagedVideo, VideoOutput } from '../../platform/types'
import type { PickedVideo, VideoPick, pickVideo } from '../save/videoPick'

/** Above this estimate of the file's size, the dialog warns before an export to memory. */
export const VIDEO_MEMORY_WARNING_BYTES = 150_000_000
export type VideoDestination =
    | { kind: 'picked'; pick: VideoPick }
    | { kind: 'staged'; id: string; stage: StagedVideo; output: VideoOutput }
    | { kind: 'memory' }
    | { kind: 'unavailable'; reason: 'output' }
    | Exclude<PickedVideo, { kind: 'accepted' }>

let memoryRouteFound = false
/** Whether an export in this page took the in-memory route. */
export const memoryRouteTaken = () => memoryRouteFound

/** Selects a destination after preparation; the pick session checks activation. */
export const prepareVideoDestination = async (options: {
    platform: Pick<Platform, 'pickSaveFile' | 'videoOutput'>
    pick: typeof pickVideo
    pickOptions: Parameters<typeof pickVideo>[0]
    id: string
    format: VideoFormat
    /** False when the export worker cannot write a staged file, so the route is memory. */
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
    const memory = (): VideoDestination => {
        memoryRouteFound = true
        return { kind: 'memory' }
    }
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
        // A full disk or another I/O failure must retain its own error, not choose memory.
        if (!stagingRefused(error)) throw fileErrorOf(error)
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
