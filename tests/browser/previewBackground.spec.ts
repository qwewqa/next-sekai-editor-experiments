import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
    await page.route('**/__background', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
    )
    await page.goto('/__background')
})

test('maximum blur preserves the average of detailed stripes', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { createBackgroundPass } = await import('/src/preview/backgroundPass.ts')
        const gl = new OffscreenCanvas(1, 1).getContext('webgl2')!
        const image = new OffscreenCanvas(4096, 4096)
        const context = image.getContext('2d')!
        for (let x = 0; x < image.width; x += 26) {
            context.fillStyle = (x / 26) % 2 ? '#fff' : '#000'
            context.fillRect(x, 0, 26, image.height)
        }
        const bitmap = await createImageBitmap(image)
        const source = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, source)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        const allocations = new Map<WebGLTexture, number>()
        let peakBytes = 0
        let peakTextures = 0
        let longestSide = 0
        const storage = gl.texStorage2D.bind(gl)
        gl.texStorage2D = (...args) => {
            const [, , , width, height] = args
            allocations.set(
                gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture,
                width * height * 4,
            )
            peakBytes = Math.max(
                peakBytes,
                [...allocations.values()].reduce((a, b) => a + b, 0),
            )
            peakTextures = Math.max(peakTextures, allocations.size)
            longestSide = Math.max(longestSide, width, height)
            storage(...args)
        }
        const remove = gl.deleteTexture.bind(gl)
        gl.deleteTexture = (texture) => {
            if (texture) allocations.delete(texture)
            remove(texture)
        }
        const pass = createBackgroundPass(gl)
        const copy = pass.blur(source, bitmap, 3840, 2160, 400)!
        const framebuffer = gl.createFramebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
        gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            copy.texture,
            0,
        )
        // The middle row, more than three sigma from the image's left and right edges.
        const values = new Uint8Array(25 * 4)
        gl.readPixels(50, Math.floor(copy.height / 2), 25, 1, gl.RGBA, gl.UNSIGNED_BYTE, values)
        pass.dispose()
        gl.deleteFramebuffer(framebuffer)
        gl.deleteTexture(source)
        bitmap.close()
        return {
            pixels: [...values],
            peakBytes,
            peakTextures,
            longestSide,
            remaining: allocations.size,
        }
    })
    expect(result.peakBytes).toBeLessThanOrEqual(32 * 1024 * 1024)
    expect(result.peakTextures).toBe(2)
    expect(result.longestSide).toBeLessThanOrEqual(2048)
    expect(result.remaining).toBe(0)
    const { pixels } = result
    // Equal black and white areas converge to 127.5 under this wide Gaussian.
    for (let i = 0; i < pixels.length; i += 4) {
        for (let channel = 0; channel < 3; channel++)
            expect(Math.abs(pixels[i + channel]! - 127.5)).toBeLessThanOrEqual(2)
        // The image's top and bottom edges are less than three sigma from this row.
        expect(pixels[i + 3]).toBeGreaterThanOrEqual(253)
    }
})

test('small backgrounds keep their color when enlarged for blur', async ({ page }) => {
    const pixel = await page.evaluate(async () => {
        const { createBackgroundPass } = await import('/src/preview/backgroundPass.ts')
        const gl = new OffscreenCanvas(1, 1).getContext('webgl2')!
        const image = new OffscreenCanvas(1, 1)
        const context = image.getContext('2d')!
        context.fillStyle = '#fff'
        context.fillRect(0, 0, 1, 1)
        const bitmap = await createImageBitmap(image)
        const source = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, source)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        const pass = createBackgroundPass(gl)
        const copy = pass.blur(source, bitmap, 192, 108, 1)!
        const framebuffer = gl.createFramebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
        gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            copy.texture,
            0,
        )
        const value = new Uint8Array(4)
        gl.readPixels(40, 40, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, value)
        pass.dispose()
        gl.deleteFramebuffer(framebuffer)
        gl.deleteTexture(source)
        bitmap.close()
        return [...value]
    })
    expect(pixel).toEqual([255, 255, 255, 255])
})

test('additive foreground keeps its alpha when composited over an exposed background', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { createPreviewRenderer, BlendMode } = await import('/src/preview/gl.ts')
        const canvas = new OffscreenCanvas(32, 32)
        const renderer = createPreviewRenderer(canvas, false)
        const source = new OffscreenCanvas(1, 1)
        const context = source.getContext('2d')!
        context.fillStyle = '#4080c080'
        context.fillRect(0, 0, 1, 1)
        const bitmap = await createImageBitmap(source, { premultiplyAlpha: 'premultiply' })
        renderer.setTexture(0, bitmap, false)
        context.clearRect(0, 0, 1, 1)
        const transparent = await createImageBitmap(source)
        renderer.setTexture(3, transparent, true)
        const quad = {
            tl: { x: -1, y: 1 },
            tr: { x: 1, y: 1 },
            bl: { x: -1, y: -1 },
            br: { x: 1, y: -1 },
        }
        renderer.prepareFrame(32, 32)
        renderer.begin(32, 32)
        const sprite = { u0: 0, v0: 0, u1: 1, v1: 1 }
        renderer.draw(sprite, quad, [0], 1)
        renderer.draw(sprite, quad, [1], 0.5, undefined, BlendMode.additive)
        renderer.flush()
        const foreground = renderer.readPixels('frame', 16, 16, 1, 1)
        renderer.compositeBackground(quad, {
            time: 0,
            leftLimit: false,
            width: 32,
            height: 32,
            displayWidth: 32,
            displayHeight: 32,
            overlayWidth: 0,
            overlayHeight: 0,
            noteSpeed: 10,
            showEffects: true,
            showHitboxes: false,
            showCombo: false,
            testAspect: false,
            background: { aspectRatio: 1, fit: 'cover', color: '#52779c', sigma: 0 },
        })
        const gl = canvas.getContext('webgl2')!
        const final = new Uint8Array(4)
        gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, final)
        const clean = renderer.checkError()
        renderer.dispose()
        bitmap.close()
        transparent.close()
        return { foreground: [...foreground], final: [...final], clean }
    })
    expect(result.clean).toBe(true)
    expect(result.foreground[3]).toBeGreaterThan(0)
    expect(result.foreground[3]).toBeLessThan(255)
    for (const [channel, background] of [82, 119, 156].entries())
        expect(
            Math.abs(
                result.final[channel]! -
                    Math.round(
                        result.foreground[channel]! +
                            background * (1 - result.foreground[3]! / 255),
                    ),
            ),
        ).toBeLessThanOrEqual(1)
    expect(result.final[3]).toBe(255)
})

test('a background far larger than the frame shows fine lines as their average', async ({
    page,
}) => {
    const rows = await page.evaluate(async () => {
        const { createPreviewRenderer } = await import('/src/preview/gl.ts')
        const canvas = new OffscreenCanvas(32, 32)
        const renderer = createPreviewRenderer(canvas, false)
        // One white row in three, 32 image rows to each frame row.
        const image = new OffscreenCanvas(1024, 1024)
        const context = image.getContext('2d')!
        context.fillStyle = '#000'
        context.fillRect(0, 0, 1024, 1024)
        context.fillStyle = '#fff'
        for (let y = 0; y < 1024; y += 3) context.fillRect(0, y, 1024, 1)
        const bitmap = await createImageBitmap(image)
        renderer.setTexture(3, bitmap, true)
        renderer.prepareFrame(32, 32)
        renderer.begin(32, 32)
        renderer.flush()
        renderer.compositeBackground(
            { tl: { x: -1, y: 1 }, tr: { x: 1, y: 1 }, bl: { x: -1, y: -1 }, br: { x: 1, y: -1 } },
            {
                time: 0,
                leftLimit: false,
                width: 32,
                height: 32,
                displayWidth: 32,
                displayHeight: 32,
                overlayWidth: 0,
                overlayHeight: 0,
                noteSpeed: 10,
                showEffects: true,
                showHitboxes: false,
                showCombo: false,
                testAspect: false,
                background: { aspectRatio: 1, fit: 'cover', color: '#000000', sigma: 0 },
            },
        )
        const gl = canvas.getContext('webgl2')!
        const column = new Uint8Array(32 * 4)
        gl.readPixels(16, 0, 1, 32, gl.RGBA, gl.UNSIGNED_BYTE, column)
        const clean = renderer.checkError()
        renderer.dispose()
        bitmap.close()
        return { values: [...column].filter((_, i) => i % 4 === 0), clean }
    })
    expect(rows.clean).toBe(true)
    // A third of 255 is 85; sampling the full-size image alone gives rows from black to white.
    for (const value of rows.values) expect(Math.abs(value - 85)).toBeLessThanOrEqual(12)
})

test('blur after a resolution or sigma change matches a fresh copy, including maximum blur at 2160p', async ({
    page,
}) => {
    test.setTimeout(90000)
    const result = await page.evaluate(async () => {
        const { createBackgroundPass } = await import('/src/preview/backgroundPass.ts')
        const canvas = new OffscreenCanvas(1, 1)
        const gl = canvas.getContext('webgl2')!
        const image = new OffscreenCanvas(4096, 4096)
        const context = image.getContext('2d')!
        context.fillStyle = '#ff4000'
        context.fillRect(0, 0, 4096, 4096)
        context.clearRect(1024, 1024, 2048, 2048)
        context.fillStyle = '#0080ff80'
        context.fillRect(2048, 0, 2048, 4096)
        const bitmap = await createImageBitmap(image, { premultiplyAlpha: 'premultiply' })
        const source = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, source)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        const used = createBackgroundPass(gl),
            fresh = createBackgroundPass(gl)
        const framebuffer = gl.createFramebuffer()
        const read = (copy: NonNullable<ReturnType<typeof used.blur>>) => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
            gl.framebufferTexture2D(
                gl.FRAMEBUFFER,
                gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D,
                copy.texture,
                0,
            )
            const pixels = new Uint8Array(copy.width * copy.height * 4)
            gl.readPixels(0, 0, copy.width, copy.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
            return pixels
        }
        const results = []
        for (const blur of [1, 6, 100]) {
            used.blur(source, bitmap, 1280, 720, (blur * 720) / 540)
            const changed = used.blur(source, bitmap, 3840, 2160, blur * 4)!
            const a = read(changed)
            const direct = fresh.blur(source, bitmap, 3840, 2160, blur * 4)!
            const b = read(direct)
            const cached = used.blur(source, bitmap, 3840, 2160, blur * 4)!
            results.push({
                same: a.length === b.length && a.every((v, i) => v === b[i]),
                reused: cached.texture === changed.texture,
                width: changed.width,
                height: changed.height,
                sigma: changed.sigma,
                visible: a.some((v) => v > 0),
            })
        }
        used.blur(source, bitmap, 3840, 2160, 0)
        const clean = gl.getError() === gl.NO_ERROR
        used.dispose()
        fresh.dispose()
        gl.deleteFramebuffer(framebuffer)
        gl.deleteTexture(source)
        bitmap.close()
        return { results, clean }
    })
    expect(result.clean).toBe(true)
    for (const copy of result.results) {
        expect(copy.same).toBe(true)
        expect(copy.reused).toBe(true)
        expect(copy.visible).toBe(true)
        expect(Math.max(copy.width, copy.height)).toBeLessThanOrEqual(2048)
        expect(copy.sigma).toBeLessThanOrEqual(8)
    }
})
