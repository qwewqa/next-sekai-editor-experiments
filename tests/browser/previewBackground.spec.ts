import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
    await page.route('**/__background', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
    )
    await page.goto('/__background')
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
            background: { aspectRatio: 1, fit: 'cover', color: '#52779c', blur: 0 },
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
