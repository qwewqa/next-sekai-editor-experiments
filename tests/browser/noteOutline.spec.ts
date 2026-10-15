import { expect, test } from '@playwright/test'

test(`oversized anchor edges composite each resolved note independently (WebGL2)`, async ({
    page,
}) => {
    await page.route('**/__note-outline-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
    )
    await page.goto('/__note-outline-test')
    const result = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const { strokeOffscreenAnchorBody } = await import('/src/editor/canvas/noteOutline.ts')
        const canvas = document.createElement('canvas')
        canvas.width = 160
        canvas.height = 96
        const ctx = getDrawContext(canvas)
        await ctx.ready
        let maximumDifference = 0
        let cases = 0
        const reset = () => {
            ctx.resetTransform()
            ctx.globalAlpha = 1
            ctx.clearRect(0, 0, canvas.width, canvas.height)
        }
        const background = () => {
            reset()
            ctx.fillStyle = '#404464'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
        }
        const note = (dpr: number, phase: number) => {
            ctx.setTransform(13 * dpr, 0, 0, 13 * dpr, -40 * dpr, 30 + phase)
            ctx.strokeStyle = '#fff'
            ctx.lineWidth = 2 / 13
            ctx.lineCap = 'butt'
            ctx.setLineDash([])
            if (!strokeOffscreenAnchorBody(ctx, 0, 240))
                throw new Error('Expected flat-body eligibility')
        }
        try {
            for (const dpr of [1, 1.25, 2, 3])
                for (const phase of [0.125, 0.3, 0.75]) {
                    // The reference resolves one note, then composites that image.
                    // This tests the accumulation contract independently of native
                    // Canvas implementations that retain MSAA between path draws.
                    reset()
                    note(dpr, phase)
                    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
                    try {
                        for (const alpha of [1, 0.5])
                            for (const repeats of [2, 8])
                                for (const layer of [false, true]) {
                                    background()
                                    ctx.globalAlpha = alpha
                                    for (let i = 0; i < repeats; i++) ctx.drawImage(image, 0, 0)
                                    const expected = ctx.getImageData(
                                        0,
                                        0,
                                        canvas.width,
                                        canvas.height,
                                    ).data
                                    background()
                                    ctx.globalAlpha = layer ? 1 : alpha
                                    for (let i = 0; i < repeats; i++) {
                                        if (layer)
                                            ctx.saveLayer(alpha, 0, 0, canvas.width, canvas.height)
                                        note(dpr, phase)
                                        if (layer) ctx.restore()
                                    }
                                    const actual = ctx.getImageData(
                                        0,
                                        0,
                                        canvas.width,
                                        canvas.height,
                                    ).data
                                    for (let i = 0; i < actual.length; i++) {
                                        maximumDifference = Math.max(
                                            maximumDifference,
                                            Math.abs(actual[i]! - expected[i]!),
                                        )
                                    }
                                    cases++
                                }
                    } finally {
                        ctx.releaseImage(image)
                    }
                }
            return { cases, maximumDifference, lost: ctx.isContextLost() }
        } finally {
            ctx.dispose()
        }
    })
    expect(result.cases).toBe(96)
    expect(result.lost).toBe(false)
    // The resolved image stores 8-bit alpha; the analytic primitive retains
    // continuous sample coverage through blending, allowing final-byte rounding.
    expect(result.maximumDifference).toBeLessThanOrEqual(2)
})
