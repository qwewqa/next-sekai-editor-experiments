import { createExportJob, createExportServices, type JobState } from '../../exportVideo/job'
import type { ExportFaults } from '../../exportVideo/protocol'
import type { ExportSettings } from '../../exportVideo/types'
import { state } from '../../history'
import { testKeysOpen } from '../../platform/testKeys'
import { FileError } from '../../platform/types'
import { webVideoOutput } from '../../platform/webVideoOutput'
import { drawPreviewFrame } from '../../preview/drawFrame'
import { createPreviewChartBuilder } from '../../preview/engine/chart'
import { createPreviewRenderer } from '../../preview/gl'
import { copyExportAssets } from './assets'

export type ExportTestOptions = {
    mux?: boolean
    settings?: Partial<ExportSettings>
    cancelAt?: JobState['phase'] | 'mix' | 'drain' | 'finalize' | 'view'
    loseContextAt?: number
    parityAt?: number
    previewFirst?: boolean
    backgroundBlur?: number
    failWrite?: boolean
    incompleteTarget?: 'foreground' | 'composite'
}

const services = createExportServices()

export const exportVideoTest = async (options: ExportTestOptions = {}) => {
    if (!testKeysOpen) throw new Error('Export test hook is disabled')
    const settings: ExportSettings = {
        in: 0,
        frames: 75,
        frameRate: 30,
        width: 320,
        height: 180,
        format: 'webm',
        videoBitrate: 1_000_000,
        audioBitrate: 128_000,
        bgm: true,
        sfx: false,
        bgmVolume: 100,
        sfxVolume: 100,
        fadeIn: 0,
        fadeOut: 0,
        renderScale: 1,
        antialias: false,
        noteSpeed: 6,
        showEffects: true,
        showCombo: true,
        backdrop: [0.08, 0.08, 0.1],
        ...options.settings,
    }
    const phases: JobState['phase'][] = []
    let closeGuard: (() => boolean | Promise<boolean>) | undefined
    let reference: Uint8Array | undefined
    let exported: Uint8Array | undefined
    let capturedSize: number[] | undefined
    let finishingCancel: boolean | undefined
    let runningPixels: number | undefined
    const bgm = new AudioBuffer({
        numberOfChannels: 2,
        sampleRate: 48000,
        length: (settings.frames * 48000) / settings.frameRate,
    })
    for (let channel = 0; channel < 2; channel++) {
        const plane = bgm.getChannelData(channel)
        for (let i = 0; i < plane.length; i++)
            plane[i] = Math.sin((i * 2 * Math.PI * 440) / 48000) * 0.25
    }
    const faults: ExportFaults = {
        failWrite: options.failWrite,
        loseContextAt: options.loseContextAt,
        pixelsAt: options.parityAt,
    }
    if (options.cancelAt === 'drain' || options.cancelAt === 'finalize')
        faults.hold = options.cancelAt
    const job = createExportJob({
        snapshot: state.value,
        settings,
        buffers: { bgm: { buffer: bgm, offset: -settings.in }, sfx: {} },
        services,
        platform: {
            onCloseRequested: (handler) => {
                closeGuard = handler
                return () => {
                    closeGuard = undefined
                }
            },
        },
        assets: async (signal) => {
            const assets = await copyExportAssets(signal)
            if (assets.background && options.backgroundBlur !== undefined)
                assets.background.blur = options.backgroundBlur
            if (options.parityAt !== undefined) {
                const width = Math.round(settings.width * settings.renderScale)
                const height = Math.round(settings.height * settings.renderScale)
                const canvas = document.createElement('canvas')
                const renderer = createPreviewRenderer(canvas, false)
                try {
                    renderer.setRenderTarget({ width, height, antialias: settings.antialias })
                    renderer.setTexture(0, assets.skin.texture, assets.skin.interpolation)
                    if (assets.particle)
                        renderer.setTexture(
                            1,
                            assets.particle.texture,
                            assets.particle.interpolation,
                        )
                    const background = assets.background
                    if (background) renderer.setTexture(3, background.texture, true)
                    const result = drawPreviewFrame(
                        renderer,
                        undefined,
                        assets.skin.skin,
                        assets.particle?.particle,
                        createPreviewChartBuilder()(state.value, settings.noteSpeed),
                        {
                            time: settings.in + options.parityAt / settings.frameRate,
                            leftLimit: false,
                            width,
                            height,
                            displayWidth: (540 * settings.width) / settings.height,
                            displayHeight: 540,
                            overlayWidth: settings.width,
                            overlayHeight: settings.height,
                            noteSpeed: settings.noteSpeed,
                            showEffects: settings.showEffects,
                            showHitboxes: false,
                            showCombo: settings.showCombo,
                            backdrop: settings.backdrop,
                            background: background && {
                                ...background,
                                sigma: (background.blur * height) / 540,
                            },
                        },
                        undefined,
                    )
                    if (!result.drawn) throw new Error('Reference frame was not drawn')
                    const gl = canvas.getContext('webgl2')
                    if (!gl) throw new Error('Reference context is unavailable')
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
                    const pixels = new Uint8Array(width * height * 4)
                    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
                    reference = new Uint8Array(settings.width * settings.height * 4)
                    for (let y = 0; y < settings.height; y++)
                        for (let x = 0; x < settings.width; x++) {
                            const x0 = (x * width) / settings.width,
                                x1 = ((x + 1) * width) / settings.width
                            const y0 = (y * height) / settings.height,
                                y1 = ((y + 1) * height) / settings.height
                            for (let c = 0; c < 4; c++) {
                                let sum = 0
                                for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++)
                                    for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
                                        const weight =
                                            (Math.min(x1, sx + 1) - Math.max(x0, sx)) *
                                            (Math.min(y1, sy + 1) - Math.max(y0, sy))
                                        sum += (pixels[(sy * width + sx) * 4 + c] ?? 0) * weight
                                    }
                                reference[
                                    ((settings.height - 1 - y) * settings.width + x) * 4 + c
                                ] = Math.round(sum / ((x1 - x0) * (y1 - y0)))
                            }
                        }
                    if (!renderer.checkError())
                        throw new Error('Reference frame failed its graphics check')
                } finally {
                    renderer.dispose()
                }
            }
            return assets
        },
        destination: async (_signal, id) => {
            const stage = await webVideoOutput.stage(id, 'webm')
            return {
                worker: { kind: 'staged', handle: stage.handle },
                ready: {
                    file: () => webVideoOutput.file(id),
                    deliver: (file, how) => webVideoOutput.deliver(file, 'test.webm', how),
                    end: async () => {
                        await stage.endReady()
                    },
                },
                discard: async () => {
                    await webVideoOutput.remove(id)
                },
            }
        },
        worker: options.mux
            ? undefined
            : () => {
                  const worker = new Worker(new URL('./test.worker.ts', import.meta.url), {
                      type: 'module',
                      name: options.incompleteTarget ?? 'nse-export-test',
                  })
                  if (options.cancelAt === 'view')
                      worker.addEventListener(
                          'message',
                          (event: MessageEvent<{ type: string; bitmap?: ImageBitmap }>) => {
                              if (event.data.type !== 'view') return
                              event.stopImmediatePropagation()
                              event.data.bitmap?.close()
                              job.cancel()
                          },
                      )
                  return worker
              },
        changed: (next) => {
            phases.push(next.phase)
            if (next.phase === 'exporting' && runningPixels === undefined) {
                const marker = `exportVideoRunning.${job.id}`
                runningPixels = Number(localStorage.getItem(marker))
            }
            if (next.phase === options.cancelAt) {
                if (next.phase === 'finishing') finishingCancel = job.cancel()
                else job.cancel()
            }
        },
        test: {
            faults,
            event: (event) => {
                if (event.type === 'pixels') {
                    exported = event.pixels
                    capturedSize = [event.width, event.height]
                }
                if (event.type === 'held') job.cancel()
            },
        },
    })
    let viewSize: number[] | undefined
    if (options.previewFirst) {
        const views = await Promise.all([
            job.preview(settings.in),
            job.preview(settings.in + 0.1),
            job.preview(settings.in + 0.2, { width: 160, height: 90 }),
        ])
        for (const bitmap of views) {
            if (bitmap) {
                viewSize = [bitmap.width, bitmap.height]
                bitmap.close()
            }
        }
    }
    const pendingView =
        options.cancelAt === 'view' ? job.preview(settings.in).catch(() => undefined) : undefined
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with its context below, then restored.
    const render = OfflineAudioContext.prototype.startRendering
    let mixStarted = false
    if (options.cancelAt === 'mix')
        OfflineAudioContext.prototype.startRendering = function () {
            mixStarted = true
            const result = render.call(this)
            queueMicrotask(() => {
                job.cancel()
            })
            return result
        }
    let result: JobState
    try {
        result = await job.start()
    } finally {
        OfflineAudioContext.prototype.startRendering = render
    }
    await pendingView
    if (options.previewFirst && result.phase === 'ready') {
        const bitmap = await job.preview(settings.in)
        bitmap?.close()
    }
    const guarded = closeGuard ? !(await closeGuard()) : false
    let maxError: number | undefined
    if (reference && exported) {
        maxError = 0
        for (let i = 0; i < reference.length; i++)
            maxError = Math.max(maxError, Math.abs((reference[i] ?? 0) - (exported[i] ?? 0)))
    }
    const detail = result.phase === 'ready' || result.phase === 'done' ? result.result : undefined
    const error = result.phase === 'failed' ? String(result.error) : undefined
    const errorCode =
        result.phase === 'failed' && result.error instanceof FileError
            ? result.error.code
            : undefined
    const capturedMax = exported
        ? exported.reduce((max, value, i) => (i % 4 === 3 ? max : Math.max(max, value)), 0)
        : undefined
    const bytes =
        options.mux && result.phase === 'ready'
            ? Array.from(new Uint8Array(await result.file.arrayBuffer()))
            : undefined
    await job.dispose()
    let retained = false
    try {
        const directory = await (
            await navigator.storage.getDirectory()
        ).getDirectoryHandle('export-video')
        await directory.getFileHandle(`${job.id}.webm`)
        retained = true
    } catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
    }
    return {
        bytes,
        capturedSize,
        capturedMax,
        runningPixels,
        markerLeft: localStorage.getItem(`exportVideoRunning.${job.id}`) !== null,
        mixStarted,
        errorCode,
        viewSize,
        phase: result.phase,
        phases,
        result: detail,
        error,
        guarded,
        retained,
        maxError,
        finishingCancel,
    }
}

export type DialogTestOptions = {
    /** `done` ends without Ready, as a picked file does. */
    route?: 'staged' | 'done'
    picker?: boolean
    faults?: ExportFaults
    /** No render size is qualified for this device: every size is unavailable. */
    unqualified?: boolean
}

/** Opens the Export Video dialog with the test worker and sink; the dialog's state is returned. */
export const openExportVideoTest = async (options: DialogTestOptions = {}) => {
    if (!testKeysOpen) throw new Error('Export test hook is disabled')
    const { openExportVideo } = await import('./open')
    const budget = 16_800_000
    const budgets: Record<string, number> = { desktop: budget, tablet: budget, phone: budget }
    for (const memory of [0.25, 0.5, 1, 2, 4, 8, 16, 32]) budgets[`memory:${memory}`] = budget
    let exposed: ReturnType<typeof import('./dialog').createExportDialog> | undefined
    void openExportVideo(
        {
            picker: options.picker ?? false,
            budgets: options.unqualified ? {} : budgets,
            faults: options.faults,
            worker: () =>
                new Worker(new URL('./test.worker.ts', import.meta.url), {
                    type: 'module',
                    name: 'nse-export-test',
                }),
            destination: async ({ id, format }) => {
                const stage = await webVideoOutput.stage(id, format)
                const discard = async () => {
                    await webVideoOutput.remove(id)
                }
                if (options.route === 'done')
                    return {
                        worker: { kind: 'staged', handle: stage.handle },
                        // A finished file is removed at once: the test checks only the dialog.
                        discard,
                        ready: undefined,
                    }
                return {
                    worker: { kind: 'staged', handle: stage.handle },
                    ready: {
                        file: () => webVideoOutput.file(id),
                        deliver: (file, how) => webVideoOutput.deliver(file, `test.${format}`, how),
                        end: async () => {
                            await stage.endReady()
                        },
                    },
                    discard,
                }
            },
        },
        (dialog) => {
            exposed = dialog
            Reflect.set(window, 'exportVideoDialog', dialog)
        },
    )
    while (!exposed) await new Promise((resolve) => setTimeout(resolve, 10))
    return true
}
