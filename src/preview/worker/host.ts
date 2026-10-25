import { reactive, shallowRef } from 'vue'
import { recordDiagnostic } from '../../diagnostics'
import { onResetState } from '../../history/resetHooks'
import { PERF, recordSample } from '../../perf/probe'
import { testKeysOpen } from '../../platform/testKeys'
import type { State } from '../../state'
import type { PreviewFrameInput, PreviewSelection } from '../drawFrame'
import type { LoadedParticle } from '../particle'
import type { LoadedSkin } from '../skin'
import { decodeAtlasesAgain } from '../usePreviewResources'
import { createMirrorSender, selectionPlaces } from './mirror'
import previewWorkerUrl from './preview.worker?worker&url'
import type {
    FromPreviewWorker,
    PreviewWorkerCounters,
    PreviewWorkerFlags,
    ToPreviewWorker,
} from './protocol'

// The main side of the worker host: it transfers the panel's canvases and the atlases to the
// preview's worker, sends each frame's chart changes, selection and time, and hands over to
// the main host when the worker fails.

/** `main` or `worker`: which host draws the preview. */
export const PREVIEW_HOST_KEY = 'nse.test.previewHost'
/** The worker host's test flags (PreviewWorkerFlags, as JSON). */
export const PREVIEW_WORKER_FLAGS_KEY = 'nse.test.previewWorker'

const readKey = (key: string) => {
    // Perf builds read it too, so one build can measure both hosts.
    if (!testKeysOpen && !PERF) return null
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

const readFlags = (): PreviewWorkerFlags => {
    try {
        const parsed = JSON.parse(readKey(PREVIEW_WORKER_FLAGS_KEY) ?? '{}') as unknown
        return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
        return {}
    }
}

/** Whether the browser has what the worker host needs; its WebGL2 is checked when it starts. */
const canUseWorkerHost = () =>
    typeof Worker === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'

/**
 * Which host draws the preview: the main thread, unless the test key asks for the worker and
 * the browser can run it. A worker that fails hands over to the main thread for the rest of
 * the page's life.
 */
const initialHost: 'main' | 'worker' =
    readKey(PREVIEW_HOST_KEY) === 'worker' && canUseWorkerHost() ? 'worker' : 'main'
export const previewHost = reactive({
    kind: initialHost,
    /** The worker's canvases still show its last frame, until the main host draws one. */
    retiring: false,
})

type PreviewTestCounters = {
    uploads: number
    frames: number
    vertices: number[]
    aspect: number
}

const addCounters = (counters: PreviewWorkerCounters) => {
    const target = (window as { previewTest?: PreviewTestCounters }).previewTest
    if (!target) return
    target.uploads += counters.uploads
    target.frames += counters.frames
    if (counters.vertices) target.vertices = counters.vertices
    if (counters.aspect !== undefined) target.aspect = counters.aspect
}

const startWorker = () => {
    const flags = readFlags()
    const timeoutMs = flags.timeoutMs ?? 10_000
    const worker = new Worker(previewWorkerUrl, {
        type: import.meta.env.DEV ? 'module' : 'classic',
        name: 'nse-preview',
    })
    const post = (message: ToPreviewWorker, transfer: Transferable[] = []) => {
        worker.postMessage(message, transfer)
    }
    post({ type: 'start', test: testKeysOpen && 'previewTest' in window, flags })

    /** The worker's renderer's limit, once its context is ready. */
    const maxViewportSize = shallowRef<{ width: number; height: number }>()
    let stopped = false
    let attached = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let postedAt = 0
    let pending: (() => void) | undefined
    const sender = createMirrorSender()
    // A chart switch sends a first copy, and the worker starts a new builder.
    onResetState(sender.reset)
    let sentSelection: PreviewSelection | undefined | null = null
    // The objects whose atlases the worker holds, by slot: skin, then particle.
    const lent: (LoadedSkin | LoadedParticle | undefined)[] = []
    let onAtlases: ((bitmaps: (ImageBitmap | undefined)[]) => void) | undefined
    let onOutlinePixels: ((lit: number) => void) | undefined
    let onContext: ((lost: boolean) => void) | undefined
    let onSettled: (() => void)[] = []

    const wait = (why: string) => {
        clearTimeout(timer)
        timer = setTimeout(() => void handOver(why, false), timeoutMs)
    }
    const settle = () => {
        clearTimeout(timer)
        timer = undefined
    }

    const handOver = async (why: string, responsive: boolean) => {
        if (stopped) return
        stopped = true
        settle()
        pending = undefined
        recordDiagnostic(
            'error',
            `The preview worker stopped, and the preview draws on the main thread: ${why}`,
        )
        // A worker that still answers hands the atlases back; otherwise they are decoded again.
        let returned = false
        if (responsive && lent.some(Boolean)) {
            const bitmaps = await new Promise<(ImageBitmap | undefined)[] | undefined>(
                (resolve) => {
                    onAtlases = resolve
                    post({ type: 'return' })
                    setTimeout(() => {
                        resolve(undefined)
                    }, 1000)
                },
            )
            if (bitmaps) {
                for (const [slot, loaded] of lent.entries()) {
                    const bitmap = bitmaps[slot]
                    if (loaded && bitmap) loaded.texture = bitmap
                }
                returned = true
            }
        }
        worker.terminate()
        if (!returned && lent.some(Boolean)) decodeAtlasesAgain()
        previewHost.retiring = attached > 0
        previewHost.kind = 'main'
    }

    worker.addEventListener('message', (event: MessageEvent<FromPreviewWorker>) => {
        const message = event.data
        switch (message.type) {
            case 'ready':
                settle()
                // The same limit again redraws nothing: the canvas's own change asked for a frame.
                if (
                    maxViewportSize.value?.width !== message.maxViewportSize.width ||
                    maxViewportSize.value.height !== message.maxViewportSize.height
                )
                    maxViewportSize.value = message.maxViewportSize
                return
            case 'failed':
                void handOver(`its WebGL2 context could not be created: ${message.message}`, true)
                return
            case 'error':
                void handOver(`it failed: ${message.message}`, true)
                return
            case 'drawn': {
                if (stopped) return
                settle()
                inFlight = false
                recordSample('previewWorkerDraw', message.ms)
                recordSample('previewWorkerAnswer', performance.now() - postedAt)
                const next = pending
                pending = undefined
                // A waiting frame goes now; otherwise the host is idle.
                if (next) next()
                else {
                    for (const resolve of onSettled) resolve()
                    onSettled = []
                }
                return
            }
            case 'atlases':
                onAtlases?.(message.bitmaps)
                return
            case 'counters':
                addCounters(message.counters)
                return
            case 'outlinePixels':
                onOutlinePixels?.(message.lit)
                return
            case 'context':
                onContext?.(message.lost)
                return
        }
    })
    worker.addEventListener('error', (event) => {
        event.preventDefault()
        void handOver(`it failed: ${event.message || 'no message'}`, true)
    })

    const transfer = (canvas: HTMLCanvasElement) => {
        try {
            return canvas.transferControlToOffscreen()
        } catch (error) {
            void handOver(`its canvas could not be transferred: ${String(error)}`, true)
        }
    }

    return {
        maxViewportSize,
        /** Gives the preview's canvas to the worker; the returned function takes it away. */
        attachCanvas: (canvas: HTMLCanvasElement, antialias: boolean) => {
            if (stopped) return () => undefined
            const offscreen = transfer(canvas)
            if (!offscreen) return () => undefined
            attached++
            post({ type: 'canvas', canvas: offscreen, antialias }, [offscreen])
            wait('it did not start')
            return () => {
                attached--
                if (!stopped) post({ type: 'canvas', antialias })
            }
        },
        attachOverlay: (canvas: HTMLCanvasElement) => {
            if (stopped) return () => undefined
            const offscreen = transfer(canvas)
            if (!offscreen) return () => undefined
            post({ type: 'overlay', canvas: offscreen }, [offscreen])
            return () => {
                if (!stopped) post({ type: 'overlay' })
            }
        },
        /** Moves an atlas to the worker, which keeps it and closes the one it replaces. */
        lendAtlas: (slot: 0 | 1, loaded: LoadedSkin | LoadedParticle) => {
            // A moved bitmap is detached, with no size: it is already the worker's.
            if (stopped || lent[slot] === loaded || !loaded.texture.width) return
            lent[slot] = loaded
            post(
                {
                    type: 'atlas',
                    slot,
                    bitmap: loaded.texture,
                    interpolation: loaded.interpolation,
                    sprites: 'skin' in loaded ? loaded.skin : loaded.particle,
                },
                [loaded.texture],
            )
        },
        /** Runs `send` now, or once the frame in flight is answered; a later request replaces it. */
        request: (send: () => void) => {
            if (stopped) return
            if (!inFlight) {
                send()
                return
            }
            if (pending) recordSample('previewReplaced', 0)
            pending = send
        },
        /** Posts a frame: what changed in the chart, the selection if it changed, and the time. */
        post: (state: State, selection: PreviewSelection | undefined, input: PreviewFrameInput) => {
            if (stopped) return
            const mirror = sender.diff(state)
            const transfers: Transferable[] = []
            if (mirror?.slides) transfers.push(mirror.slides.order.buffer)
            let places: { places: Int32Array; stages: number[] } | null | undefined
            if (selection !== sentSelection || mirror?.slides) {
                places = selection
                    ? {
                          places: selectionPlaces(state, selection.objects),
                          stages: [...selection.stages],
                      }
                    : null
                if (places) transfers.push(places.places.buffer)
                sentSelection = selection
            }
            inFlight = true
            postedAt = performance.now()
            wait('a frame got no answer')
            post({ type: 'frame', mirror, selection: places, input }, transfers)
        },
        /** For tests: the outline's drawn pixels, read in the worker. */
        outlinePixels: () =>
            new Promise<number>((resolve) => {
                if (stopped) {
                    resolve(0)
                    return
                }
                onOutlinePixels = resolve
                post({ type: 'outlinePixels' })
            }),
        /** For tests: resolves once no frame is in flight or waiting. */
        settled: () =>
            new Promise<void>((resolve) => {
                if (inFlight && !stopped) onSettled.push(resolve)
                else resolve()
            }),
        /** For tests: loses or restores the worker's preview context, once it reports so. */
        setContextLost: (lost: boolean) =>
            new Promise<void>((resolve) => {
                onContext = (value) => {
                    if (value === lost) resolve()
                }
                post({ type: lost ? 'loseContext' : 'restoreContext' })
            }),
    }
}

let client: ReturnType<typeof startWorker> | undefined

/** The page's preview worker, started on first use. */
export const previewWorker = () => (client ??= startWorker())
