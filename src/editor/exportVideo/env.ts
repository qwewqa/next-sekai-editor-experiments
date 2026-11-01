// Where the dialog's export goes and what draws it: the page's own, or a test's.

import type { VideoFormat } from '../../exportVideo/codecs'
import type { JobDestination } from '../../exportVideo/job'
import type { ExportFaults } from '../../exportVideo/protocol'
import { i18n } from '../../i18n'
import { platform } from '../../platform'
import { handOver } from '../../platform/handover'
import { showNotPutBack } from '../commands/exportLevel/ui'
import { pickUi } from '../save/flow'
import { pickVideo } from '../save/videoPick'
import { pickedDestination, prepareVideoDestination } from './destination'
import { VideoOutputUnavailable, VideoPickRefused } from './failure'

export type DestinationRequest = {
    signal: AbortSignal
    id: string
    name: string
    format: VideoFormat
    estimatedBytes: number
    /** The picker was dismissed: the export ends as a cancel. */
    dismissed(): void
}

export type ExportVideoEnv = {
    worker(): Worker
    /** Called in the Export press, so a picker keeps the user's activation. */
    destination(request: DestinationRequest): Promise<JobDestination>
    /** A save picker names the file, so the button asks first (Export…). */
    picker: boolean
    faults?: ExportFaults
}

/** The page's route: the save picker, else a staged file, else memory for a small video. */
export const pageDestination = async (request: DestinationRequest): Promise<JobDestination> => {
    const destination = await prepareVideoDestination({
        platform,
        pick: pickVideo,
        pickOptions: {
            name: request.name,
            type: {
                description: i18n.value.exportVideo.fileType,
                extension: `.${request.format}`,
            },
            signal: request.signal,
            ui: {
                preparing: pickUi.preparing,
                download: pickUi.download,
                notPutBack: (name, emptied, downloadable, replaced, own) =>
                    showNotPutBack(
                        () => i18n.value.exportVideo.title,
                        name,
                        emptied,
                        downloadable,
                        replaced,
                        own,
                    ),
            },
        },
        id: request.id,
        format: request.format,
        estimatedBytes: request.estimatedBytes,
    })
    switch (destination.kind) {
        case 'picked':
            return pickedDestination(destination.pick)
        case 'staged': {
            const { id, stage, output } = destination
            return {
                worker: { kind: 'staged', handle: stage.handle },
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
                worker: { kind: 'memory', limit: destination.limit },
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
                    // Share… is offered for staged files only.
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
        case 'refused':
            throw new VideoPickRefused(destination.name, destination.reason)
        case 'ownProject':
            throw new VideoPickRefused(destination.name, 'ownProject')
        case 'show':
            await destination.show()
            request.dismissed()
            throw new DOMException('Video export cancelled', 'AbortError')
        case 'failed':
            throw destination.error
        case 'cancelled':
        case 'dismissed':
            request.dismissed()
            throw new DOMException('Video export cancelled', 'AbortError')
    }
}

export const pageEnv = (worker: () => Worker): ExportVideoEnv => ({
    worker,
    destination: pageDestination,
    picker: !!platform.pickSaveFile,
})
