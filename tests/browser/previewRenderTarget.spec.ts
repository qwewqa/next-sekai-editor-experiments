import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resource } from './previewResourceFixture'

test.beforeEach(async ({ page }) => {
    await page.route('**/__render-target', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
    )
    await page.route('**/__target-skin', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/__target-particle', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.goto('/__render-target')
})

const level = JSON.parse(readFileSync('tests/fixtures/generated-large.json', 'utf8'))

for (const antialias of [false, true])
    for (const scale of [1, 1.5, 2])
        test(`${scale}x with antialiasing ${antialias ? 'on' : 'off'} matches area averages computed on the CPU`, async ({
            page,
        }) => {
            const results = await page.evaluate(
                async ({ level, antialias, scale }) => {
                    const { createPreviewRenderer } = await import('/src/preview/gl.ts')
                    const { drawPreviewFrame } = await import('/src/preview/drawFrame.ts')
                    const { parseLevelDataChart } =
                        await import('/src/chart/parse/levelData/index.ts')
                    const { parseLevelData } = await import('/src/levelData/parse.ts')
                    const { createState } = await import('/src/state/index.ts')
                    const { buildPreviewChart } = await import('/src/preview/engine/chart.ts')
                    const { loadSkinFromScp } = await import('/src/preview/skin.ts')
                    const { loadParticleFromScp } = await import('/src/preview/particle.ts')
                    const skin = await loadSkinFromScp(
                        await (await fetch('/__target-skin')).arrayBuffer(),
                    )
                    const particle = await loadParticleFromScp(
                        await (await fetch('/__target-particle')).arrayBuffer(),
                    )
                    const chart = buildPreviewChart(
                        createState(parseLevelDataChart(parseLevelData(level).entities), 0),
                        10,
                    )
                    const canvas = new OffscreenCanvas(1, 1)
                    const renderer = createPreviewRenderer(canvas, false)
                    const referenceCanvas = new OffscreenCanvas(1, 1)
                    const reference = createPreviewRenderer(referenceCanvas, antialias)
                    for (const r of [renderer, reference]) {
                        r.setTexture(0, skin.texture, false)
                        r.setTexture(1, particle.texture, false)
                    }
                    const gl = canvas.getContext('webgl2')!
                    const read = (gl: WebGL2RenderingContext, width: number, height: number) => {
                        const data = new Uint8Array(width * height * 4)
                        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data)
                        return data
                    }
                    const results = []
                    // Reuse the same context across frames and target sizes, including combo uploads.
                    for (const [outputWidth, outputHeight, time] of [
                        [160, 90, 1.05],
                        [160, 90, 20.05],
                        [192, 108, 22.1],
                    ] as const) {
                        const width = outputWidth * scale
                        const height = outputHeight * scale
                        const input = {
                            time,
                            width,
                            height,
                            displayWidth: 320,
                            displayHeight: 180,
                            overlayWidth: 0,
                            overlayHeight: 0,
                            leftLimit: false,
                            noteSpeed: 10,
                            showEffects: true,
                            showHitboxes: false,
                            showCombo: true,
                        }
                        const target = renderer.setRenderTarget({ width, height, antialias })!
                        const result = drawPreviewFrame(
                            renderer,
                            undefined,
                            skin.skin,
                            particle.particle,
                            chart,
                            input,
                            undefined,
                        )
                        target.resolve()
                        target.present(outputWidth, outputHeight)
                        const actual = read(gl, outputWidth, outputHeight)
                        const referenceResult = drawPreviewFrame(
                            reference,
                            undefined,
                            skin.skin,
                            particle.particle,
                            chart,
                            input,
                            undefined,
                        )
                        const sourceTop = reference.readPixels('frame', 0, 0, width, height)
                        const source = new Uint8Array(sourceTop.length)
                        for (let y = 0; y < height; y++)
                            source.set(
                                sourceTop.subarray(y * width * 4, (y + 1) * width * 4),
                                (height - 1 - y) * width * 4,
                            )
                        let maxDifference = 0
                        let nonzero = 0

                        for (let y = 0; y < outputHeight; y++)
                            for (let x = 0; x < outputWidth; x++) {
                                const sums = [0, 0, 0, 0]
                                for (let sy = Math.floor(y * scale); sy < (y + 1) * scale; sy++)
                                    for (
                                        let sx = Math.floor(x * scale);
                                        sx < (x + 1) * scale;
                                        sx++
                                    ) {
                                        const area =
                                            (Math.min(sx + 1, (x + 1) * scale) -
                                                Math.max(sx, x * scale)) *
                                            (Math.min(sy + 1, (y + 1) * scale) -
                                                Math.max(sy, y * scale))
                                        for (let c = 0; c < 4; c++)
                                            sums[c] =
                                                sums[c]! + source[(sy * width + sx) * 4 + c]! * area
                                    }
                                for (let c = 0; c < 4; c++) {
                                    const expected = Math.round(sums[c]! / (scale * scale))
                                    maxDifference = Math.max(
                                        maxDifference,
                                        Math.abs(expected - actual[(y * outputWidth + x) * 4 + c]!),
                                    )
                                    if (expected) nonzero++
                                }
                            }
                        results.push({
                            drawn: result.drawn && referenceResult.drawn,
                            quadEqual:
                                JSON.stringify(result.backgroundQuad) ===
                                JSON.stringify(referenceResult.backgroundQuad),
                            maxDifference,
                            nonzero,
                            clean: renderer.checkError() && reference.checkError(),
                        })
                    }
                    renderer.setRenderTarget(undefined)
                    renderer.begin(8, 8)
                    renderer.flush()
                    const cleared = read(gl, 8, 8).every((value) => value === 0)
                    const clean = renderer.checkError()
                    renderer.dispose()
                    reference.dispose()
                    skin.texture.close()
                    particle.texture.close()
                    return { results, cleared, clean }
                },
                { level, antialias, scale },
            )
            for (const result of results.results) {
                expect(result.drawn).toBe(true)
                expect(result.quadEqual).toBe(true)
                expect(result.clean).toBe(true)
                expect(result.nonzero).toBeGreaterThan(100)
                expect(result.maxDifference).toBeLessThanOrEqual(1)
            }
            expect(results.cleared).toBe(true)
            expect(results.clean).toBe(true)
        })

test('incomplete targets throw and resolve errors fail the final check', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { createPreviewRenderer } = await import('/src/preview/gl.ts')
        const canvas = new OffscreenCanvas(1, 1)
        const renderer = createPreviewRenderer(canvas, false)
        const gl = canvas.getContext('webgl2')!
        const check = gl.checkFramebufferStatus.bind(gl)
        const failures = []
        for (const failAt of [1, 2]) {
            let calls = 0
            gl.checkFramebufferStatus = (target) =>
                ++calls === failAt ? gl.FRAMEBUFFER_UNSUPPORTED : check(target)
            try {
                renderer.setRenderTarget({ width: 24, height: 24, antialias: true })
                failures.push(false)
            } catch {
                failures.push(true)
            }
        }
        gl.checkFramebufferStatus = check
        const target = renderer.setRenderTarget({ width: 24, height: 24, antialias: true })!
        renderer.begin(24, 24)
        renderer.flush()
        // A scaling resolve is forbidden by WebGL2. The final error check must catch it.
        const blit = gl.blitFramebuffer.bind(gl)
        gl.blitFramebuffer = (sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter) =>
            blit(sx0, sy0, sx1, sy1, dx0, dy0, dx1 / 2, dy1 / 2, mask, filter)
        target.resolve()
        target.present(16, 16)
        const accepted = renderer.checkError()
        renderer.dispose()
        return { failures, accepted }
    })
    expect(result.failures).toEqual([true, true])
    expect(result.accepted).toBe(false)
})

test('frame results distinguish missing resources, invalid sizes, errors and context loss', async ({
    page,
}) => {
    const result = await page.evaluate(async (level) => {
        const { createPreviewRenderer } = await import('/src/preview/gl.ts')
        const { drawPreviewFrame } = await import('/src/preview/drawFrame.ts')
        const { parseLevelDataChart } = await import('/src/chart/parse/levelData/index.ts')
        const { parseLevelData } = await import('/src/levelData/parse.ts')
        const { createState } = await import('/src/state/index.ts')
        const { buildPreviewChart } = await import('/src/preview/engine/chart.ts')
        const { resolveSkin } = await import('/src/preview/skin.ts')
        const { previewBackgroundQuad } = await import('/src/preview/engine/render.ts')
        const chart = buildPreviewChart(
            createState(parseLevelDataChart(parseLevelData(level).entities), 0),
            10,
        )
        const canvas = new OffscreenCanvas(1, 1)
        const renderer = createPreviewRenderer(canvas, false)
        const skin = resolveSkin(() => undefined)
        const input = {
            time: 20,
            width: 160,
            height: 90,
            displayWidth: 320,
            displayHeight: 180,
            overlayWidth: 0,
            overlayHeight: 0,
            leftLimit: false,
            noteSpeed: 10,
            showEffects: false,
            showHitboxes: false,
            showCombo: false,
        }
        const draw = (width = 160) =>
            drawPreviewFrame(
                renderer,
                undefined,
                skin,
                undefined,
                chart,
                { ...input, width },
                undefined,
            )
        const results = [draw()]
        renderer.reserveTexture(0, 1, 1)
        results.push(draw(0), draw(NaN), draw(renderer.maxViewportSize.width + 1), draw())
        const flush = renderer.flush
        renderer.flush = () => {
            throw new Error('Draw failed')
        }
        results.push(draw())
        renderer.flush = flush
        canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext()
        results.push(draw())
        renderer.dispose()
        return {
            results,
            quad: previewBackgroundQuad(
                chart.isDynamicStages ? chart.cameras : [],
                input.time,
                input.displayWidth,
                input.displayHeight,
                input.leftLimit,
            ),
        }
    }, level)
    expect(result.results.map((frame) => (frame.drawn ? 'drawn' : frame.reason))).toEqual([
        'resources',
        'size',
        'size',
        'size',
        'drawn',
        'error',
        'context',
    ])
    for (const frame of result.results) expect(frame.backgroundQuad).toEqual(result.quad)
})
