import { expect, test } from '@playwright/test'

test('grid labels use the measured integer-anchor policy without changing scene state', async ({
    page,
}) => {
    await page.route('**/__grid-labels', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html><body></body></html>',
        }),
    )
    await page.goto('/__grid-labels')
    const result = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const rasterUrl = performance
            .getEntriesByType('resource')
            .reverse()
            .find(({ name }) => new URL(name).pathname === '/src/rendering/textRaster.ts')?.name
        if (!rasterUrl) throw new Error('The renderer did not load its text raster implementation')
        const { getTextRaster, clearTextRasterCache } = (await import(
            rasterUrl
        )) as typeof import('/src/rendering/textRaster.ts')
        const make = async () => {
            const canvas = document.createElement('canvas')
            canvas.width = 330
            canvas.height = 150
            document.body.append(canvas)
            const ctx = getDrawContext(canvas)
            await ctx.ready
            return ctx
        }
        const actual = await make()
        const reference = await make()
        const native = document.createElement('canvas').getContext('2d')!
        const fontFamily = 'Arial, sans-serif'
        const scale = 60
        const middle = 0.35
        const baseline = 0.4 * scale * middle
        const state = () => ({
            matrix: actual.getTransform().toFloat64Array().join(','),
            font: actual.font,
            fillStyle: actual.fillStyle,
            alpha: actual.globalAlpha,
            align: actual.textAlign,
            smoothing: actual.imageSmoothingEnabled,
        })
        const captures: { source: HTMLCanvasElement; x: number; y: number }[] = []
        const target = actual as unknown as {
            drawLabelSprite(source: HTMLCanvasElement, x: number, y: number, alpha: number): void
        }
        const submit = target.drawLabelSprite.bind(actual)
        target.drawLabelSprite = (source, x, y, alpha) => {
            captures.push({ source, x, y })
            submit(source, x, y, alpha)
        }
        let cases = 0
        let differentPixels = 0
        let differentDescriptors = 0
        let changedState = 0
        let maximumMovement = 0
        const sources = new Set<HTMLCanvasElement>()
        try {
            for (const direction of ['ltr', 'rtl'] as const) {
                document.documentElement.dir = direction
                clearTextRasterCache()
                for (const dpr of [1, 1.25, 2])
                    for (const reflection of [1, -1])
                        for (const align of ['start', 'end'] as const)
                            for (const phase of [-0.5001, -0.5, -0.4999, 0, 0.4999, 0.5, 0.5001]) {
                                const x = align === 'start' ? -0.75 : 0.75
                                const y = 0.13
                                const transform = [
                                    60 * dpr * reflection,
                                    0,
                                    0,
                                    60 * dpr,
                                    165 + phase,
                                    50 - phase,
                                ] as const
                                for (const ctx of [actual, reference]) {
                                    ctx.clear()
                                    ctx.setTransform(1, 0, 0, 1, 0, 0)
                                    ctx.save()
                                    ctx.beginPath()
                                    ctx.rect(6, 8, 312, 113)
                                    ctx.clip()
                                    ctx.globalAlpha = 0.63
                                    ctx.imageSmoothingEnabled = false
                                    ctx.font = '13px serif'
                                    ctx.fillStyle = '#abcdef'
                                    ctx.textAlign = 'center'
                                }
                                actual.setTransform(...transform)
                                native.setTransform(...transform)
                                native.translate(x, y)
                                native.scale(1 / scale, 1 / scale)
                                const matrix = native.getTransform()
                                const rawX = matrix.c * baseline + matrix.e
                                const rawY = matrix.d * baseline + matrix.f
                                const anchorX = Math.round(rawX)
                                const anchorY = Math.round(rawY)
                                maximumMovement = Math.max(
                                    maximumMovement,
                                    Math.abs(anchorX - rawX),
                                    Math.abs(anchorY - rawY),
                                )
                                // Independent form of the measured prototype: the final native
                                // baseline anchor is rounded before raster layout/cropping.
                                const raster = getTextRaster({
                                    text: '12.5 שלום',
                                    x: 0,
                                    y: 0,
                                    font: `${0.4 * scale}px ${fontFamily}`,
                                    fontKerning: 'normal',
                                    textBaseline: 'alphabetic',
                                    textAlign: align,
                                    direction,
                                    fillStyle: '#fff',
                                    matrix: [
                                        matrix.a,
                                        matrix.b,
                                        matrix.c,
                                        matrix.d,
                                        anchorX,
                                        anchorY,
                                    ],
                                    viewport: actual.canvas,
                                })
                                if (raster) {
                                    sources.add(raster.source)
                                    reference.drawNameSprite(raster.source, raster.left, raster.top)
                                }
                                captures.length = 0
                                const before = JSON.stringify(state())
                                actual.drawGridLabel(
                                    '12.5 שלום',
                                    x,
                                    y,
                                    fontFamily,
                                    scale,
                                    align,
                                    middle,
                                )
                                const captured = captures[0]
                                changedState += +(before !== JSON.stringify(state()))
                                differentDescriptors += +(
                                    raster?.source !== captured?.source ||
                                    raster?.left !== captured?.x ||
                                    raster?.top !== captured?.y
                                )
                                const a = actual.getImageData(0, 0, 330, 150).data
                                const b = reference.getImageData(0, 0, 330, 150).data
                                differentPixels += a.reduce(
                                    (count, value, index) => count + +(value !== b[index]),
                                    0,
                                )
                                actual.restore()
                                reference.restore()
                                cases++
                            }
            }
            return {
                cases,
                differentPixels,
                differentDescriptors,
                changedState,
                maximumMovement,
                sourceCount: sources.size,
            }
        } finally {
            actual.dispose()
            reference.dispose()
        }
    })
    expect(result.cases).toBe(168)
    expect(result.differentDescriptors).toBe(0)
    expect(result.differentPixels).toBe(0)
    expect(result.changedState).toBe(0)
    expect(result.maximumMovement).toBeLessThanOrEqual(0.5)
    expect(result.sourceCount).toBeLessThan(result.cases)
})
