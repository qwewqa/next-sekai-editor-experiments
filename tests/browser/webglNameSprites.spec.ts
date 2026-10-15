import { expect, test } from '@playwright/test'

test(`device-pixel name sprites preserve pixels, state and queued lifetime`, async ({ page }) => {
    await page.route('**/__name-sprites', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html><body></body></html>',
        }),
    )

    await page.goto('/__name-sprites')
    const result = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const { DrawPath } = await import('/src/rendering/path.ts')
        const make = async () => {
            const canvas = document.createElement('canvas')
            canvas.width = 96
            canvas.height = 64
            document.body.append(canvas)
            const ctx = getDrawContext(canvas)
            await ctx.ready
            return ctx
        }
        const reference = await make(),
            actual = await make()
        const source = document.createElement('canvas')
        source.width = 35
        source.height = 19
        const native = source.getContext('2d')!
        native.fillStyle = '#ff00aa80'
        native.fillRect(0, 0, 35, 19)
        native.font = '13px Arial'
        native.fillStyle = '#ffff00'
        native.fillText('Text', 1, 14)
        const differences: number[] = [],
            stateChanges: number[] = []
        const state = (ctx: typeof actual) =>
            JSON.stringify({
                transform: [...ctx.getTransform().toFloat64Array()],
                alpha: ctx.globalAlpha,
                fill: ctx.fillStyle,
                stroke: ctx.strokeStyle,
                width: ctx.lineWidth,
                dash: ctx.getLineDash(),
                smoothing: ctx.imageSmoothingEnabled,
                font: ctx.font,
            })
        const compare = (a: typeof reference, b: typeof actual) => {
            const first = a.getImageData(0, 0, 96, 64).data
            const second = b.getImageData(0, 0, 96, 64).data
            differences.push(
                first.reduce((sum, value, index) => sum + +(value !== second[index]), 0),
            )
        }
        const oldDraw = (ctx: typeof actual, x: number, y: number) => {
            ctx.save()
            ctx.resetTransform()
            ctx.drawImage(source, x, y)
            ctx.restore()
        }
        const surfaces: ReturnType<typeof actual.createSurface>[] = []
        try {
            for (const child of [false, true]) {
                const a = child ? reference.createSurface(96, 64) : undefined
                const b = child ? actual.createSurface(96, 64) : undefined
                if (a) surfaces.push(a)
                if (b) surfaces.push(b)
                const expected = a?.getContext() ?? reference
                const drawn = b?.getContext() ?? actual
                for (const clip of [false, true])
                    for (const smoothing of [false, true])
                        for (const alpha of [0.25, 0.7, 1]) {
                            for (const ctx of [expected, drawn]) {
                                ctx.clear()
                                ctx.save()
                                if (clip) {
                                    const path = new DrawPath()
                                    path.roundRect(4, 3, 79, 51, 7)
                                    ctx.clip(path)
                                }
                                ctx.setTransform(2, 0.125, -0.25, -3, 11.5, 42.25)
                                ctx.globalAlpha = alpha
                                ctx.imageSmoothingEnabled = smoothing
                                ctx.fillStyle = '#123456'
                                ctx.strokeStyle = '#abcdef'
                                ctx.lineWidth = 3.5
                                ctx.setLineDash([3, 2])
                                ctx.font = '17px serif'
                            }
                            const before = state(drawn)
                            for (const [x, y] of [
                                [-3, 7],
                                [22, 8],
                                [72, 41],
                            ] as const) {
                                oldDraw(expected, x, y)
                                drawn.drawNameSprite(source, x, y)
                            }
                            stateChanges.push(+(before !== state(drawn)))
                            expected.restore()
                            drawn.restore()
                            compare(expected, drawn)
                        }
            }
            // Sampler changes and source release must flush queued readers before mutation.
            for (const ctx of [reference, actual]) {
                ctx.clear()
                ctx.resetTransform()
            }
            for (const smoothing of [true, false, true]) {
                reference.imageSmoothingEnabled = actual.imageSmoothingEnabled = smoothing
                reference.globalAlpha = actual.globalAlpha = 0.5
                oldDraw(reference, smoothing ? 8 : 20, 12)
                actual.drawNameSprite(source, smoothing ? 8 : 20, 12)
            }
            reference.releaseImage(source)
            actual.releaseImage(source)
            compare(reference, actual)
            // Released immutable artwork may be uploaded again without reviving stale pixels.
            oldDraw(reference, 54, 31)
            actual.drawNameSprite(source, 54, 31)
            compare(reference, actual)
            return { differences, stateChanges }
        } finally {
            for (const surface of surfaces) surface.dispose()
            reference.dispose()
            actual.dispose()
        }
    })
    expect(result.differences.every((count) => count === 0)).toBe(true)
    expect(result.stateChanges.every((count) => count === 0)).toBe(true)
})
