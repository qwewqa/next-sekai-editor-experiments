import { expect, test } from '@playwright/test'

test.describe(`native event strokes (WebGL2)`, () => {
    test.beforeEach(async ({ page }) => {
        await page.route('**/__native-stroke-test', (route) =>
            route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
        )
        await page.goto('/__native-stroke-test')
    })

    test('event curves preserve coverage and uncertain strokes still paint once', async ({
        page,
    }) => {
        const results = await page.evaluate(async () => {
            const { getDrawContext } = await import('/src/rendering/context.ts')
            const { DrawPath } = await import('/src/rendering/path.ts')
            const size = 384
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = size
            const ctx = getDrawContext(canvas)
            await ctx.ready
            const reference = document.createElement('canvas')
            reference.width = reference.height = size
            const native = reference.getContext('2d')!
            const results = []
            const shape = (path: InstanceType<typeof DrawPath> | Path2D, kind: string) => {
                if (kind === 'zero') {
                    path.moveTo(0, 0)
                    path.quadraticCurveTo(0, 0, 0, 0)
                } else if (kind === 'backtracking') {
                    path.moveTo(0, 0)
                    path.quadraticCurveTo(6, 0, 0, 0)
                } else if (kind === 'overlapping-u') {
                    path.moveTo(0, 0)
                    path.lineTo(0, 3)
                    path.lineTo(1, 3)
                    path.lineTo(1, 0)
                } else {
                    path.moveTo(-3, -4)
                    if (kind === 'one-curve') path.quadraticCurveTo(-3, 0, 3, 4)
                    else {
                        path.quadraticCurveTo(-3, -2, 0, 0)
                        path.quadraticCurveTo(3, 2, 3, 4)
                    }
                }
            }
            try {
                // Reuse a populated renderer so an empty native result
                // cannot accidentally replay a previous Graphics batch.
                for (const kind of [
                    'one-curve',
                    'two-curves',
                    'backtracking',
                    'overlapping-u',
                    'zero',
                ]) {
                    const path = new DrawPath(),
                        nativePath = new Path2D()
                    shape(path, kind)
                    shape(nativePath, kind)
                    for (const reflected of [false, true]) {
                        const samples = []
                        for (const isNative of [true, false]) {
                            const target = (isNative
                                ? native
                                : ctx) as unknown as CanvasRenderingContext2D
                            target.resetTransform()
                            target.clearRect(0, 0, size, size)
                            target.save()
                            target.beginPath()
                            target.rect(8, 8, 368, 368)
                            target.clip()
                            target.setTransform(
                                reflected ? -26 : 26,
                                6.5,
                                4.68,
                                -26,
                                192.375,
                                192.125,
                            )
                            target.strokeStyle = '#00ffff'
                            target.globalAlpha = 0.5
                            target.lineWidth = kind === 'overlapping-u' ? 2 : 2 / 13
                            target.lineCap = 'butt'
                            target.lineJoin = 'miter'
                            if (isNative) native.stroke(nativePath)
                            else ctx.stroke(path)
                            target.restore()
                            samples.push(target.getImageData(0, 0, size, size).data)
                        }
                        const expected = samples[0]!,
                            actual = samples[1]!
                        let maxAlpha = 0,
                            visible = 0,
                            missingInterior = 0,
                            extraExterior = 0
                        for (let y = 1; y < size - 1; y++)
                            for (let x = 1; x < size - 1; x++) {
                                const index = (y * size + x) * 4 + 3,
                                    alpha = actual[index]!
                                maxAlpha = Math.max(maxAlpha, alpha)
                                visible += +(alpha > 0)
                                if (Math.abs(expected[index]! - alpha) <= 2) continue
                                let low = 255,
                                    high = 0
                                for (let dy = -1; dy <= 1; dy++)
                                    for (let dx = -1; dx <= 1; dx++) {
                                        const value = expected[((y + dy) * size + x + dx) * 4 + 3]!
                                        low = Math.min(low, value)
                                        high = Math.max(high, value)
                                    }
                                missingInterior += +(low >= 126 && alpha < 125)
                                extraExterior += +(high === 0 && alpha > 2)
                            }
                        results.push({
                            kind,
                            reflected,
                            maxAlpha,
                            visible,
                            missingInterior,
                            extraExterior,
                        })
                    }
                }
                return results
            } finally {
                ctx.dispose()
            }
        })
        for (const result of results) {
            expect(result.maxAlpha, JSON.stringify(result)).toBeLessThanOrEqual(128)
            expect(result.missingInterior, JSON.stringify(result)).toBe(0)
            expect(result.extraExterior, JSON.stringify(result)).toBe(0)
            if (result.kind === 'zero') expect(result.visible).toBe(0)
            else expect(result.visible).toBeGreaterThan(0)
        }
    })

    test('retained distant curves survive translation, cache release and context restoration', async ({
        page,
    }) => {
        const result = await page.evaluate(async () => {
            const { getDrawContext } = await import('/src/rendering/context.ts')
            const { DrawPath } = await import('/src/rendering/path.ts')
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 384
            const ctx = getDrawContext(canvas)
            await ctx.ready
            const records = []
            const draw = (path: InstanceType<typeof DrawPath>) => {
                ctx.strokeStyle = '#00ffff'
                ctx.globalAlpha = 0.5
                ctx.lineWidth = 2 / 13
                ctx.lineCap = 'butt'
                ctx.lineJoin = 'miter'
                ctx.stroke(path)
            }
            const pixels = () => ctx.getImageData(0, 0, 384, 384).data
            const changes = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
                a.reduce((sum, value, index) => sum + +(value !== b[index]), 0)
            try {
                for (const origin of [0, -8000, 100000, 1000000]) {
                    const path = new DrawPath()
                    path.moveTo(-3, origin - 4)
                    path.quadraticCurveTo(-3, origin, 3, origin + 4)
                    ctx.clear()
                    ctx.setTransform(26, 0, 0, -26, 192.375, origin * 26 + 170.125)
                    const retained = ctx.captureVectors(() => draw(path), [0, origin])!
                    ctx.setTransform(26, 0, 0, -26, 192.375, origin * 26 + 192.625)
                    const replayed = ctx.drawVectors(retained)
                    const warm = pixels()
                    ctx.clear()
                    ctx.setTransform(26, 0, 0, -26, 192.375, origin * 26 + 192.625)
                    const fresh = ctx.captureVectors(() => draw(path), [0, origin])!
                    ctx.drawVectors(fresh)
                    records.push({ origin, replayed, changes: changes(warm, pixels()) })
                    ctx.releaseVectors(retained)
                    ctx.releaseVectors(fresh)
                }
                const path = new DrawPath()
                path.moveTo(-3, -4)
                path.quadraticCurveTo(-3, 0, 3, 4)
                const render = () => {
                    ctx.clear()
                    ctx.setTransform(26, 0, 0, -26, 192.375, 192.125)
                    draw(path)
                    return pixels()
                }
                const before = render()
                const gl = canvas.getContext('webgl2')!
                const extension = gl.getExtension('WEBGL_lose_context')!
                const lost = new Promise((resolve) =>
                    canvas.addEventListener('webglcontextlost', resolve, { once: true }),
                )
                extension.loseContext()
                await lost
                // Chromium must finish dispatching the lost-context event
                // before the extension may restore that context.
                await new Promise((resolve) => setTimeout(resolve, 50))
                const restored = new Promise((resolve) =>
                    canvas.addEventListener('webglcontextrestored', resolve, { once: true }),
                )
                extension.restoreContext()
                await restored
                await new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                )
                return {
                    records,
                    restoredChanges: changes(before, render()),
                    error: gl.getError(),
                }
            } finally {
                ctx.dispose()
            }
        })
        for (const record of result.records) {
            expect(record.replayed).toBe(true)
            expect(record.changes, `origin ${record.origin}`).toBe(0)
        }
        expect(result.restoredChanges).toBe(0)
        expect(result.error).toBe(0)
    })
})
