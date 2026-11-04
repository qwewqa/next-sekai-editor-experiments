import { testKeysOpen } from '../../platform/testKeys'
import { FileError } from '../../platform/types'
import { AudioFailure, exportError, serializeExportError, withFailureDetails } from '../error'
import { readGraphicsLimits } from '../graphics'
import type { ExportFaults, FromExportWorker, ToExportWorker } from '../protocol'
import { readMemoryRoute } from '../route'
import type { AudioBlock } from '../timing'
import type { ExportScene, ExportStart, ExportTarget } from '../types'
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

/** A test's refusal of one file operation in this worker, as a platform that refuses it. */
const refuse = (operation: NonNullable<ExportFaults['refuse']>) => {
    const refused = () => Promise.reject(new DOMException('Refused by the test', 'NotAllowedError'))
    const method = operation === 'read' ? 'getFile' : 'createWritable'
    Object.defineProperty(FileSystemFileHandle.prototype, method, {
        configurable: true,
        value: refused,
    })
}

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
    let prepared: ExportScene | undefined
    let renderer: ReturnType<typeof createExportRenderer> | undefined
    let committing = false
    let block: ((value: AudioBlock | undefined) => void) | undefined
    let commit: (() => void) | undefined
    const failed = (failure: unknown) => {
        // A browser may stop graphics and codecs in a background tab.
        const cause = failure instanceof AudioFailure ? failure.cause : failure
        const background =
            hidden &&
            (cause instanceof GraphicsError ||
                (cause instanceof DOMException &&
                    ['EncodingError', 'InvalidStateError', 'QuotaExceededError'].includes(
                        cause.name,
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
    const prepare = (scene: ExportScene) => {
        prepared = scene
        // During an export, a lost context ends the picture at the next capture.
        renderer = createExportRenderer(scene, (error) => {
            if (started) return
            controller.abort(error)
            failed(error)
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
            if (!prepared || !renderer) throw new Error('Export renderer is not prepared')
            Object.assign(prepared.settings, message.config.settings)
            const start: ExportStart = Object.assign(prepared, {
                ...message.config,
                settings: prepared.settings,
            })
            const faults = testKeysOpen ? message.faults : undefined
            if (faults?.refuse && message.destination.kind === 'picked') refuse(faults.refuse)
            if (faults?.noSyncAccess)
                Reflect.deleteProperty(FileSystemFileHandle.prototype, 'createSyncAccessHandle')
            output = await open(start, message.destination, controller.signal)
            controller.signal.throwIfAborted()
            const sink = output.sink
            const { result, warnings } = await runExport(start, {
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
                        if (faults?.loseContextAt === start.settings.frames) renderer?.loseContext()
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
            post({ type: 'done', result, warnings }, transferableBuffer(result))
        } catch (error) {
            const cleanup: unknown[] = []
            try {
                await output?.sink.abort()
            } catch (failure) {
                cleanup.push(failure)
            }
            try {
                await output?.abort()
            } catch (failure) {
                cleanup.push(failure)
            }
            // When the target did not open, nothing was encoded, so the renderer can run another
            // start.
            if (output || cancelled) {
                renderer?.dispose()
                renderer = undefined
            } else started = false
            // After a Cancel, the job reports only its own cleanup.
            if (!cancelled) failed(withFailureDetails(error, cleanup))
            else post({ type: 'cancelled' })
        }
    }
    scope.onmessage = ({ data }) => {
        if (data.type === 'limits') {
            const limits = readGraphicsLimits()
            void readMemoryRoute().then((memoryRoute) => {
                post({ type: 'limits', limits, memoryRoute })
            })
        } else if (data.type === 'visibility') hidden = data.hidden
        else if (data.type === 'prepare') {
            try {
                prepare(data.scene)
                post({ type: 'prepared' })
            } catch (error) {
                failed(error)
            }
        } else if (data.type === 'view') {
            try {
                if (!renderer || started) throw new Error('Export view is unavailable')
                if (!renderer.draw(data.time, data.time - data.settings.in, data.settings))
                    throw new GraphicsError('Export frame failed its graphics check')
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
