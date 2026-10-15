import { expect, test } from '@playwright/test'

test('retained event strokes keep fixed width, coverage and owned buffers across arbitrary PPS (WebGL2)', async ({
    page,
}, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/__event_strokes', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><canvas width="480" height="480"></canvas>',
        }),
    )
    await page.goto('/__event_strokes')
    const report = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const { prepareEventStroke } = await import('/src/rendering/eventStrokeMesh.ts')
        const { createEventPath } = await import('/src/editor/entities/events/path.ts')
        const canvas = document.querySelector('canvas')!
        const ctx = getDrawContext(canvas)
        await ctx.ready
        const gl = canvas.getContext('webgl2')!
        const rows = []
        const images: { label: string; old: string; current: string }[] = []
        const read = () => ctx.getImageData(0, 0, 480, 480).data
        const png = (data: Uint8ClampedArray) => {
            const output = document.createElement('canvas')
            output.width = output.height = 480
            const target = output.getContext('2d')!
            const image = target.createImageData(480, 480)
            image.data.set(data)
            target.putImageData(image, 0, 0)
            return output.toDataURL('image/png').split(',')[1]!
        }
        const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
            let changed = 0,
                maxAlpha = 0,
                outside = 0,
                flat = 0,
                sumA = 0,
                sumB = 0
            for (let y = 0; y < 480; y++)
                for (let x = 0; x < 480; x++) {
                    const i = (y * 480 + x) * 4 + 3
                    sumA += a[i]!
                    sumB += b[i]!
                    maxAlpha = Math.max(maxAlpha, b[i]!)
                    if (a[i] === b[i]) continue
                    changed++
                    let near = false,
                        uniform = true
                    for (let dy = -1; dy <= 1; dy++)
                        for (let dx = -1; dx <= 1; dx++) {
                            if (x + dx < 0 || x + dx >= 480 || y + dy < 0 || y + dy >= 480) continue
                            const j = ((y + dy) * 480 + x + dx) * 4 + 3
                            near ||= !!a[j]
                            uniform &&= a[j] === a[i]
                        }
                    if (b[i] && !near) outside++
                    if (uniform && Math.abs(a[i]! - b[i]!) > 1) flat++
                }
            return {
                changed,
                maxAlpha,
                outside,
                flat,
                coverage: Math.abs(sumA - sumB) / Math.max(1, sumA),
            }
        }
        try {
            for (const origin of [0, 1e6])
                for (const halfSpan of [0.5, 0.01])
                    for (const reflect of [1, -1]) {
                        const scale = 30 * reflect
                        const prepared = prepareEventStroke(
                            createEventPath(
                                -3,
                                3,
                                origin - halfSpan,
                                origin + halfSpan,
                                'inOutQuad',
                            ),
                            30,
                        )!
                        const reset = (pps: number) => {
                            ctx.clear()
                            ctx.setTransform(scale, 0, 0, 30, 240.125, 240.375 + origin * pps)
                            ctx.lineWidth = 2 / 30
                            ctx.lineCap = 'butt'
                            ctx.lineJoin = 'miter'
                            ctx.strokeStyle = '#ffffff'
                            ctx.globalAlpha = 0.5
                        }
                        reset(100)
                        const range = ctx.captureEventStrokeVectors(
                            () => {
                                if (!ctx.strokeEventPath(prepared, -100 / 30))
                                    throw new Error('initial admission')
                            },
                            origin,
                            -100 / 30,
                        )!
                        const mesh = range.eventStrokes![0]!.mesh
                        const geometry = mesh.geometry
                        const positionBuffer = geometry.getBuffer('aPosition')
                        const indexBuffer = geometry.indexBuffer
                        for (const pps of [100, 137.31, 281.73, 1000, 333.37, 10000, 100]) {
                            reset(pps)
                            const updated = ctx.updateEventStrokeVectors(range, origin, -pps / 30)
                            if (!updated) throw new Error(`update refused ${origin}/${pps}`)
                            ctx.drawVectors(range)
                            const queuedRejected = !ctx.updateEventStrokeVectors(
                                range,
                                origin,
                                -pps / 30,
                            )
                            ctx.flush()
                            const reused = read()
                            reset(pps)
                            const fresh = ctx.captureEventStrokeVectors(
                                () => {
                                    if (!ctx.strokeEventPath(prepared, -pps / 30))
                                        throw new Error('fresh admission')
                                },
                                origin,
                                -pps / 30,
                            )!
                            ctx.drawVectors(fresh)
                            ctx.flush()
                            const freshPixels = read()
                            const exact = reused.every((value, i) => value === freshPixels[i])
                            ctx.releaseVectors(fresh)
                            reset(pps)
                            ctx.stroke(
                                createEventPath(
                                    -3,
                                    3,
                                    ((origin - halfSpan) * -pps) / 30,
                                    ((origin + halfSpan) * -pps) / 30,
                                    'inOutQuad',
                                ),
                            )
                            ctx.flush()
                            const old = read()
                            if (origin === 0 && reflect === 1 && pps === 137.31)
                                images.push({
                                    label: `span-${halfSpan}`,
                                    old: png(old),
                                    current: png(reused),
                                })
                            rows.push({
                                origin,
                                halfSpan,
                                reflect,
                                pps,
                                exact,
                                queuedRejected,
                                stable:
                                    mesh === range.eventStrokes![0]!.mesh &&
                                    mesh.geometry === geometry &&
                                    geometry.getBuffer('aPosition') === positionBuffer &&
                                    geometry.indexBuffer === indexBuffer,
                                comparison: diff(old, reused),
                                visible: reused.some((v, i) => i % 4 === 3 && v > 0),
                            })
                        }
                        ctx.releaseVectors(range)
                        if (!geometry.destroyed) throw new Error('owned geometry leaked')
                    }
            // Each camera/mask side is intentionally a separate translucent draw.
            ctx.clear()
            ctx.setTransform(30, 0, 0, 30, 240, 240)
            ctx.globalAlpha = 0.5
            ctx.lineWidth = 2 / 30
            const straight = prepareEventStroke(createEventPath(0, 0, -1, 1, 'linear'), 30)!
            const two = ctx.captureEventStrokeVectors(
                () => {
                    ctx.strokeEventPath(straight, -5)
                    ctx.strokeEventPath(straight, -5)
                },
                0,
                -5,
            )!
            ctx.drawVectors(two)
            ctx.flush()
            const twice = read()[(240 * 480 + 240) * 4 + 3]
            ctx.releaseVectors(two)
            ctx.clear()
            const direct = createEventPath(0, 0, 5, -5, 'linear')
            ctx.stroke(direct)
            ctx.stroke(direct)
            ctx.flush()
            const twiceReference = read()[(240 * 480 + 240) * 4 + 3]
            const beforeLoss = ctx.captureEventStrokeVectors(
                () => {
                    ctx.strokeEventPath(straight, -5)
                },
                0,
                -5,
            )!
            const oldOwner = ctx.resourceOwner
            const loss = gl.getExtension('WEBGL_lose_context')!
            await new Promise<void>((resolve) => {
                canvas.addEventListener('webglcontextlost', () => resolve(), { once: true })
                loss.loseContext()
            })
            await new Promise((resolve) => setTimeout(resolve, 50))
            await new Promise<void>((resolve) => {
                canvas.addEventListener('renderingready', () => resolve(), { once: true })
                loss.restoreContext()
            })
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            )
            const lossReleased =
                beforeLoss.released && !ctx.updateEventStrokeVectors(beforeLoss, 0, -10)
            ctx.clear()
            ctx.setTransform(30, 0, 0, 30, 240, 240)
            ctx.lineWidth = 2 / 30
            const restored = ctx.captureEventStrokeVectors(
                () => {
                    ctx.strokeEventPath(straight, -5)
                },
                0,
                -5,
            )!
            const restoredOwner =
                restored.owner === ctx.resourceOwner && restored.owner !== oldOwner
            ctx.releaseVectors(restored)
            return {
                rows,
                images,
                twice,
                twiceReference,
                lossReleased,
                restoredOwner,
                bytes: ctx.eventStrokeStats.bytes,
                glError: gl.getError(),
            }
        } finally {
            ctx.dispose()
        }
    })
    for (const entry of report.images)
        for (const kind of ['old', 'current'] as const)
            await testInfo.attach(`${entry.label}-${kind}`, {
                body: Buffer.from(entry[kind], 'base64'),
                contentType: 'image/png',
            })
    await testInfo.attach('event-stroke-report', {
        body: JSON.stringify({ ...report, images: undefined }, null, 2),
        contentType: 'application/json',
    })
    expect(errors).toEqual([])
    expect(report.rows).toHaveLength(56)
    for (const row of report.rows) {
        expect(row, JSON.stringify(row)).toMatchObject({
            exact: true,
            stable: true,
            queuedRejected: true,
            visible: true,
        })
        expect(row.comparison.maxAlpha).toBeLessThanOrEqual(128)
        if (row.origin === 0) {
            expect(row.comparison.outside, JSON.stringify(row)).toBe(0)
            expect(row.comparison.flat, JSON.stringify(row)).toBe(0)
            expect(row.comparison.coverage, JSON.stringify(row)).toBeLessThan(0.03)
        }
    }
    expect(report.twice).toBe(report.twiceReference)
    expect(report.twice).toBeGreaterThan(128)
    expect(report.lossReleased).toBe(true)
    expect(report.restoredOwner).toBe(true)
    expect(report.bytes).toBe(0)
    expect(report.glError).toBe(0)
})
