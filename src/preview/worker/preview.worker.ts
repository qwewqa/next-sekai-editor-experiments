// The preview's worker: a mirror of the chart input, the chart builder, the renderers of the
// preview and its selection outline, and the atlases. It draws into canvases transferred from
// the panel, and each frame reaches the screen when its message's task ends. The main thread
// keeps the clock and decides what each frame shows; the worker draws when a frame is posted.
import { drawPreviewFrame, type PreviewFrameInput, type PreviewSelection } from '../drawFrame'
import { createPreviewChartBuilder } from '../engine/chart'
import { createPreviewRenderer, type PreviewRenderer } from '../gl'
import { createOutlineRenderer, type OutlineRenderer } from '../outlineRenderer'
import type { PreviewParticle } from '../particle'
import type { PreviewSkin } from '../skin'
import { applyMirror, selectedObjects, type MirrorState } from './mirror'
import type {
    FromPreviewWorker,
    PreviewWorkerCounters,
    PreviewWorkerFlags,
    ToPreviewWorker,
} from './protocol'

// The app's types are the DOM's; a worker's scope posts as a window does, without an origin.
const scope = self as unknown as {
    postMessage: (message: unknown, transfer: Transferable[]) => void
    onmessage: ((event: MessageEvent<ToPreviewWorker>) => void) | null
}
const post = (message: FromPreviewWorker, transfer: Transferable[] = []) => {
    scope.postMessage(message, transfer)
}
const messageOf = (error: unknown) =>
    error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)

let flags: PreviewWorkerFlags = {}
let frameCount = 0

let canvas: OffscreenCanvas | undefined
let antialias = true
let renderer: PreviewRenderer | undefined
let lost = false
let lose: WEBGL_lose_context | null | undefined
let outline: OutlineRenderer | undefined

// The skin's and the particle's atlases, kept for the page's lifetime and uploaded to every
// new context.
const atlases: ({ bitmap: ImageBitmap; interpolation: boolean } | undefined)[] = []
const uploaded: (ImageBitmap | undefined)[] = []
let skin: PreviewSkin | undefined
let particle: PreviewParticle | undefined

let mirror: MirrorState | undefined
let build = createPreviewChartBuilder()
let places: { places: Int32Array; stages: number[] } | undefined
let selection: PreviewSelection | undefined
let lastInput: PreviewFrameInput | undefined

let counters: PreviewWorkerCounters | undefined

const upload = () => {
    if (!renderer) return
    for (const slot of [0, 1] as const) {
        const atlas = atlases[slot]
        if (!atlas || uploaded[slot] === atlas.bitmap) continue
        renderer.setTexture(slot, atlas.bitmap, atlas.interpolation)
        uploaded[slot] = atlas.bitmap
    }
}

const createRenderer = () => {
    if (!canvas || renderer || lost) return
    if (flags.noWebgl) throw new Error('WebGL2 is unavailable or disabled in this browser')
    // The renderer needs only a canvas's size and context, which an OffscreenCanvas has.
    renderer = createPreviewRenderer(canvas as unknown as HTMLCanvasElement, antialias)
    uploaded.length = 0
    upload()
}

const draw = () => {
    if (!renderer || lost || !skin || !mirror || !lastInput) return
    const chart = build(mirror, lastInput.noteSpeed)
    drawPreviewFrame(renderer, outline, skin, particle, chart, lastInput, selection)
}

const onLost = (event: Event) => {
    // Opt in to restoration; frames meanwhile are answered without drawing.
    event.preventDefault()
    lost = true
    renderer?.dispose()
    renderer = undefined
    if (counters) post({ type: 'context', lost: true })
}
const onRestored = () => {
    lost = false
    try {
        createRenderer()
        draw()
    } catch (error) {
        post({ type: 'error', message: messageOf(error) })
    }
    report()
    if (counters) post({ type: 'context', lost: false })
}

const releaseCanvas = () => {
    renderer?.dispose()
    renderer = undefined
    canvas?.removeEventListener('webglcontextlost', onLost)
    canvas?.removeEventListener('webglcontextrestored', onRestored)
    canvas = undefined
    lost = false
    lose = undefined
}

const resolveSelection = () => {
    if (!places || !mirror) {
        selection = undefined
        return
    }
    const objects = selectedObjects(mirror, places.places)
    selection =
        objects.size || places.stages.length
            ? { objects, stages: new Set(places.stages) }
            : undefined
}

// Test builds count what the preview specs count on the main thread's canvas.
const installCounters = () => {
    const current: PreviewWorkerCounters = { uploads: 0, frames: 0 }
    counters = current
    const isPreview = (gl: WebGL2RenderingContext) => gl.canvas === canvas
    const names = new WeakMap<object, unknown>()
    const prototype = WebGL2RenderingContext.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
    >
    const watch = (
        name: string,
        see: (gl: WebGL2RenderingContext, args: unknown[], result: unknown) => void,
    ) => {
        const original = prototype[name]
        if (!original) return
        prototype[name] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
            const result: unknown = Reflect.apply(original, this, args)
            see(this, args, result)
            return result
        }
    }
    watch('texImage2D', (gl, args) => {
        if (isPreview(gl) && args.some((arg) => arg instanceof ImageBitmap)) current.uploads++
    })
    watch('getUniformLocation', (_gl, args, location) => {
        if (location) names.set(location, args[1])
    })
    watch('uniform1f', (gl, [location, value]) => {
        if (isPreview(gl) && location && names.get(location) === 'u_aspect')
            current.aspect = value as number
    })
    watch('clear', (gl) => {
        if (!isPreview(gl)) return
        current.frames++
        current.vertices = []
    })
    watch('bufferSubData', (gl, args) => {
        const data = args[2]
        if (isPreview(gl) && data instanceof Float32Array) current.vertices?.push(...data)
    })
}

const report = () => {
    if (!counters) return
    const { uploads, frames, vertices, aspect } = counters
    if (!uploads && !frames && aspect === undefined) return
    post({ type: 'counters', counters: { uploads, frames, vertices, aspect } })
    counters.uploads = 0
    counters.frames = 0
    counters.vertices = undefined
    counters.aspect = undefined
}

const handle = (message: ToPreviewWorker) => {
    switch (message.type) {
        case 'start':
            flags = message.flags
            if (message.test) installCounters()
            if (flags.throwOnStart)
                setTimeout(() => {
                    throw new Error('The preview worker failed to start (test)')
                })
            return
        case 'canvas':
            releaseCanvas()
            if (!message.canvas) return
            canvas = message.canvas
            antialias = message.antialias
            canvas.addEventListener('webglcontextlost', onLost)
            canvas.addEventListener('webglcontextrestored', onRestored)
            try {
                createRenderer()
            } catch (error) {
                post({ type: 'failed', message: messageOf(error) })
                return
            }
            // The main thread posts a frame for the new canvas.
            if (renderer) post({ type: 'ready', maxViewportSize: renderer.maxViewportSize })
            return
        case 'overlay':
            outline?.dispose()
            outline =
                message.canvas &&
                createOutlineRenderer(message.canvas, (error) => {
                    post({ type: 'error', message: messageOf(error) })
                })
            return
        case 'atlas': {
            const previous = atlases[message.slot]
            if (previous && previous.bitmap !== message.bitmap) previous.bitmap.close()
            atlases[message.slot] = { bitmap: message.bitmap, interpolation: message.interpolation }
            if (message.slot === 0) skin = message.sprites as PreviewSkin
            else particle = message.sprites as PreviewParticle
            upload()
            return
        }
        case 'frame': {
            frameCount++
            if (flags.throwOnFrame === frameCount)
                throw new Error('The preview worker failed to draw (test)')
            if (flags.hangOnFrame === frameCount) for (;;);
            const start = performance.now()
            if (message.mirror) {
                // A chart switch releases the previous chart's compiled slides.
                if (message.mirror.reset) build = createPreviewChartBuilder()
                mirror = applyMirror(mirror, message.mirror)
            }
            if (message.selection !== undefined) places = message.selection ?? undefined
            if (message.selection !== undefined || message.mirror?.slides) resolveSelection()
            lastInput = message.input
            draw()
            const ms = performance.now() - start
            // A frame's counters reach the page before its answer.
            report()
            post({ type: 'drawn', ms })
            return
        }
        case 'return': {
            const bitmaps = [atlases[0]?.bitmap, atlases[1]?.bitmap]
            atlases.length = 0
            releaseCanvas()
            post(
                { type: 'atlases', bitmaps },
                bitmaps.filter((bitmap) => bitmap !== undefined),
            )
            return
        }
        case 'outlinePixels':
            post({ type: 'outlinePixels', lit: outline?.litPixels() ?? 0 })
            return
        case 'loseContext':
            lose = canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')
            lose?.loseContext()
            return
        case 'restoreContext':
            lose?.restoreContext()
            return
    }
}

scope.onmessage = (event: MessageEvent<ToPreviewWorker>) => {
    try {
        handle(event.data)
    } catch (error) {
        post({ type: 'error', message: messageOf(error) })
    }
    report()
}
