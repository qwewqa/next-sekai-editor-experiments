import type { Page } from '@playwright/test'
// A real imported USC chart keeps this smoke independent of app modules or
// test-only state hooks. BPM 60 places its note at 250 ms for simple mouse input.
export const chart = Buffer.from(
    JSON.stringify({
        version: 2,
        usc: {
            offset: 0,
            objects: [
                { type: 'bpm', beat: 0, bpm: 60 },
                {
                    type: 'single',
                    beat: 0.25,
                    timeScaleGroup: 0,
                    lane: 0,
                    size: 1.5,
                    critical: false,
                    trace: false,
                },
            ],
        },
    }),
)

export const stereoWav = () => {
    const sampleRate = 48000
    const length = sampleRate * 2
    const data = Buffer.alloc(44 + length * 4)
    data.write('RIFF', 0)
    data.writeUInt32LE(data.length - 8, 4)
    data.write('WAVEfmt ', 8)
    data.writeUInt32LE(16, 16)
    data.writeUInt16LE(1, 20)
    data.writeUInt16LE(2, 22)
    data.writeUInt32LE(sampleRate, 24)
    data.writeUInt32LE(sampleRate * 4, 28)
    data.writeUInt16LE(4, 32)
    data.writeUInt16LE(16, 34)
    data.write('data', 36)
    data.writeUInt32LE(length * 4, 40)
    for (let i = 0; i < length; i++) {
        const t = i / sampleRate
        const sample = t % 0.5 < 0.1 ? Math.round(Math.sin(t * Math.PI * 2 * 1500) * 12000) : 0
        data.writeInt16LE(sample, 44 + i * 4)
        data.writeInt16LE(-sample, 46 + i * 4)
    }
    return data
}

declare global {
    interface Window {
        productionSmoke: {
            preview: number
            chart: number
            overlay: number
            uploads: number
            fftTiles: number
            fftDraws: number
        }
    }
}

// Observe browser drawing APIs without importing source modules or changing
// application state. Only file-picker availability is overridden, to exercise
// the supported download fallback consistently in headless Chromium.
export const instrumentRendering = () => {
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined })
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
    window.productionSmoke = {
        preview: 0,
        chart: 0,
        overlay: 0,
        uploads: 0,
        fftTiles: 0,
        fftDraws: 0,
    }
    type GL = WebGLRenderingContext | WebGL2RenderingContext
    let pngPublished = false
    const kind = ({ canvas }: GL) => {
        if (!(canvas instanceof HTMLCanvasElement)) return
        if (canvas.classList.contains('editor-chart')) return 'chart'
        if (canvas.classList.contains('editor-overlay')) return 'overlay'
        if (canvas.matches('.preview-viewport > canvas:not(.preview-selection)')) return 'preview'
    }
    const textures = new WeakMap<
        GL,
        { unit: number; bindings: Map<number, WebGLTexture | null>; waveform: Set<WebGLTexture> }
    >()
    const state = (gl: GL) => {
        let value = textures.get(gl)
        if (!value) {
            value = { unit: gl.TEXTURE0, bindings: new Map(), waveform: new Set() }
            textures.set(gl, value)
        }
        return value
    }
    const textureSize = (args: unknown[], sub: boolean) => {
        if (args.length >= 9) return [Number(args[sub ? 4 : 3]), Number(args[sub ? 5 : 4])]
        const source = args[sub ? 6 : 5]
        if (source instanceof HTMLImageElement) return [source.naturalWidth, source.naturalHeight]
        if (
            source instanceof HTMLCanvasElement ||
            source instanceof ImageBitmap ||
            source instanceof ImageData
        )
            return [source.width, source.height]
        return []
    }
    const upload = (gl: GL, args: unknown[], sub: boolean) => {
        const target = kind(gl)
        if (target === 'preview' && args.some((arg) => arg instanceof ImageBitmap))
            window.productionSmoke.uploads++
        if (target !== 'chart' || !pngPublished) return
        const [width, height] = textureSize(args, sub)
        // FFT tiles keep their 128 columns at every max-reduction level. Only
        // count actual chart draws using that uploaded texture, not allocations.
        if (width !== 128 || !height || height > 2000) return
        const current = state(gl)
        const texture = current.bindings.get(current.unit)
        if (texture) current.waveform.add(texture)
    }
    for (const prototype of [
        WebGLRenderingContext.prototype,
        ...(typeof WebGL2RenderingContext === 'undefined'
            ? []
            : [WebGL2RenderingContext.prototype]),
    ]) {
        const wrap = (name: string, observe: (gl: GL, args: unknown[]) => void) => {
            // Some browsers inherit shared methods; wrapping only their owner
            // avoids counting a WebGL2 call twice.
            if (!Object.hasOwn(prototype, name)) return
            const methods = prototype as unknown as Record<string, (...args: unknown[]) => unknown>
            const original = methods[name]!
            methods[name] = function (this: GL, ...args: unknown[]) {
                observe(this, args)
                return Reflect.apply(original, this, args)
            }
        }
        wrap('clear', (gl, args) => {
            if (!(Number(args[0]) & gl.COLOR_BUFFER_BIT)) return
            const target = kind(gl)
            if (target) window.productionSmoke[target]++
        })
        wrap('activeTexture', (gl, args) => (state(gl).unit = Number(args[0])))
        wrap('bindTexture', (gl, args) => {
            if (args[0] === gl.TEXTURE_2D)
                state(gl).bindings.set(state(gl).unit, args[1] as WebGLTexture | null)
        })
        wrap('deleteTexture', (gl, args) => state(gl).waveform.delete(args[0] as WebGLTexture))
        wrap('texImage2D', (gl, args) => upload(gl, args, false))
        wrap('texSubImage2D', (gl, args) => upload(gl, args, true))
        for (const name of [
            'drawArrays',
            'drawElements',
            'drawArraysInstanced',
            'drawElementsInstanced',
        ])
            wrap(name, (gl) => {
                const target = kind(gl)
                // A renderer can erase with a blended draw rather than gl.clear.
                // Observe all chart/overlay GPU work so an unnecessary redraw
                // cannot hide behind that implementation detail.
                if (target === 'chart' || target === 'overlay') window.productionSmoke[target]++
                if (target !== 'chart') return
                const current = state(gl)
                if (
                    [...current.bindings.values()].some(
                        (texture) => texture && current.waveform.has(texture),
                    )
                )
                    window.productionSmoke.fftDraws++
            })
    }
    const createUrl = URL.createObjectURL
    URL.createObjectURL = (blob) => {
        const url = createUrl.call(URL, blob)
        if (blob instanceof Blob && blob.type === 'image/png') {
            // Waveform samples are encoded directly as PNG, without a canvas.
            // Decode the actual published blob to validate its dimensions;
            // observe uploads immediately so that this async decode cannot
            // miss the first chart frame using the retained raw pixels.
            pngPublished = true
            void createImageBitmap(blob)
                .then((bitmap) => {
                    if (bitmap.width === 128 && bitmap.height === 2000)
                        window.productionSmoke.fftTiles++
                    bitmap.close()
                })
                .catch(() => {
                    // An invalid PNG deliberately leaves fftTiles unchanged.
                })
        }
        return url
    }
}

/** The fixture's version, and the release already seen: seeded settings make an existing user, who would otherwise see "Updated to version" over the canvas. */
/** The preview's lit pixels, from a screenshot: a canvas drawn in a worker cannot be read back. */
export const previewPixels = async (page: Page) => {
    const png = await page.locator('.preview-viewport').screenshot()
    return page.evaluate(async (png) => {
        const image = new Image()
        image.src = `data:image/png;base64,${png}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(image, 0, 0)
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        let lit = 0
        // The viewport is black where nothing is drawn.
        for (let i = 0; i < data.length; i += 4)
            if (data[i]! + data[i + 1]! + data[i + 2]! > 96) lit++
        return lit
    }, png.toString('base64'))
}

/** Whether the preview's canvas was given to its worker: the page can no longer draw into it. */
export const previewInWorker = (page: Page) =>
    page
        .locator('.preview-viewport > canvas')
        .first()
        .evaluate((canvas: HTMLCanvasElement) => {
            try {
                canvas.getContext('webgl2')
                return false
            } catch {
                return true
            }
        })

/** Whether a worker can draw WebGL2 into an OffscreenCanvas, which the preview's worker needs. */
export const workerWebgl2 = (page: Page) =>
    page.evaluate(
        () =>
            new Promise<boolean>((resolve) => {
                const source = `postMessage(typeof OffscreenCanvas === 'function' && new OffscreenCanvas(1, 1).getContext('webgl2') !== null)`
                const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
                const worker = new Worker(url)
                const done = (value: boolean) => {
                    worker.terminate()
                    URL.revokeObjectURL(url)
                    resolve(value)
                }
                worker.onmessage = (event) => done(event.data === true)
                worker.onerror = () => done(false)
            }),
    )

/** The errors the app recorded for Copy Diagnostic Info. */
export const diagnostics = (page: Page) =>
    page.evaluate(() => localStorage.getItem('sonolus-next-sekai-editor.diagnostics') ?? '')

export const seedVersion = () => {
    localStorage.setItem('nse.test.version', JSON.stringify({ appVersion: '0.6.0', atTag: true }))
    localStorage.setItem('sonolus-next-sekai-editor.lastAppVersion', JSON.stringify('0.6.0'))
}
