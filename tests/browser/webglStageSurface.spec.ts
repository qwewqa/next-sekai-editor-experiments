import { expect, test } from '@playwright/test'

test(`stage pixels survive attachment release and restoration (WebGL2)`, async ({ page }) => {
    await page.route('**/__webgl-stage-surface-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }),
    )
    await page.goto('/__webgl-stage-surface-test')
    const result = await page.evaluate(async () => {
        const framebuffers = new Set<WebGLFramebuffer>()
        const renderbuffers = new Set<WebGLRenderbuffer>()
        for (const prototype of [
            WebGLRenderingContext.prototype,
            WebGL2RenderingContext.prototype,
        ]) {
            const createFramebuffer = prototype.createFramebuffer
            const deleteFramebuffer = prototype.deleteFramebuffer
            const createRenderbuffer = prototype.createRenderbuffer
            const deleteRenderbuffer = prototype.deleteRenderbuffer
            prototype.createFramebuffer = function () {
                const value = createFramebuffer.call(this)
                if (value) framebuffers.add(value)
                return value
            }
            prototype.deleteFramebuffer = function (value) {
                if (value) framebuffers.delete(value)
                deleteFramebuffer.call(this, value)
            }
            prototype.createRenderbuffer = function () {
                const value = createRenderbuffer.call(this)
                if (value) renderbuffers.add(value)
                return value
            }
            prototype.deleteRenderbuffer = function (value) {
                if (value) renderbuffers.delete(value)
                deleteRenderbuffer.call(this, value)
            }
        }
        const counts = () => [framebuffers.size, renderbuffers.size]
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 128
        const root = getDrawContext(canvas)
        await root.ready
        const ordinary = root.createSurface(64, 64)
        const stage = root.createStageSurface(64, 64)
        const draw = (surface: typeof stage, color = '#ffa040') => {
            const ctx = surface.getContext()
            ctx.clear()
            ctx.save()
            ctx.translate(1.25, 0.5)
            ctx.beginPath()
            ctx.arc(31, 31, 25.25, 0, Math.PI * 2)
            ctx.clip()
            ctx.fillStyle = color
            ctx.globalAlpha = 0.7
            ctx.fillRect(3.25, 4.5, 50.5, 49.25)
            ctx.globalAlpha = 0.6
            ctx.lineWidth = 1.5
            ctx.strokeStyle = '#40c0ff'
            ctx.beginPath()
            for (let x = 0; x <= 64; x += 8) {
                ctx.moveTo(x, 0)
                ctx.lineTo(x + 4, 64)
            }
            ctx.stroke()
            ctx.restore()
            // The stage-specific stream owns transient vertex buffers and a
            // shared shader; exercise both through readback and restoration.
            ctx.drawStageTriangles([
                0, 0, 0.5, 0, 0, 0.5, 16, 0, 0.5, 0, 0, 0.5, 0, 16, 0.5, 0, 0, 0.5,
            ])
            ctx.flush()
        }
        const pixels = (surface: typeof stage) =>
            surface.getContext().getImageData(0, 0, surface.width, surface.height).data
        const equal = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
            a.length === b.length && a.every((value, i) => value === b[i])
        draw(ordinary)
        const baseline = counts()
        draw(stage)
        const afterRender = counts()
        const expected = pixels(ordinary)
        const actual = pixels(stage)
        const afterRead = counts()
        const checks = {
            initial: equal(expected, actual),
            nonzero: actual.some((value) => value !== 0),
            triangle:
                [255, 0, 0].every((value, i) => actual[(2 * 64 + 2) * 4 + i] === value) &&
                Math.abs((actual[(2 * 64 + 2) * 4 + 3] ?? 0) - 127.5) <= 0.5,
            repeatedRead: equal(actual, pixels(stage)),
            redraw: false,
            changed: false,
            queuedMutation: false,
            resize: false,
            restoration: false,
        }
        draw(stage)
        checks.redraw = equal(expected, pixels(stage))
        draw(stage, '#2080ff')
        checks.changed = !equal(expected, pixels(stage))
        root.clear()
        root.drawImage(stage, 0, 0)
        const oldRoot = root.getImageData(0, 0, 128, 128).data
        root.clear()
        root.drawImage(stage, 0, 0)
        draw(stage, '#ff2080')
        checks.queuedMutation = equal(oldRoot, root.getImageData(0, 0, 128, 128).data)
        ordinary.width = stage.width = 80
        ordinary.height = stage.height = 72
        draw(ordinary)
        draw(stage)
        const resized = pixels(stage)
        checks.resize = equal(pixels(ordinary), resized)
        const gl = canvas.getContext('webgl2')
        if (!gl) throw new Error('Missing WebGL context')
        const loss = gl.getExtension('WEBGL_lose_context')
        if (!loss) throw new Error('Context loss extension unavailable')
        const restored = new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('Context restoration timed out')),
                5000,
            )
            canvas.addEventListener(
                'renderingready',
                () => {
                    clearTimeout(timeout)
                    resolve()
                },
                { once: true },
            )
        })
        const lost = new Promise<void>((resolve) => {
            canvas.addEventListener(
                'webglcontextlost',
                () => {
                    framebuffers.clear()
                    renderbuffers.clear()
                    resolve()
                },
                { once: true },
            )
        })
        loss.loseContext()
        await lost
        await new Promise((resolve) => setTimeout(resolve, 50))
        loss.restoreContext()
        await restored
        draw(ordinary)
        draw(stage)
        checks.restoration = equal(resized, pixels(stage)) && equal(pixels(ordinary), pixels(stage))
        const glError = gl.getError()
        ordinary.dispose()
        stage.dispose()
        root.dispose()
        return { checks, baseline, afterRender, afterRead, afterDispose: counts(), glError }
    })
    expect(result.checks).toEqual({
        initial: true,
        nonzero: true,
        triangle: true,
        repeatedRead: true,
        redraw: true,
        changed: true,
        queuedMutation: true,
        resize: true,
        restoration: true,
    })
    expect(result.afterRender).toEqual(result.baseline)
    expect(result.afterRead).toEqual(result.baseline)
    expect(result.afterDispose).toEqual([0, 0])
    expect(result.glError).toBe(0)
})

test(`stage tiles bound physical scratch pixels and resolve once (WebGL2)`, async ({ page }) => {
    await page.route('**/__webgl-stage-tiles-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }),
    )
    await page.goto('/__webgl-stage-tiles-test')
    const result = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 128
        const root = getDrawContext(canvas)
        await root.ready
        const gl = canvas.getContext('webgl2')
        if (!gl) throw new Error('Missing WebGL context')
        const textures: number[][] = []
        const renderbuffers: number[][] = []
        const texImage2D = gl.texImage2D
        gl.texImage2D = function (
            this: WebGLRenderingContext | WebGL2RenderingContext,
            ...args: unknown[]
        ) {
            if (typeof args[3] === 'number' && typeof args[4] === 'number')
                textures.push([args[3], args[4]])
            Reflect.apply(texImage2D, this, args)
        } as typeof gl.texImage2D
        const storage = gl.renderbufferStorage
        gl.renderbufferStorage = function (target, format, width, height) {
            renderbuffers.push([width, height])
            storage.call(this, target, format, width, height)
        }
        if (gl instanceof WebGL2RenderingContext) {
            const multisample = gl.renderbufferStorageMultisample
            gl.renderbufferStorageMultisample = function (target, samples, format, width, height) {
                renderbuffers.push([width, height])
                multisample.call(this, target, samples, format, width, height)
            }
        }
        // Crosses the GL2 1024-row scratch boundary,
        // including a final partial tile. Integer rectangles have exact AA.
        const width = 1024
        const height = 1025
        const ordinary = root.createSurface(width, height)
        const stage = root.createStageSurface(width, height)
        const draw = (surface: typeof stage, color: string) => {
            const ctx = surface.getContext()
            ctx.clear()
            ctx.fillStyle = color
            ctx.fillRect(0, 0, width, height)
            ctx.fillStyle = '#f080c0'
            ctx.globalAlpha = 0.5
            for (const y of [0, 255, 511, 767, 1023]) ctx.fillRect(7, y, width - 14, 2)
            ctx.globalAlpha = 1
            ctx.flush()
            return ctx.getImageData(0, 0, width, height).data
        }
        const expected = draw(ordinary, '#204060')
        textures.length = renderbuffers.length = 0
        const actual = draw(stage, '#204060')
        const stageTextures = textures.slice()
        const stageRenderbuffers = renderbuffers.slice()
        const equal = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
            a.length === b.length && a.every((value, i) => value === b[i])
        const changed = draw(stage, '#608020')
        const changedReference = draw(ordinary, '#608020')
        // A narrow, hardware-height stage still exercises the scratch height limit.
        const thin = root.createStageSurface(1, root.maxSurfaceSize)
        const ctx = thin.getContext()
        ctx.fillStyle = '#f04020'
        ctx.fillRect(0, 0, 1, thin.height)
        ctx.flush()
        const thinPixels = [0, Math.floor(thin.height / 2), thin.height - 1].map((y) =>
            Array.from(ctx.getImageData(0, y, 1, 1).data),
        )
        const dimensionsFit = [...textures, ...renderbuffers].every(
            ([w, h]) => w! <= root.maxSurfaceSize && h! <= root.maxSurfaceSize,
        )
        const glError = gl.getError()
        ordinary.dispose()
        stage.dispose()
        thin.dispose()
        root.dispose()
        return {
            equal: equal(expected, actual),
            changed: !equal(actual, changed) && equal(changedReference, changed),
            stageTextures,
            stageRenderbuffers,
            thinPixels,
            dimensionsFit,
            glError,
        }
    })
    expect(result.equal).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.stageTextures).toContainEqual([1024, 1025])
    for (const [width, height] of result.stageTextures)
        if (width !== 1024 || height !== 1025)
            expect(width! * height!).toBeLessThanOrEqual(1024 * 1024)
    for (const [width, height] of result.stageRenderbuffers)
        expect(width! * height!).toBeLessThanOrEqual(1024 * 1024)
    expect(result.thinPixels).toEqual(Array(3).fill([240, 64, 32, 255]))
    expect(result.dimensionsFit).toBe(true)
    expect(result.glError).toBe(0)
})
