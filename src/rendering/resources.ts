import {
    BufferImageSource,
    Container,
    EventSystem,
    extensions,
    ImageSource as PixiImageSource,
    RenderTexture,
    SchedulerSystem,
    Texture,
    WebGLRenderer,
    type TextureSource,
} from 'pixi.js'
import { initializeLyon } from './lyon'
import { RenderingScheduler } from './scheduler'

// Input and frame scheduling belong to the editor. Neither Pixi's hit testing
// nor its system ticker is needed; its GC runs at idle time after renders.
extensions.remove(EventSystem, SchedulerSystem)
extensions.add(RenderingScheduler)

/**
 * Cached images are immutable. Release an image before changing its pixels.
 * Sources are editor glyph canvases, decoded waveform images and CPU waveform pixels.
 */
export type ImageSource = HTMLCanvasElement | HTMLImageElement | ImageData
export type Client = { flush(): void; dispose(): void; resetSurface(): void }
/**
 * Pixi unloads what was unused for 60 s on this period, at idle time (`RenderingScheduler`).
 * A pass also walks every tracked resource, so it is not run often; a third of Pixi's 30 s
 * default keeps the batch it unloads small.
 */
export const GC_FREQUENCY = 10_000
const imageBudget = 96 * 1024 * 1024
export class RenderingResources {
    readonly renderer = new WebGLRenderer()
    readonly gl: WebGL2RenderingContext
    readonly ready: Promise<void>
    readonly maxSurfaceSize: number
    readonly clients = new Set<Client>()
    initialized = false
    lost = false
    resourceOwner = {}
    private disposed = false
    private initializationSettled = false
    private rendererDestroyed = false
    private readonly images = new Map<ImageSource, { texture: Texture; bytes: number }>()
    private imageBytes = 0
    private readonly readers = new Map<TextureSource, Set<() => void>>()

    constructor(readonly canvas: HTMLCanvasElement) {
        const attrs: WebGLContextAttributes = {
            alpha: true,
            antialias: true,
            stencil: true,
            depth: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: true,
        }
        const gl = canvas.getContext('webgl2', attrs)
        if (!gl) throw new Error('Unable to create the editor WebGL2 context')
        this.gl = gl
        const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
        this.maxSurfaceSize = Math.min(
            gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
            gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
            ...viewport,
        )
        canvas.addEventListener('webglcontextlost', this.onLost)
        canvas.addEventListener('webglcontextrestored', this.onRestored)
        // Cached paths own copied geometry; JS entries remain valid while a
        // later cache miss starts using Lyon. Asset loading never gates drawing.
        void initializeLyon()
        this.ready = this.renderer
            .init({
                canvas,
                context: gl,
                preferWebGLVersion: 2,
                width: Math.max(1, canvas.width),
                height: Math.max(1, canvas.height),
                resolution: 1,
                antialias: true,
                backgroundAlpha: 0,
                clearBeforeRender: false,
                preserveDrawingBuffer: true,
                skipExtensionImports: true,
                gcFrequency: GC_FREQUENCY,
            })
            .then(() => {
                this.initializationSettled = true
                this.initialized = true
                if (this.disposed) {
                    this.destroyRenderer()
                    return
                }
                this.renderer.resize(Math.max(1, canvas.width), Math.max(1, canvas.height), 1)
                for (const client of [...this.clients].reverse()) client.flush()
                if (!this.lost) canvas.dispatchEvent(new Event('renderingready'))
            })
            .catch((error: unknown) => {
                this.initializationSettled = true
                this.dispose()
                this.destroyRenderer()
                throw error
            })
    }
    target(width: number, height: number) {
        if (this.disposed) throw new Error('The editor renderer has been disposed')
        if (
            !Number.isInteger(width) ||
            !Number.isInteger(height) ||
            width <= 0 ||
            height <= 0 ||
            width > this.maxSurfaceSize ||
            height > this.maxSurfaceSize
        )
            throw new RangeError('WebGL target exceeds hardware limits')
        return RenderTexture.create({
            width,
            height,
            resolution: 1,
            antialias: true,
            scaleMode: 'linear',
        })
    }
    render(container: Container, target: RenderTexture | undefined, clear: boolean) {
        if (!this.initialized || this.lost || this.disposed) return false
        this.renderer.render({
            container,
            target,
            clear,
            clearColor: [0, 0, 0, 0],
        })
        return true
    }
    pixels(target: RenderTexture) {
        return this.renderer.extract.pixels({ target })
    }
    addReader(source: TextureSource, flush: () => void) {
        let set = this.readers.get(source)
        if (!set) this.readers.set(source, (set = new Set()))
        set.add(flush)
    }
    removeReader(source: TextureSource, flush: () => void) {
        const set = this.readers.get(source)
        set?.delete(flush)
        if (!set?.size) this.readers.delete(source)
    }
    flushReaders(source: TextureSource) {
        const set = this.readers.get(source)
        if (!set) return
        this.readers.delete(source)
        for (const flush of set) flush()
    }
    image(source: ImageSource) {
        const hit = this.images.get(source)
        if (hit) {
            this.images.delete(source)
            this.images.set(source, hit)
            return hit.texture
        }
        let textureSource: TextureSource
        if (source instanceof ImageData) {
            const pixels = new Uint8Array(source.data.length)
            for (let i = 0; i < pixels.length; i += 4) {
                const alpha = source.data[i + 3] ?? 0
                for (let c = 0; c < 3; c++)
                    pixels[i + c] = Math.round(((source.data[i + c] ?? 0) * alpha) / 255)
                pixels[i + 3] = alpha
            }
            textureSource = new BufferImageSource({
                resource: pixels,
                width: source.width,
                height: source.height,
                format: 'rgba8unorm',
                alphaMode: 'premultiplied-alpha',
                scaleMode: 'linear',
            })
        } else {
            textureSource = new PixiImageSource({
                resource: source,
                alphaMode: 'premultiply-alpha-on-upload',
                scaleMode: 'linear',
            })
        }
        const texture = new Texture({ source: textureSource })
        const bytes = texture.width * texture.height * 4
        this.images.set(source, { texture, bytes })
        this.imageBytes += bytes
        while (this.images.size > 1024 || this.imageBytes > imageBudget) {
            const oldest = this.images.keys().next()
            if (oldest.done || oldest.value === source) break
            this.releaseImage(oldest.value)
        }
        return texture
    }
    releaseImage(source: ImageSource) {
        const value = this.images.get(source)
        if (!value) return
        this.flushReaders(value.texture.source)
        value.texture.destroy(true)
        this.images.delete(source)
        this.imageBytes -= value.bytes
    }
    private readonly onLost = (event: Event) => {
        event.preventDefault()
        this.lost = true
    }
    private readonly onRestored = () => {
        // Pixi registered its own restore listener during asynchronous init. Wait
        // a task, not a microtask: native event dispatch can run microtasks between
        // listeners, before Pixi has invalidated its native object maps.
        setTimeout(() => {
            if (this.disposed) return
            if (!this.initialized) {
                void this.ready.then(
                    () => {
                        this.finishRestore()
                    },
                    () => {
                        /* Initialization failure already disposes the owner. */
                    },
                )
                return
            }
            this.finishRestore()
        }, 0)
    }
    private finishRestore() {
        if (this.disposed || !this.initialized || this.gl.isContextLost()) return
        // Pixi rebuilds only texture units 0–15 during contextChange. Devices
        // using more units can retain cached sources whose GL handles were lost,
        // skipping their first upload. Invalidate every cached binding before draw.
        this.renderer.texture.resetState()
        this.resourceOwner = {}
        this.readers.clear()
        // Reset invalidates dimensions so each client's next draw recreates its target.
        for (const client of this.clients) client.resetSurface()
        this.lost = false
        this.canvas.dispatchEvent(new Event('renderingready'))
    }
    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.lost = true
        this.readers.clear()
        for (const client of [...this.clients]) client.dispose()
        this.clients.clear()
        for (const source of [...this.images.keys()]) this.releaseImage(source)
        this.canvas.removeEventListener('webglcontextlost', this.onLost)
        this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
        // init awaits each Pixi system. Destroying/losing its context partway
        // through that sequence leaves later systems initializing on a dead GL.
        if (this.initializationSettled) this.destroyRenderer()
    }
    private destroyRenderer() {
        if (this.rendererDestroyed) return
        this.rendererDestroyed = true
        try {
            this.renderer.destroy({ removeView: false })
        } catch (error) {
            // A failed init can leave systems without their required GL state.
            // The native context is still released below; successful init must
            // not conceal an unexpected destruction error.
            if (this.initialized) throw error
        } finally {
            // Pixi's protected bound handlers may survive a partially failed
            // system teardown; detach them even when renderer.destroy threw.
            const context = this.renderer.context as unknown as
                | {
                      handleContextLost: EventListener
                      handleContextRestored: EventListener
                  }
                | undefined
            if (context) {
                this.canvas.removeEventListener('webglcontextlost', context.handleContextLost)
                this.canvas.removeEventListener(
                    'webglcontextrestored',
                    context.handleContextRestored,
                )
            }
            this.initialized = false
            this.gl.getExtension('WEBGL_lose_context')?.loseContext()
        }
    }
}
