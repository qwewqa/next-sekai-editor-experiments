import { expect, test } from '@playwright/test'

test(`canonical vector origins preserve fresh pixels, distant curves and raised painter order (WebGL2)`, async ({
    page,
}) => {
    await page.route('**/__vector-origin-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }),
    )
    await page.goto('/__vector-origin-test')
    const results = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const { DrawPath } = await import('/src/rendering/path.ts')
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 384
        const ctx = getDrawContext(canvas)
        await ctx.ready
        const results = []
        try {
            for (const origin of [0, -8000, 100000, 1000000]) {
                const path = new DrawPath()
                path.moveTo(-2, origin - 2)
                path.bezierCurveTo(-4, origin - 1, 4, origin + 1, 2, origin + 2)
                path.lineTo(3, origin + 2)
                path.bezierCurveTo(5, origin + 1, -3, origin - 1, -1, origin - 2)
                path.closePath()
                const gradient = ctx.createLinearGradient(0, origin - 2, 0, origin + 2)
                gradient.addColorStop(0, '#51aaff30')
                gradient.addColorStop(1, '#51aaffc0')
                const draw = () => {
                    ctx.fillStyle = gradient
                    ctx.globalAlpha = 0.65
                    ctx.fill(path)
                    ctx.lineWidth = 0.075
                    ctx.strokeStyle = '#fff'
                    ctx.stroke(path)
                    ctx.lineWidth = 0.125
                    ctx.strokeStyle = '#a8ffff'
                    ctx.strokeClipped(path, path)
                    ctx.fillStyle = '#ff647e'
                    ctx.fillRect(-0.5, origin - 0.5, 1, 1)
                    // A later opaque shape is the raised item at this crossing.
                    ctx.globalAlpha = 1
                    ctx.fillStyle = '#ffe040'
                    ctx.fillRect(-0.2, origin - 0.2, 0.4, 0.4)
                }
                const matrix = (pan: number) =>
                    ctx.setTransform(37.5, 0, 0, -37.5, 192.25, origin * 37.5 + pan)
                ctx.clear()
                matrix(170.125)
                const retained = ctx.captureVectors(draw, [0, origin])!
                matrix(192.625)
                const replayed = ctx.drawVectors(retained)
                ctx.flush()
                const warm = ctx.getImageData(0, 0, 384, 384).data
                ctx.clear()
                matrix(192.625)
                const fresh = ctx.captureVectors(draw, [0, origin])!
                ctx.drawVectors(fresh)
                ctx.flush()
                const current = ctx.getImageData(0, 0, 384, 384).data
                ctx.clear()
                matrix(192.625)
                draw()
                ctx.flush()
                const direct = ctx.getImageData(0, 0, 384, 384).data
                let maxInterior = 0
                for (let y = 1; y < 383; y++)
                    for (let x = 1; x < 383; x++) {
                        const i = (y * 384 + x) * 4
                        let interior = true
                        for (let dy = -1; dy <= 1 && interior; dy++)
                            for (let dx = -1; dx <= 1 && interior; dx++) {
                                const j = ((y + dy) * 384 + x + dx) * 4
                                for (let c = 0; c < 4; c++)
                                    if (Math.abs(direct[i + c]! - direct[j + c]!) > 4)
                                        interior = false
                            }
                        if (interior)
                            for (let c = 0; c < 4; c++)
                                maxInterior = Math.max(
                                    maxInterior,
                                    Math.abs(direct[i + c]! - current[i + c]!),
                                )
                    }
                const center = (192 * 384 + 192) * 4
                results.push({
                    origin,
                    replayed,
                    changes: warm.reduce(
                        (count, value, index) => count + +(value !== current[index]),
                        0,
                    ),
                    visible: current.filter((value, index) => index % 4 === 3 && value > 0).length,
                    raised: Array.from(current.slice(center, center + 4)),
                    maxInterior,
                })
                ctx.releaseVectors(retained)
                ctx.releaseVectors(fresh)
            }
        } finally {
            ctx.dispose()
        }
        return results
    })
    for (const result of results) {
        expect(result.replayed, `origin ${result.origin}`).toBe(true)
        expect(result.changes, `origin ${result.origin}`).toBe(0)
        expect(result.visible, `origin ${result.origin}`).toBeGreaterThan(1000)
        expect(result.raised, `origin ${result.origin}`).toEqual([255, 224, 64, 255])
        expect(result.maxInterior, `origin ${result.origin}`).toBeLessThanOrEqual(3)
    }
})
