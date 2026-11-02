import { testKeysOpen } from '../../platform/testKeys'
import { FileError } from '../../platform/types'
import { exportError, serializeExportError } from '../error'
import { readGraphicsLimits } from '../graphics'
import type { FromExportWorker, ToExportWorker } from '../protocol'
import type { AudioBlock } from '../timing'
import type { ExportStart, ExportTarget } from '../types'
import { GraphicsError, createExportRenderer } from './renderer'
import { runExport } from './run'
import type { PacketSink } from './sink'

export type WorkerOutput = {
    sink: PacketSink
    commit(): Promise<void>
    abort(): Promise<void>
}

/** The in-memory route's finished file moves to the page instead of being copied. */
const transferableBuffer = (result: unknown): Transferable[] =>
    typeof result === 'object' &&
    result &&
    'buffer' in result &&
    result.buffer instanceof ArrayBuffer
        ? [result.buffer]
        : []

/** The muxer supplies the sink and the target's commit and abort methods. */
export const installExportWorker = (
    open: (
        start: ExportStart,
        destination: ExportTarget,
        signal: AbortSignal,
    ) => Promise<WorkerOutput>,
) => {
    const scope = self as unknown as {
        postMessage(message: FromExportWorker, transfers: Transferable[]): void
        onmessage: (event: MessageEvent<ToExportWorker>) => void
    }
    const post = (message: FromExportWorker, transfers: Transferable[] = []) => {
        scope.postMessage(message, transfers)
    }
    const controller = new AbortController()
    let started = false
    let cancelled = false
    let hidden = false
    let prepared: ExportStart | undefined
    let renderer: ReturnType<typeof createExportRenderer> | undefined
    let committing = false
    let block: ((value: AudioBlock | undefined) => void) | undefined
    let commit: (() => void) | undefined
    const failed = (failure: unknown) => {
        const background =
            hidden &&
            (failure instanceof GraphicsError ||
                (failure instanceof DOMException &&
                    ['EncodingError', 'InvalidStateError', 'QuotaExceededError'].includes(
                        failure.name,
                    )))
        post({
            type: 'failed',
            error: serializeExportError(
                failure,
                background
                    ? 'background'
                    : failure instanceof GraphicsError
                      ? 'graphics'
                      : failure instanceof Error
                        ? failure.name
                        : 'error',
            ),
        })
    }
    const prepare = (start: ExportStart) => {
        prepared = start
        renderer = createExportRenderer(start, (error) => {
            controller.abort(error)
            if (!started) failed(error)
        })
    }
    const hold = async (stage: 'mix' | 'drain' | 'finalize') => {
        post({ type: 'held', stage })
        await new Promise<void>((_, reject) => {
            if (controller.signal.aborted) reject(exportError(controller.signal.reason))
            else
                controller.signal.addEventListener(
                    'abort',
                    () => {
                        reject(exportError(controller.signal.reason))
                    },
                    { once: true },
                )
        })
    }
    const run = async (message: Extract<ToExportWorker, { type: 'start' }>) => {
        let output: WorkerOutput | undefined
        try {
            if (message.start) prepare(message.start)
            const start = prepared
            if (!start || !renderer) throw new Error('Export renderer is not prepared')
            Object.assign(start.settings, message.config.settings)
            Object.assign(start, { ...message.config, settings: start.settings })
            output = await open(start, message.destination, controller.signal)
            controller.signal.throwIfAborted()
            const faults = testKeysOpen ? message.faults : undefined
            const sink = output.sink
            const result = await runExport(start, {
                signal: controller.signal,
                renderer,
                sink: {
                    add: async (input) => {
                        if (faults?.failWrite)
                            throw new FileError('no-space', 'Injected write failure')
                        if (faults?.hold === 'drain') await hold('drain')
                        await sink.add(input)
                    },
                    finalize: async () => {
                        if (faults?.hold === 'finalize') await hold('finalize')
                        return sink.finalize()
                    },
                    abort: () => sink.abort(),
                },
                block: async () => {
                    if (faults?.hold === 'mix') await hold('mix')
                    return new Promise<AudioBlock | undefined>((resolve) => {
                        block = resolve
                        post({ type: 'block' })
                    })
                },
                progress: (frames, bitmap) => {
                    post({ type: 'progress', frames, bitmap }, bitmap ? [bitmap] : [])
                },
                beforeCapture:
                    faults &&
                    ((renderer, index) => {
                        if (index === faults.loseContextAt) renderer.loseContext()
                    }),
                inspect:
                    faults?.pixelsAt === undefined
                        ? undefined
                        : async (frame, index) => {
                              if (index !== faults.pixelsAt) return
                              const pixels = new Uint8Array(
                                  frame.allocationSize({ format: 'RGBA' }),
                              )
                              await frame.copyTo(pixels, { format: 'RGBA' })
                              post(
                                  {
                                      type: 'pixels',
                                      pixels,
                                      width: frame.displayWidth,
                                      height: frame.displayHeight,
                                  },
                                  [pixels.buffer],
                              )
                          },
                finishing: () =>
                    new Promise<void>((resolve) => {
                        commit = resolve
                        post({ type: 'finishing' })
                    }),
            })
            controller.signal.throwIfAborted()
            committing = true
            await output.commit()
            started = false
            committing = false
            post({ type: 'done', result }, transferableBuffer(result))
        } catch (error) {
            let cleanupError: unknown
            try {
                await output?.sink.abort()
            } catch (failure) {
                cleanupError = failure
            }
            try {
                await output?.abort()
            } catch (failure) {
                cleanupError ??= failure
            }
            renderer?.dispose()
            renderer = undefined
            if (cancelled && !cleanupError) post({ type: 'cancelled' })
            else {
                failed(cleanupError ?? error)
            }
        }
    }
    scope.onmessage = ({ data }) => {
        if (data.type === 'limits') {
            post({ type: 'limits', limits: readGraphicsLimits() })
        } else if (data.type === 'visibility') hidden = data.hidden
        else if (data.type === 'prepare') {
            try {
                prepare(data.start)
                post({ type: 'prepared' })
            } catch (error) {
                failed(error)
            }
        } else if (data.type === 'view') {
            try {
                if (!renderer || started) throw new Error('Export view is unavailable')
                renderer.draw(data.time, data.time - data.settings.in, data.settings)
                const bitmap = renderer.canvas.transferToImageBitmap()
                post({ type: 'view', bitmap }, [bitmap])
            } catch (error) {
                failed(error)
            }
        } else if (data.type === 'start') {
            if (started) return
            started = true
            void run(data)
        } else if (data.type === 'cancel') {
            if (!committing) {
                cancelled = true
                controller.abort()
                block?.(undefined)
                block = undefined
                commit?.()
                commit = undefined
                if (!started) {
                    renderer?.dispose()
                    renderer = undefined
                    post({ type: 'cancelled' })
                }
            }
        } else if (data.type === 'block') {
            block?.(data.block)
            block = undefined
        } else {
            committing = true
            commit?.()
            commit = undefined
        }
    }
}
