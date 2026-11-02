import { exportError, restoreExportError } from './error'
import type { ExportFaults, FromExportWorker, ToExportWorker } from './protocol'
import type { AudioBlock } from './timing'
import {
    assetTransfers,
    type ExportScene,
    type ExportSettings,
    type ExportStart,
    type ExportTarget,
} from './types'

export const createExportHost = (worker: Worker) => {
    let running = false
    let rejectRun: ((error: unknown) => void) | undefined
    let prepared = false
    let pendingView:
        | {
              time: number
              settings: ExportSettings
              resolve(value: ImageBitmap | undefined): void
              reject(error: Error): void
          }
        | undefined
    let view: typeof pendingView
    let preparedWait: { resolve(): void; reject(error: Error): void } | undefined
    const failView = (error: unknown) => {
        const reason = exportError(error)
        preparedWait?.reject(reason)
        preparedWait = undefined
        view?.reject(reason)
        view = undefined
        pendingView?.reject(reason)
        pendingView = undefined
    }
    const post = (message: ToExportWorker, transfers: Transferable[] = []) => {
        worker.postMessage(message, transfers)
    }
    const nextView = () => {
        if (view || !pendingView) return
        view = pendingView
        pendingView = undefined
        post({ type: 'view', time: view.time, settings: view.settings })
    }
    const viewMessage = (data: FromExportWorker) => {
        if (data.type === 'prepared') {
            prepared = true
            preparedWait?.resolve()
            preparedWait = undefined
        } else if (data.type === 'view') {
            if (view) view.resolve(data.bitmap)
            else data.bitmap.close()
            view = undefined
            nextView()
        } else if (data.type === 'failed') failView(restoreExportError(data.error))
        else if (data.type === 'cancelled')
            failView(new DOMException('Video export cancelled', 'AbortError'))
    }
    worker.onmessage = ({ data }: MessageEvent<FromExportWorker>) => {
        viewMessage(data)
    }
    worker.onerror = (event) => {
        failView(new Error(event.message))
    }
    worker.onmessageerror = () => {
        failView(new Error('Message from the export worker could not be read'))
    }
    return {
        visibility(hidden: boolean) {
            post({ type: 'visibility', hidden })
        },
        prepare(scene: ExportScene) {
            return new Promise<void>((resolve, reject) => {
                preparedWait = { resolve, reject }
                post({ type: 'prepare', scene }, assetTransfers(scene.assets))
            })
        },
        view(time: number, settings: ExportSettings) {
            if (!prepared || running) return Promise.reject(new Error('Export view is unavailable'))
            return new Promise<ImageBitmap | undefined>((resolve, reject) => {
                pendingView?.resolve(undefined)
                pendingView = { time, settings, resolve, reject }
                nextView()
            })
        },
        run(
            start: ExportStart,
            destination: ExportTarget,
            options: {
                signal: AbortSignal
                block(): Promise<AudioBlock | undefined>
                event(message: FromExportWorker): void
                faults?: ExportFaults
            },
        ): Promise<unknown> {
            if (running) throw new Error('Export worker is already running')
            if (view || pendingView) throw new Error('An export view is still being drawn')
            running = true
            return new Promise((resolve, reject) => {
                let blockError: unknown
                const cancel = () => {
                    post({ type: 'cancel' })
                }
                const finish = (error?: unknown, result?: unknown) => {
                    options.signal.removeEventListener('abort', cancel)
                    rejectRun = undefined
                    running = false
                    worker.onerror = (event) => {
                        failView(new Error(event.message))
                    }
                    worker.onmessageerror = () => {
                        failView(new Error('Message from the export worker could not be read'))
                    }
                    worker.onmessage = ({ data }: MessageEvent<FromExportWorker>) => {
                        viewMessage(data)
                    }
                    if (blockError || error) reject(exportError(blockError ?? error))
                    else resolve(result)
                }
                rejectRun = (error) => {
                    finish(error)
                }
                worker.onerror = (event) => {
                    finish(new Error(event.message))
                }
                worker.onmessageerror = () => {
                    finish(new Error('Message from the export worker could not be read'))
                }
                worker.onmessage = ({ data }: MessageEvent<FromExportWorker>) => {
                    if (data.type === 'block') {
                        void options.block().then(
                            (block) => {
                                if (options.signal.aborted) return
                                post(
                                    { type: 'block', block },
                                    block ? block.planes.map((p) => p.buffer) : [],
                                )
                            },
                            (error: unknown) => {
                                blockError = error
                                cancel()
                            },
                        )
                    } else if (data.type === 'done') finish(undefined, data.result)
                    else if (data.type === 'cancelled')
                        finish(new DOMException('Video export cancelled', 'AbortError'))
                    else if (data.type === 'failed') finish(restoreExportError(data.error))
                    else {
                        options.event(data)
                        if (data.type === 'finishing')
                            post({ type: options.signal.aborted ? 'cancel' : 'commit' })
                    }
                }
                options.signal.addEventListener('abort', cancel, { once: true })
                post(
                    {
                        type: 'start',
                        start: prepared ? undefined : start,
                        config: {
                            settings: start.settings,
                            frames: start.frames,
                            frameRate: start.frameRate,
                            samples: start.samples,
                            codecs: start.codecs,
                            aacDelay: start.aacDelay,
                        },
                        destination,
                        faults: options.faults,
                    },
                    prepared ? [] : assetTransfers(start.assets),
                )
                if (options.signal.aborted) cancel()
            })
        },
        dispose() {
            failView(new DOMException('Export worker closed', 'AbortError'))
            rejectRun?.(new DOMException('Export worker closed', 'AbortError'))
            worker.terminate()
        },
    }
}
