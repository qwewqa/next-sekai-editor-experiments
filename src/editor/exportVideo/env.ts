// Where the dialog's export goes and what draws it: the page's own, or a test's.

import type { VideoFormat } from '../../exportVideo/codecs'
import { VideoOutputUnavailable } from '../../exportVideo/error'
import type { JobDestination } from '../../exportVideo/job'
import type { ExportFaults } from '../../exportVideo/protocol'
import { i18n } from '../../i18n'
import { platform } from '../../platform'
import { handOver } from '../../platform/handover'
import { preparingUi } from '../save/flow'
import { pickVideo } from '../save/videoPick'
import { pickedDestination, prepareVideoDestination } from './destination'

export type DestinationRequest = {
    signal: AbortSignal
    id: string
    name: string
    format: VideoFormat
    /** False when the export worker could not open a staged file. */
    syncAccess?: boolean
    /** The picker was dismissed: the export ends as a cancel. */
    dismissed(): void
}

export type ExportVideoEnv = {
    worker(): Worker
    /** Called after preparation; the picker asks for a Ready press if activation expired. */
    destination(request: DestinationRequest): Promise<JobDestination>
    /** The route without a picker, for a picked file the platform refuses to write. */
    fallback?(request: DestinationRequest): Promise<JobDestination>
    /** A save picker names the file, so the button asks first (Export…). */
    picker: boolean
    faults?: ExportFaults
}

/** The page's route: the save picker, else a staged file, else memory. */
export const pageDestination = (request: DestinationRequest) => routeOf(request, platform)

/** The page's route without the save picker: a staged file, else memory. */
export const pageFallback = (request: DestinationRequest) =>
    routeOf(request, { videoOutput: platform.videoOutput })

const routeOf = async (
    request: DestinationRequest,
    from: Parameters<typeof prepareVideoDestination>[0]['platform'],
): Promise<JobDestination> => {
    const destination = await prepareVideoDestination({
        platform: from,
        pick: pickVideo,
        pickOptions: {
            name: request.name,
            type: {
                description: i18n.value.exportVideo.fileType,
                extension: `.${request.format}`,
            },
            signal: request.signal,
            ui: preparingUi,
        },
        id: request.id,
        format: request.format,
        syncAccess: request.syncAccess,
    })
    switch (destination.kind) {
        case 'picked':
            return pickedDestination(destination.pick)
        case 'staged': {
            const { id, stage, output } = destination
            return {
                worker: { kind: 'staged', name: stage.handle.name },
                ready: {
                    file: () => output.file(id),
                    deliver: (file, how) => output.deliver(file, request.name, how),
                    end: () => stage.endReady(),
                },
                discard: () => output.remove(id),
            }
        }
        case 'memory': {
            return {
                worker: { kind: 'memory' },
                ready: {
                    file: (result) => {
                        if (
                            !result ||
                            typeof result !== 'object' ||
                            !('buffer' in result) ||
                            !(result.buffer instanceof ArrayBuffer)
                        )
                            throw new Error('Video output is missing its buffer')
                        return Promise.resolve(
                            new File([result.buffer], request.name, {
                                type: `video/${request.format}`,
                            }),
                        )
                    },
                    // Share Video is offered for staged files only.
                    deliver: async (file) => {
                        await handOver(file, request.name, performance.now(), undefined)
                        return 'delivered'
                    },
                    end: () => Promise.resolve(),
                },
                discard: () => Promise.resolve(),
            }
        }
        case 'unavailable':
            throw new VideoOutputUnavailable(destination.reason)
        case 'failed':
            throw destination.error
        case 'cancelled':
        case 'dismissed':
            request.dismissed()
            throw new DOMException('Video export canceled', 'AbortError')
    }
}

export const pageEnv = (worker: () => Worker): ExportVideoEnv => ({
    worker,
    destination: pageDestination,
    fallback: pageFallback,
    // Read at each use: Write to Chosen Files can change between exports.
    get picker() {
        return !!platform.pickSaveFile
    },
})
