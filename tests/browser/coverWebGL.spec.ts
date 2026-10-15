import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
    await page.route('**/__cover-webgl-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }),
    )
    await page.goto('/__cover-webgl-test')
})

test(`cover PNG tiles preserve seams, centered crop and alpha above the GPU size limit`, async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { createCoverBlob } = await import('/src/rendering/coverExport.ts')
        const source = document.createElement('canvas')
        source.width = 1536
        source.height = 1024
        const sourceContext = source.getContext('2d')!
        const pixels = sourceContext.createImageData(source.width, source.height)
        for (let y = 0; y < source.height; y++) {
            for (let x = 0; x < source.width; x++) {
                const index = (y * source.width + x) * 4
                pixels.data[index] = ((x >> 4) % 2) * 255
                pixels.data[index + 1] = ((y >> 4) % 2) * 255
                pixels.data[index + 2] = (((x + y) >> 5) % 2) * 255
                pixels.data[index + 3] = [0, 64, 128, 255][((x >> 3) + (y >> 3)) % 4]!
            }
        }
        sourceContext.putImageData(pixels, 0, 0)
        const image = new Image()
        image.src = source.toDataURL()
        await image.decode()
        const output = document.createElement('canvas')
        output.width = 1024
        output.height = 1024
        const reference = output.getContext('2d')!
        reference.imageSmoothingEnabled = true
        reference.imageSmoothingQuality = 'high'
        reference.drawImage(image, 256, 0, 1024, 1024, 0, 0, 1024, 1024)
        const expected = reference.getImageData(0, 0, 1024, 1024).data

        for (const prototype of [
            WebGLRenderingContext.prototype,
            WebGL2RenderingContext.prototype,
        ]) {
            const getParameter = prototype.getParameter
            prototype.getParameter = function (parameter) {
                return parameter === this.MAX_TEXTURE_SIZE
                    ? 512
                    : getParameter.call(this, parameter)
            }
        }
        const blob = await createCoverBlob(image, 1024, new AbortController().signal)
        const bitmap = await createImageBitmap(blob)
        reference.clearRect(0, 0, 1024, 1024)
        reference.drawImage(bitmap, 0, 0)
        const actual = reference.getImageData(0, 0, 1024, 1024).data
        let mismatches = 0
        let maximumDifference = 0
        for (let index = 0; index < actual.length; index++) {
            const difference = Math.abs(actual[index]! - expected[index]!)
            if (difference) mismatches++
            maximumDifference = Math.max(maximumDifference, difference)
        }
        const dimensions = [bitmap.width, bitmap.height]
        bitmap.close()
        return { dimensions, type: blob.type, mismatches, maximumDifference }
    })
    expect(result).toEqual({
        dimensions: [1024, 1024],
        type: 'image/png',
        mismatches: 0,
        maximumDifference: 0,
    })
})

test('cover downscaling matches the Chromium high-quality raster filter', async ({
    page,
    browserName,
}) => {
    test.skip(
        browserName !== 'chromium',
        'The standardized GPU filter uses the Chromium reference; other browsers use different native kernels',
    )
    const result = await page.evaluate(async () => {
        const { createCoverBlob } = await import('/src/rendering/coverExport.ts')
        const results = []
        for (const [width, height] of [
            [256, 256],
            [512, 256],
            [256, 512],
        ] as const) {
            const source = document.createElement('canvas')
            source.width = width
            source.height = height
            const sourceContext = source.getContext('2d')!
            const pixels = sourceContext.createImageData(width, height)
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const value = (x * 13 + y * 7) % 17 < 8 ? 0 : 255
                    pixels.data.set([value, value, value, 255], (y * width + x) * 4)
                }
            }
            sourceContext.putImageData(pixels, 0, 0)
            const image = new Image()
            image.src = source.toDataURL()
            await image.decode()
            const referenceCanvas = document.createElement('canvas')
            referenceCanvas.width = referenceCanvas.height = 64
            const reference = referenceCanvas.getContext('2d')!
            reference.imageSmoothingQuality = 'high'
            reference.drawImage(
                image,
                (width - 256) / 2,
                (height - 256) / 2,
                256,
                256,
                0,
                0,
                64,
                64,
            )
            const expected = reference.getImageData(0, 0, 64, 64).data

            const blob = await createCoverBlob(image, 64, new AbortController().signal)
            const bitmap = await createImageBitmap(blob)
            const actualCanvas = document.createElement('canvas')
            actualCanvas.width = actualCanvas.height = 64
            const actualContext = actualCanvas.getContext('2d')!
            actualContext.drawImage(bitmap, 0, 0)
            const actual = actualContext.getImageData(0, 0, 64, 64).data
            bitmap.close()
            let sum = 0
            let maximum = 0
            for (let index = 0; index < actual.length; index++) {
                if (index % 4 === 3) continue
                const difference = Math.abs(actual[index]! - expected[index]!)
                sum += difference
                maximum = Math.max(maximum, difference)
            }
            results.push({ width, height, maximum, mean: sum / (64 * 64 * 3) })
        }
        return results
    })
    for (const { width, height, maximum, mean } of result) {
        expect(maximum, `${width} × ${height}`).toBeLessThanOrEqual(2)
        expect(mean, `${width} × ${height}`).toBeLessThan(0.2)
    }
})

test('cancelling a tiled cover export closes its active bitmap and stops reading tiles', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { createCoverBlob } = await import('/src/rendering/coverExport.ts')
        const samplerUrl = performance
            .getEntriesByType('resource')
            .map((entry) => entry.name)
            .find((url) => new URL(url).pathname === '/src/rendering/imageSampling.ts')!
        const { ImageSampler } = (await import(
            samplerUrl
        )) as typeof import('../../src/rendering/imageSampling')
        const image = new Image()
        image.src =
            'data:image/svg+xml,' +
            encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="red"/></svg>',
            )
        await image.decode()
        for (const prototype of [
            WebGLRenderingContext.prototype,
            WebGL2RenderingContext.prototype,
        ]) {
            const getParameter = prototype.getParameter
            prototype.getParameter = function (parameter) {
                return parameter === this.MAX_TEXTURE_SIZE
                    ? 512
                    : getParameter.call(this, parameter)
            }
        }
        const controller = new AbortController()
        let reads = 0
        let closed = 0
        const readPixels = ImageSampler.prototype.readPixels
        ImageSampler.prototype.readPixels = function (...args) {
            const result = readPixels.apply(this, args)
            reads++
            controller.abort()
            return result
        }
        const close = ImageBitmap.prototype.close
        ImageBitmap.prototype.close = function () {
            closed++
            close.call(this)
        }
        let error = ''
        try {
            await createCoverBlob(image, 1024, controller.signal)
        } catch (failure) {
            error = failure instanceof DOMException ? failure.name : String(failure)
        } finally {
            ImageSampler.prototype.readPixels = readPixels
            ImageBitmap.prototype.close = close
        }
        return { error, reads, closed }
    })
    expect(result).toEqual({ error: 'AbortError', reads: 1, closed: 2 })
})

test('tiled cover export observes cancellation between PNG compression chunks', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { createCoverBlob } = await import('/src/rendering/coverExport.ts')
        const pakoUrl = performance
            .getEntriesByType('resource')
            .map((entry) => entry.name)
            .find((url) => new URL(url).pathname.endsWith('/pako.js'))!
        const { Deflate } = (await import(pakoUrl)) as typeof import('pako')
        const image = new Image()
        image.src =
            'data:image/svg+xml,' +
            encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="blue"/></svg>',
            )
        await image.decode()
        for (const prototype of [
            WebGLRenderingContext.prototype,
            WebGL2RenderingContext.prototype,
        ]) {
            const getParameter = prototype.getParameter
            prototype.getParameter = function (parameter) {
                return parameter === this.MAX_TEXTURE_SIZE
                    ? 512
                    : getParameter.call(this, parameter)
            }
        }
        const controller = new AbortController()
        const push = Deflate.prototype.push
        let chunks = 0
        Deflate.prototype.push = function (...args) {
            const result = push.apply(this, args)
            chunks++
            controller.abort()
            return result
        }
        let error = ''
        try {
            await createCoverBlob(image, 1024, controller.signal)
        } catch (failure) {
            error = failure instanceof DOMException ? failure.name : String(failure)
        } finally {
            Deflate.prototype.push = push
        }
        return { error, chunks }
    })
    expect(result).toEqual({ error: 'AbortError', chunks: 1 })
})

test('cover export rejects a WebGL context lost while the PNG encoder completes', async ({
    page,
}) => {
    const error = await page.evaluate(async () => {
        const { createCoverBlob } = await import('/src/rendering/coverExport.ts')
        const image = new Image()
        image.src =
            'data:image/svg+xml,' +
            encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
            )
        await image.decode()
        const toBlob = HTMLCanvasElement.prototype.toBlob
        HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
            const gl = this.getContext('webgl2')
            if (!gl) return toBlob.call(this, callback, ...args)
            toBlob.call(
                this,
                (blob) => {
                    this.addEventListener('webglcontextlost', () => callback(blob), { once: true })
                    gl.getExtension('WEBGL_lose_context')!.loseContext()
                },
                ...args,
            )
        }
        try {
            await createCoverBlob(image, 8, new AbortController().signal)
            return ''
        } catch (error) {
            return error instanceof Error ? error.message : String(error)
        } finally {
            HTMLCanvasElement.prototype.toBlob = toBlob
        }
    })
    expect(error).toBe('The WebGL context was lost while generating the cover')
})

test('odd-sized cover minification matches the Chromium global filter phase across GPU tiles', async ({
    page,
    browserName,
}) => {
    test.skip(
        browserName !== 'chromium',
        'The standardized GPU filter uses the Chromium reference; tile coherence is tested independently on every engine',
    )
    const results = await page.evaluate(async () => {
        const { createCoverBlob } = await import('/src/rendering/coverExport.ts')
        for (const prototype of [
            WebGLRenderingContext.prototype,
            WebGL2RenderingContext.prototype,
        ]) {
            const getParameter = prototype.getParameter
            prototype.getParameter = function (parameter) {
                return parameter === this.MAX_TEXTURE_SIZE
                    ? 512
                    : getParameter.call(this, parameter)
            }
        }
        const results = []
        for (const [width, height, size] of [
            [2049, 2049, 1024],
            [3073, 2049, 700],
            [1025, 2049, 64],
        ] as const) {
            const source = document.createElement('canvas')
            source.width = width
            source.height = height
            const context = source.getContext('2d')!
            const pixels = context.createImageData(width, height)
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const value = (x * 13 + y * 7) % 17 < 8 ? 0 : 255
                    pixels.data.set([value, value, value, 255], (y * width + x) * 4)
                }
            }
            context.putImageData(pixels, 0, 0)
            const image = new Image()
            image.src = source.toDataURL()
            await image.decode()
            const extent = Math.min(width, height)
            const expectedCanvas = document.createElement('canvas')
            expectedCanvas.width = expectedCanvas.height = size
            const expectedContext = expectedCanvas.getContext('2d')!
            expectedContext.imageSmoothingQuality = 'high'
            expectedContext.drawImage(
                image,
                Math.floor((width - extent) / 2),
                Math.floor((height - extent) / 2),
                extent,
                extent,
                0,
                0,
                size,
                size,
            )
            const expected = expectedContext.getImageData(0, 0, size, size).data
            const blob = await createCoverBlob(image, size, new AbortController().signal)
            const bitmap = await createImageBitmap(blob)
            const actualCanvas = document.createElement('canvas')
            actualCanvas.width = actualCanvas.height = size
            const actualContext = actualCanvas.getContext('2d')!
            actualContext.drawImage(bitmap, 0, 0)
            const actual = actualContext.getImageData(0, 0, size, size).data
            bitmap.close()
            let maximum = 0
            let sum = 0
            for (let index = 0; index < actual.length; index++) {
                if (index % 4 === 3) continue
                const difference = Math.abs(actual[index]! - expected[index]!)
                maximum = Math.max(maximum, difference)
                sum += difference
            }
            results.push({ width, height, size, maximum, mean: sum / (size * size * 3) })
        }
        return results
    })
    for (const result of results) {
        expect(result.maximum, JSON.stringify(result)).toBeLessThanOrEqual(5)
        expect(result.mean, JSON.stringify(result)).toBeLessThan(1)
    }
})

test('cover minification preserves constants, impulse energy and area averages on every engine', async ({
    page,
}) => {
    const results = await page.evaluate(async () => {
        const { createCoverBlob } = await import('/src/rendering/coverExport.ts')
        const results = []
        for (const kind of ['constant', 'impulse', 'pattern'] as const) {
            const source = document.createElement('canvas')
            source.width = source.height = 256
            const context = source.getContext('2d')!
            const pixels = context.createImageData(256, 256)
            for (let y = 0; y < 256; y++) {
                for (let x = 0; x < 256; x++) {
                    const value =
                        kind === 'constant'
                            ? 73
                            : kind === 'impulse'
                              ? x === 130 && y === 66
                                  ? 255
                                  : 0
                              : (x * 13 + y * 7) % 17 < 8
                                ? 0
                                : 255
                    pixels.data.set([value, value, value, 255], (y * 256 + x) * 4)
                }
            }
            context.putImageData(pixels, 0, 0)
            const image = new Image()
            image.src = source.toDataURL()
            await image.decode()
            const bitmap = await createImageBitmap(
                await createCoverBlob(image, 64, new AbortController().signal),
            )
            const output = document.createElement('canvas')
            output.width = output.height = 64
            const actualContext = output.getContext('2d')!
            actualContext.drawImage(bitmap, 0, 0)
            bitmap.close()
            const actual = actualContext.getImageData(0, 0, 64, 64).data
            let maximum = 0
            let alphaErrors = 0
            let energy = 0
            for (let y = 0; y < 64; y++) {
                for (let x = 0; x < 64; x++) {
                    let sum = 0
                    for (let dy = 0; dy < 4; dy++)
                        for (let dx = 0; dx < 4; dx++)
                            sum += pixels.data[((y * 4 + dy) * 256 + x * 4 + dx) * 4]!
                    const index = (y * 64 + x) * 4
                    // Independent area integral; staged 8-bit filtering may
                    // truncate one channel unit before the final average.
                    for (let channel = 0; channel < 3; channel++)
                        maximum = Math.max(
                            maximum,
                            Math.abs(actual[index + channel]! - Math.floor(sum / 16)),
                        )
                    if (actual[index + 3] !== 255) alphaErrors++
                    energy += actual[index]!
                }
            }
            results.push({ kind, maximum, alphaErrors, energy })
        }
        return results
    })
    expect(results[0]).toEqual({
        kind: 'constant',
        maximum: 0,
        alphaErrors: 0,
        energy: 73 * 64 * 64,
    })
    expect(results[1]).toEqual({ kind: 'impulse', maximum: 0, alphaErrors: 0, energy: 15 })
    expect(results[2]!.maximum).toBeLessThanOrEqual(1)
    expect(results[2]!.alphaErrors).toBe(0)
})

test('cover source tiling preserves the same global minification phase on every engine', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { createCoverBlob } = await import('/src/rendering/coverExport.ts')
        const source = document.createElement('canvas')
        source.width = source.height = 513
        const context = source.getContext('2d')!
        const pixels = context.createImageData(513, 513)
        for (let y = 0; y < 513; y++)
            for (let x = 0; x < 513; x++) {
                const value = (x * 13 + y * 7) % 17 < 8 ? 0 : 255
                pixels.data.set([value, value, value, 255], (y * 513 + x) * 4)
            }
        context.putImageData(pixels, 0, 0)
        const image = new Image()
        image.src = source.toDataURL()
        await image.decode()
        const outputs = []
        for (const limit of [4096, 128]) {
            const prototypes = [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]
            const originals = prototypes.map((prototype) => prototype.getParameter)
            prototypes.forEach((prototype, index) => {
                prototype.getParameter = function (parameter) {
                    return parameter === this.MAX_TEXTURE_SIZE
                        ? limit
                        : originals[index]!.call(this, parameter)
                }
            })
            let blob: Blob
            try {
                blob = await createCoverBlob(image, 256, new AbortController().signal)
            } finally {
                prototypes.forEach((prototype, index) => {
                    prototype.getParameter = originals[index]!
                })
            }
            const bitmap = await createImageBitmap(blob)
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 256
            const context = canvas.getContext('2d')!
            context.drawImage(bitmap, 0, 0)
            bitmap.close()
            outputs.push(context.getImageData(0, 0, 256, 256).data)
        }
        let maximum = 0
        let sum = 0
        let alphaErrors = 0
        for (let index = 0; index < outputs[0]!.length; index++) {
            const difference = Math.abs(outputs[0]![index]! - outputs[1]![index]!)
            if (index % 4 === 3) alphaErrors += difference !== 0 ? 1 : 0
            else {
                maximum = Math.max(maximum, difference)
                sum += difference
            }
        }
        return { maximum, mean: sum / (256 * 256 * 3), alphaErrors }
    })
    expect(result.maximum).toBeLessThanOrEqual(4)
    expect(result.mean).toBeLessThan(1)
    expect(result.alphaErrors).toBe(0)
})

test('SVG cover enlargement keeps vector edges sharp', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { createCoverBlob } = await import('/src/rendering/coverExport.ts')
        const image = new Image()
        image.src =
            'data:image/svg+xml,' +
            encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="8" fill="red"/></svg>',
            )
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 400
        const context = canvas.getContext('2d')!
        context.imageSmoothingQuality = 'high'
        context.drawImage(image, 0, 0, 400, 400)
        const expected = context.getImageData(0, 0, 400, 400).data
        const bitmap = await createImageBitmap(
            await createCoverBlob(image, 400, new AbortController().signal),
        )
        context.clearRect(0, 0, 400, 400)
        context.drawImage(bitmap, 0, 0)
        const actual = context.getImageData(0, 0, 400, 400).data
        bitmap.close()
        let solidRegionDifferences = 0
        let totalAlphaDifference = 0
        for (let y = 1; y < 399; y++) {
            for (let x = 1; x < 399; x++) {
                const index = (y * 400 + x) * 4 + 3
                const alpha = expected[index]!
                totalAlphaDifference += Math.abs(alpha - actual[index]!)
                if (alpha !== 0 && alpha !== 255) continue
                let solid = true
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (expected[((y + dy) * 400 + x + dx) * 4 + 3] !== alpha) solid = false
                    }
                }
                if (solid && actual[index] !== alpha) solidRegionDifferences++
            }
        }
        return { solidRegionDifferences, meanAlphaDifference: totalAlphaDifference / (398 * 398) }
    })
    expect(result.solidRegionDifferences).toBe(0)
    expect(result.meanAlphaDifference).toBeLessThan(0.5)
})

test('cancelled cover decoding immediately releases its WebGL context', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { createCoverBlob } = await import('/src/rendering/coverExport.ts')
        const image = new Image()
        image.src =
            'data:image/svg+xml,' +
            encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
            )
        await image.decode()
        const contexts: WebGLRenderingContext[] = []
        const prototypes = [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]
        const originals = prototypes.map((prototype) => prototype.createBuffer)
        prototypes.forEach((prototype, index) => {
            prototype.createBuffer = function () {
                contexts.push(this)
                return originals[index]!.call(this)
            }
        })
        let release = () => undefined as void
        let entered = () => undefined as void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const started = new Promise<void>((resolve) => {
            entered = resolve
        })
        const createBitmap = window.createImageBitmap
        window.createImageBitmap = (async (...args: Parameters<typeof createBitmap>) => {
            const bitmap = await createBitmap.apply(window, args)
            entered()
            await gate
            return bitmap
        }) as typeof createBitmap
        const controller = new AbortController()
        const operation = createCoverBlob(image, 8, controller.signal)
        await started
        controller.abort()
        const releasedBeforeDecode =
            contexts.length > 0 && contexts.every((context) => context.isContextLost())
        release()
        let error = ''
        try {
            await operation
        } catch (failure) {
            error = failure instanceof DOMException ? failure.name : String(failure)
        } finally {
            window.createImageBitmap = createBitmap
            prototypes.forEach((prototype, index) => {
                prototype.createBuffer = originals[index]!
            })
        }
        return { error, releasedBeforeDecode }
    })
    expect(result).toEqual({ error: 'AbortError', releasedBeforeDecode: true })
})

test('SVG cover cropping preserves root styles and bounds extreme aspect ratio decoding', async ({
    page,
}) => {
    const results = await page.evaluate(async () => {
        const { createCoverBlob } = await import('/src/rendering/coverExport.ts')
        const results = []
        for (const [width, height] of [
            [31, 22],
            [22, 31],
            [100000, 10],
            [10, 100000],
        ]) {
            const extent = Math.min(width!, height!)
            const image = new Image()
            const sourceUrl =
                'data:image/svg+xml,' +
                encodeURIComponent(
                    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" x="2" y="3"><style>svg { opacity:.5 } :root > rect { fill:red }</style><rect width="100%" height="100%"/><circle cx="50%" cy="50%" r="${extent / 4}" fill="blue"/></svg>`,
                )
            await new Promise<void>((resolve, reject) => {
                image.onload = () => resolve()
                image.onerror = reject
                image.src = sourceUrl
            })
            const native = document.createElement('canvas')
            native.width = native.height = 100
            const reference = native.getContext('2d')!
            reference.imageSmoothingQuality = 'high'
            reference.drawImage(
                image,
                Math.floor((width! - extent) / 2),
                Math.floor((height! - extent) / 2),
                extent,
                extent,
                0,
                0,
                100,
                100,
            )
            const expected = reference.getImageData(0, 0, 100, 100).data
            const createBitmap = window.createImageBitmap
            const decodedDimensions: number[][] = []
            window.createImageBitmap = (async (...args: Parameters<typeof createBitmap>) => {
                const bitmap = await createBitmap.apply(window, args)
                decodedDimensions.push([bitmap.width, bitmap.height])
                return bitmap
            }) as typeof createBitmap
            let blob: Blob
            try {
                blob = await createCoverBlob(image, 100, new AbortController().signal)
            } finally {
                window.createImageBitmap = createBitmap
            }
            const bitmap = await createImageBitmap(blob)
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 100
            const context = canvas.getContext('2d')!
            context.drawImage(bitmap, 0, 0)
            bitmap.close()
            const actual = context.getImageData(0, 0, 100, 100).data
            let solidDifferences = 0
            for (let y = 1; y < 99; y++)
                for (let x = 1; x < 99; x++) {
                    const index = (y * 100 + x) * 4
                    let solid = true
                    for (let dy = -1; dy <= 1; dy++)
                        for (let dx = -1; dx <= 1; dx++)
                            for (let channel = 0; channel < 4; channel++)
                                if (
                                    expected[((y + dy) * 100 + x + dx) * 4 + channel] !==
                                    expected[index + channel]
                                )
                                    solid = false
                    if (
                        solid &&
                        [0, 1, 2, 3].some(
                            (channel) => actual[index + channel] !== expected[index + channel],
                        )
                    )
                        solidDifferences++
                }
            results.push({ width, height, decodedDimensions, solidDifferences })
        }
        return results
    })
    for (const result of results) {
        expect(result.decodedDimensions, JSON.stringify(result)).toEqual([[100, 100]])
        expect(result.solidDifferences, JSON.stringify(result)).toBe(0)
    }
})
