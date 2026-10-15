import { expect, test } from '@playwright/test'
import type { EditorDrawContext } from '../../src/editor/canvas/types'

test.beforeEach(async ({ page }) => {
    // Isolate the real GPU renderer from unrelated app rendering.
    await page.route('**/__waveform-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }),
    )
    await page.goto('/__waveform-test')
})

test('5 ms waveform attacks survive minimum zoom and fractional scrolling', async ({ page }) => {
    const samples = await page.evaluate(async () => {
        const { createWaveformRenderer } = await import('/src/editor/canvas/waveform.ts')
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const source = document.createElement('canvas')
        source.width = 128
        source.height = 2000
        const sourceContext = source.getContext('2d')!
        const output = document.createElement('canvas')
        output.width = 256
        output.height = 1003
        const ctx = getDrawContext(output)
        if ('ready' in ctx) await ctx.ready
        const context = { ctx, scale: 32, pixelRatio: 1, ups: -100 / 32 } as EditorDrawContext
        const results: { row: number; translation: number; alpha: number; center: number }[] = []

        for (const row of [100, 101]) {
            const pixels = sourceContext.createImageData(128, 2000)
            pixels.data.fill(255)
            for (let y = 0; y < 2000; y++) {
                for (let x = 0; x < 128; x++) {
                    pixels.data[(y * 128 + x) * 4 + 3] = y === row && x < 4 ? 255 : 0
                }
            }
            sourceContext.putImageData(pixels, 0, 0)
            const waveform = {
                images: [source.toDataURL()],
                style: { imageRendering: 'pixelated' as const },
            }
            let loaded: () => void = () => {}
            const ready = new Promise<void>((resolve) => (loaded = resolve))
            const renderer = createWaveformRenderer(() => loaded())
            const draw = (translation: number) => {
                ctx.setTransform(1, 0, 0, 1, 0, 0)
                ctx.clearRect(0, 0, output.width, output.height)
                ctx.setTransform(32, 0, 0, 32, 128, 1000 + translation)
                renderer.draw(context, waveform, 0, { min: 0, max: 9.99 })
            }
            draw(0)
            await ready
            for (const translation of [0.25, 0.75]) {
                draw(translation)
                // The first four columns are the FFT peak strip, mirrored at
                // x=128. Sample inside its right half, away from the seam.
                const pixels = ctx.getImageData(129, 0, 1, output.height).data
                let alpha = 0
                let weightedPosition = 0
                for (let y = 0; y < output.height; y++) {
                    const value = pixels[y * 4 + 3]!
                    alpha += value
                    weightedPosition += (y + 0.5) * value
                }
                results.push({ row, translation, alpha, center: weightedPosition / alpha })
            }
            renderer.clear()
        }
        return results
    })

    for (const { row, translation, alpha, center } of samples) {
        expect(
            alpha,
            `attack row ${row} at ${translation}px translation disappeared`,
        ).toBeGreaterThan(0)
        expect(Math.abs(center - ((row + 0.5) / 2 + translation))).toBeLessThanOrEqual(1)
    }
})

test('waveform zoom reuses reductions and returns to the original raster when enlarged', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { createWaveformRenderer } = await import('/src/editor/canvas/waveform.ts')
        const { getDrawContext, WebGLDrawContext } = await import('/src/rendering/context.ts')
        const source = document.createElement('canvas')
        source.width = 128
        source.height = 2000
        const sourceContext = source.getContext('2d')!
        sourceContext.fillStyle = '#fff'
        sourceContext.fillRect(0, 101, 4, 1)
        const waveform = {
            images: [source.toDataURL()],
            style: { imageRendering: 'pixelated' as const },
        }
        const output = document.createElement('canvas')
        output.width = 256
        output.height = 4003
        const ctx = getDrawContext(output)
        if ('ready' in ctx) await ctx.ready
        const context = { ctx, scale: 32, pixelRatio: 1, ups: -100 / 32 } as EditorDrawContext
        let allocations = 0
        let readbacks = 0
        const createSurface = ctx.createSurface.bind(ctx)
        ctx.createSurface = (width, height) => {
            allocations++
            return createSurface(width, height)
        }
        const getImageData = WebGLDrawContext.prototype.getImageData
        WebGLDrawContext.prototype.getImageData = function (...args) {
            readbacks++
            return getImageData.apply(this, args)
        }
        const drawn: (CanvasImageSource | ImageData)[] = []
        const drawing = ctx as typeof ctx & { drawWaveform?: typeof ctx.drawImage }
        const drawMethod = typeof drawing.drawWaveform === 'function' ? 'drawWaveform' : 'drawImage'
        const drawImage = drawing[drawMethod]!
        drawing[drawMethod] = function (image, ...args: number[]) {
            drawn.push(image as CanvasImageSource | ImageData)
            return Reflect.apply(drawImage, this, [image, ...args])
        }
        let loaded: () => void = () => {}
        const ready = new Promise<void>((resolve) => (loaded = resolve))
        const renderer = createWaveformRenderer(() => loaded())
        const draw = (pps: number, translation: number) => {
            drawn.length = 0
            context.ups = -pps / 32
            ctx.setTransform(1, 0, 0, 1, 0, 0)
            ctx.clearRect(0, 0, output.width, output.height)
            ctx.setTransform(32, 0, 0, 32, 128, pps * 10 + translation)
            renderer.draw(context, waveform, 0, { min: 0, max: 9.99 })
        }
        draw(100, 0)
        await ready
        draw(100, 0.25)
        const reducedSource = drawn[0]
        const reducedHeight = reducedSource instanceof ImageData ? reducedSource.height : -1
        const initial = { allocations, readbacks }
        for (let i = 0; i < 4; i++) draw(100, i % 2 ? 0.25 : 0.75)
        const repeated = { allocations, readbacks }
        const reusesReducedSource = drawn.every((image) => image === reducedSource)
        draw(400, 0.25)
        const zoomedUsesOriginal = drawn.every(
            (image) => image instanceof HTMLImageElement && image.naturalHeight === 2000,
        )
        draw(100, 0.75)
        const returned = { allocations, readbacks }
        const returnsToCachedReduction = drawn.every((image) => image === reducedSource)
        renderer.clear()
        WebGLDrawContext.prototype.getImageData = getImageData
        ctx.dispose()
        return {
            reducedHeight,
            initial,
            repeated,
            returned,
            reusesReducedSource,
            zoomedUsesOriginal,
            returnsToCachedReduction,
        }
    })

    expect(result.reducedHeight).toBeGreaterThan(0)
    expect(result.reducedHeight).toBeLessThanOrEqual(1000)
    expect(result.initial).toEqual({ allocations: 1, readbacks: 1 })
    expect(result.repeated).toEqual(result.initial)
    expect(result.returned).toEqual(result.initial)
    expect(result.reusesReducedSource).toBe(true)
    expect(result.zoomedUsesOriginal).toBe(true)
    expect(result.returnsToCachedReduction).toBe(true)
})

test('waveform attacks survive fractional DPR and downward backing-size rounding', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { createWaveformRenderer } = await import('/src/editor/canvas/waveform.ts')
        const { prepareSurface } = await import('/src/editor/canvas/surface.ts')
        const width = 204.8
        const height = 1600.2
        const pixelRatio = 1.25
        const scale = width / 8
        const ups = -160 / scale
        const output = document.createElement('canvas')
        const source = document.createElement('canvas')
        source.width = 128
        source.height = 2000
        const sourceContext = source.getContext('2d')!
        const samples: { row: number; alpha: number; error: number }[] = []
        let actualTilePixels = 0

        // These attacks are far from both tile edges. Without accounting for
        // backing-size rounding each disappears at the corresponding scroll phase.
        for (const [row, translation] of [
            [400, -0.45],
            [801, -0.4],
            [1602, -0.3],
        ] as const) {
            sourceContext.clearRect(0, 0, source.width, source.height)
            sourceContext.fillStyle = '#fff'
            sourceContext.fillRect(0, row, 4, 1)
            const waveform = {
                images: [source.toDataURL()],
                style: { imageRendering: 'pixelated' as const },
            }
            let loaded: () => void = () => {}
            const ready = new Promise<void>((resolve) => (loaded = resolve))
            const renderer = createWaveformRenderer(() => loaded())
            const top = -62.5 - translation / (scale * pixelRatio)
            const bounds = {
                l: -4,
                r: 4,
                t: top,
                b: top + height / scale,
                w: 8,
                h: height / scale,
            }
            const draw = async () => {
                // The app resumes its first frame on this same readiness event.
                let resolveReady: () => void = () => {}
                const ready = new Promise<void>((resolve) => (resolveReady = resolve))
                output.addEventListener('renderingready', resolveReady, { once: true })
                let ctx = prepareSurface(output, width, height, pixelRatio, bounds)
                if (!ctx) {
                    await ready
                    ctx = prepareSurface(output, width, height, pixelRatio, bounds)!
                }
                output.removeEventListener('renderingready', resolveReady)
                renderer.draw({ ctx, ups, scale, pixelRatio } as EditorDrawContext, waveform, 0, {
                    min: 0,
                    max: 9.99,
                })
                return ctx
            }
            await draw()
            await ready
            const ctx = await draw()
            const transform = ctx.getTransform()
            actualTilePixels = 10 * Math.abs(ups) * transform.d
            const pixels = ctx.getImageData(129, 0, 1, output.height).data
            let alpha = 0
            let weightedPosition = 0
            for (let y = 0; y < output.height; y++) {
                const value = pixels[y * 4 + 3]!
                alpha += value
                weightedPosition += (y + 0.5) * value
            }
            const expected =
                transform.f - actualTilePixels + ((row + 0.5) / 2000) * actualTilePixels
            samples.push({ row, alpha, error: Math.abs(weightedPosition / alpha - expected) })
            renderer.clear()
        }
        return {
            backingHeight: output.height,
            nominalTilePixels: 10 * Math.abs(ups) * scale * pixelRatio,
            actualTilePixels,
            samples,
        }
    })

    expect(result.backingHeight).toBe(2000)
    expect(result.nominalTilePixels).toBe(2000)
    expect(result.actualTilePixels).toBeLessThan(result.nominalTilePixels)
    for (const { row, alpha, error } of result.samples) {
        expect(alpha, `attack row ${row} disappeared after backing-size rounding`).toBeGreaterThan(
            0,
        )
        expect(error).toBeLessThanOrEqual(1.25)
    }
})

test('generated waveform zooms reuse CPU peaks without image decode, GPU readback or Canvas2D', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { createWaveformRenderer } = await import('/src/editor/canvas/waveform.ts')
        const { createWaveform, releaseWaveform } = await import('/src/waveform.ts')
        const { getWaveformTilePixels } = await import('/src/waveform/tiles.ts')
        const { getDrawContext, WebGLDrawContext } = await import('/src/rendering/context.ts')
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = 1000
        const ctx = getDrawContext(canvas)
        if ('ready' in ctx) await ctx.ready
        // Waveform processing consumes decoded samples; no audio device is needed.
        const channel = new Float32Array(1440)
        const buffer = {
            length: channel.length,
            duration: channel.length / 48000,
            sampleRate: 48000,
            numberOfChannels: 1,
            getChannelData: () => channel,
        } as unknown as AudioBuffer
        const samples = buffer.getChannelData(0)
        for (let i = 0; i < samples.length; i++)
            samples[i] = Math.sin((i * 2 * Math.PI * 1500) / 48000) * (i / samples.length)

        let canvas2D = 0
        let readbacks = 0
        let decodedImages = 0
        let invalidations = 0
        const getContext = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (
            this: HTMLCanvasElement,
            ...args: unknown[]
        ) {
            if (args[0] === '2d') canvas2D++
            return Reflect.apply(getContext, this, args)
        } as typeof getContext
        const getImageData = WebGLDrawContext.prototype.getImageData
        WebGLDrawContext.prototype.getImageData = function (...args) {
            readbacks++
            return getImageData.apply(this, args)
        }
        const drawn: ImageData[] = []
        const drawing = ctx as typeof ctx & { drawWaveform?: typeof ctx.drawImage }
        const drawMethod = typeof drawing.drawWaveform === 'function' ? 'drawWaveform' : 'drawImage'
        const drawImage = drawing[drawMethod]!
        drawing[drawMethod] = function (image, ...args: number[]) {
            if (image instanceof HTMLImageElement) decodedImages++
            if (image instanceof ImageData) drawn.push(image)
            return Reflect.apply(drawImage, this, [image, ...args])
        }
        const waveform = (await createWaveform(buffer, 'fft'))!
        const renderer = createWaveformRenderer(() => invalidations++)
        const context = { ctx, scale: 32, pixelRatio: 1, ups: -100 / 32 } as EditorDrawContext
        const draw = (pps: number) => {
            ctx.setTransform(32, 0, 0, 32, 128, pps * 10)
            context.ups = -pps / 32
            renderer.draw(context, waveform, 0, { min: 0, max: 9.99 })
        }
        draw(100)
        const reduced = drawn[0]!
        draw(400)
        const original = drawn[2]!
        draw(100)
        draw(400)
        const measurement = { canvas2D, readbacks, decodedImages, invalidations }
        const reused = drawn[4] === reduced && drawn[6] === original
        const pixels = getWaveformTilePixels(waveform.images[0]!)!
        const retained = !!pixels

        // Validate the public PNG independently against the retained amplitudes.
        HTMLCanvasElement.prototype.getContext = getContext
        WebGLDrawContext.prototype.getImageData = getImageData
        const image = new Image()
        image.src = waveform.images[0]!
        await image.decode()
        const surface = ctx.createSurface(image.naturalWidth, image.naturalHeight)
        const target = surface.getContext()
        target.drawImage(image, 0, 0)
        const data = target.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data
        const matchesPng = pixels.alpha.every((alpha, index) => alpha === data[index * 4 + 3])
        surface.dispose()
        renderer.clear()
        releaseWaveform(waveform)
        const released = !getWaveformTilePixels(waveform.images[0]!)
        ctx.dispose()
        return { measurement, reused, retained, released, matchesPng }
    })
    expect(result).toEqual({
        measurement: { canvas2D: 0, readbacks: 0, decodedImages: 0, invalidations: 0 },
        reused: true,
        retained: true,
        released: true,
        matchesPng: true,
    })
})

test('repeated waveform imports allocate no WebGL contexts and do not evict the editor', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { createWaveform, releaseWaveform } = await import('/src/waveform.ts')
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const canvas = document.createElement('canvas')
        canvas.width = 16
        canvas.height = 16
        const ctx = getDrawContext(canvas)
        if ('ready' in ctx) await ctx.ready
        const gl = canvas.getContext('webgl2')!
        const held: HTMLCanvasElement[] = []
        const createElement = document.createElement.bind(document)
        // Keep every allocated canvas reachable: WebKit counts even lost
        // contexts toward its page budget until their canvases are collected.
        document.createElement = ((...args: Parameters<typeof document.createElement>) => {
            const element = createElement(...args)
            if (element instanceof HTMLCanvasElement) held.push(element)
            return element
        }) as typeof document.createElement
        let contextLosses = 0
        canvas.addEventListener('webglcontextlost', () => contextLosses++)
        // Waveform processing consumes decoded samples; no audio device is needed.
        const channel = new Float32Array(80)
        const buffer = {
            length: channel.length,
            duration: channel.length / 8000,
            sampleRate: 8000,
            numberOfChannels: 1,
            getChannelData: () => channel,
        } as unknown as AudioBuffer
        buffer.getChannelData(0).fill(0.5)
        try {
            for (let i = 0; i < 24; i++) releaseWaveform(await createWaveform(buffer, 'volume'))
        } finally {
            document.createElement = createElement
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
        const lost = gl.isContextLost()
        const temporaryContexts = held.length
        ctx.dispose()
        return { contextLosses, lost, temporaryContexts }
    })
    expect(result).toEqual({ contextLosses: 0, lost: false, temporaryContexts: 0 })
})

test('waveform peak levels match native viewport precision at zoom and DPR boundaries', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { createWaveformRenderer } = await import('/src/editor/canvas/waveform.ts')
        const { createWaveform, releaseWaveform } = await import('/src/waveform.ts')
        const { getDrawContext } = await import('/src/rendering/context.ts')
        // Waveform processing consumes decoded samples; no audio device is needed.
        const channel = new Float32Array(8000)
        const buffer = {
            length: channel.length,
            duration: channel.length / 8000,
            sampleRate: 8000,
            numberOfChannels: 1,
            getChannelData: () => channel,
        } as unknown as AudioBuffer
        buffer.getChannelData(0).fill(0.5)
        const waveform = (await createWaveform(buffer, 'volume'))!
        const output = document.createElement('canvas')
        output.width = 1528
        output.height = 976
        const ctx = getDrawContext(output)
        if ('ready' in ctx) await ctx.ready
        const native = document.createElement('canvas').getContext('2d')!
        const scale = 1528 / 26
        const heights: number[] = []
        const drawing = ctx as typeof ctx & { drawWaveform?: typeof ctx.drawImage }
        const drawMethod = typeof drawing.drawWaveform === 'function' ? 'drawWaveform' : 'drawImage'
        const drawImage = drawing[drawMethod]!
        drawing[drawMethod] = function (image, ...args: number[]) {
            if (image instanceof ImageData) heights.push(image.height)
            return Reflect.apply(drawImage, this, [image, ...args])
        }
        const renderer = createWaveformRenderer(() => {})
        const results = []
        for (const pixelRatio of [1, 1.25, 2]) {
            for (const pps of [60, 99.999, 100, 100.001, 125, 200, 250, 400]) {
                heights.length = 0
                ctx.setTransform(scale * pixelRatio, 0, 0, scale * pixelRatio, 764, 500)
                native.setTransform(scale * pixelRatio, 0, 0, scale * pixelRatio, 764, 500)
                const ups = -pps / scale
                const pixels = 10 * Math.abs(ups * native.getTransform().d)
                let expected = 2000
                while (expected > Math.max(1, pixels)) expected = Math.ceil(expected / 2)
                renderer.draw({ ctx, ups, scale, pixelRatio } as EditorDrawContext, waveform, 0, {
                    min: 0,
                    max: 9.99,
                })
                results.push({ pixelRatio, pps, expected, heights: [...heights] })
            }
        }
        renderer.clear()
        releaseWaveform(waveform)
        ctx.dispose()
        return results
    })
    for (const { pixelRatio, pps, expected, heights } of result)
        expect(heights, `${pps} pps at DPR ${pixelRatio}`).toEqual([expected, expected])
    // The native transform precision differs across browser engines. Each
    // threshold above is compared with that engine's own Canvas reference.
    expect(result).toHaveLength(24)
})

test('waveform encoding cancellation releases previously generated tiles', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { createWaveform } = await import('/src/waveform.ts')
        const { getWaveformTilePixels } = await import('/src/waveform/tiles.ts')
        const controller = new AbortController()
        const created: string[] = []
        const revoked: string[] = []
        const createObjectURL = URL.createObjectURL
        const revokeObjectURL = URL.revokeObjectURL
        const postMessage = MessagePort.prototype.postMessage
        URL.createObjectURL = (blob) => {
            const url = createObjectURL(blob)
            created.push(url)
            return url
        }
        URL.revokeObjectURL = (url) => {
            revoked.push(url)
            revokeObjectURL(url)
        }
        MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]) {
            // Abort during the next tile's genuine chunk-encoding yield.
            if (created.length === 1) controller.abort()
            return Reflect.apply(postMessage, this, args)
        } as typeof postMessage
        let error = ''
        try {
            const channel = new Float32Array(88000).fill(0.5)
            const buffer = {
                length: channel.length,
                duration: channel.length / 8000,
                sampleRate: 8000,
                numberOfChannels: 1,
                getChannelData: () => channel,
            } as unknown as AudioBuffer
            await createWaveform(buffer, 'volume', controller.signal)
        } catch (failure) {
            error = failure instanceof DOMException ? failure.name : String(failure)
        } finally {
            MessagePort.prototype.postMessage = postMessage
            URL.createObjectURL = createObjectURL
            URL.revokeObjectURL = revokeObjectURL
        }
        return {
            error,
            created: created.length,
            revoked: created.every((url) => revoked.includes(url)),
            retained: created.filter((url) => getWaveformTilePixels(url)).length,
        }
    })
    expect(result).toEqual({ error: 'AbortError', created: 1, revoked: true, retained: 0 })
})

test('direct waveform PNGs preserve every white and alpha byte', async ({ page }) => {
    const mismatches = await page.evaluate(async () => {
        const { createWaveformTileBlob } = await import('/src/waveform/png.ts')
        const results = []
        for (const [width, height] of [
            [3, 3],
            [128, 2000],
            [1, 2000],
        ]) {
            const pixels = new ImageData(width!, height!)
            const alpha = new Uint8Array(width! * height!)
            for (let i = 0; i < alpha.length; i++) {
                alpha[i] = (i * 73) % 256 // Every alpha byte, with wrapping Sub-filter deltas.
                pixels.data.set([255, 255, 255, alpha[i]!], i * 4)
            }
            const reference = document.createElement('canvas')
            reference.width = width!
            reference.height = height!
            const native = reference.getContext('2d')!
            native.putImageData(pixels, 0, 0)
            const expected = native.getImageData(0, 0, width!, height!).data
            const blob = await createWaveformTileBlob(
                { width: width!, height: height!, alpha },
                () => {},
            )
            const bitmap = await createImageBitmap(blob)
            native.clearRect(0, 0, width!, height!)
            native.drawImage(bitmap, 0, 0)
            bitmap.close()
            const actual = native.getImageData(0, 0, width!, height!).data
            let count = 0
            for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) count++
            if (count) results.push({ width, height, count })
        }
        return results
    })
    expect(mismatches).toEqual([])
})
