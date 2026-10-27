import { expect, test } from '@playwright/test'
import type { EditorDrawContext } from '../../src/editor/canvas/types'

test('WebGL text sprites preserve browser glyphs, baselines, transforms and languages', async ({
    page,
}) => {
    await page.goto('/')
    await page.evaluate(() => document.fonts.ready)
    const results = await page.evaluate(async () => {
        const modulePath = '/src/rendering/textRaster.ts'
        const { getTextRaster } = (await import(
            modulePath
        )) as typeof import('../../src/rendering/textRaster')
        const cases = [
            { text: 'AV Stage 1', font: '19.375px Arial', textAlign: 'center' },
            { text: 'مرحبا שלום', direction: 'rtl', textAlign: 'start' },
            { text: 'שלום world', direction: 'rtl', textAlign: 'end' },
            { text: '舞台名 Stage 🎵', lang: 'ja', textAlign: 'center' },
            { text: 'gÁ𝑥́j', font: 'italic 23px Georgia', textBaseline: 'top' },
            { text: 'gÁ𝑥́j', textBaseline: 'hanging' },
            { text: 'gÁ𝑥́j', textBaseline: 'middle' },
            { text: 'gÁ𝑥́j', textBaseline: 'ideographic' },
            { text: 'gÁ𝑥́j', textBaseline: 'bottom' },
            { text: 'AV transparent', fillStyle: 'rgba(190, 25, 120, 0.45)', fontKerning: 'none' },
            { text: 'Horizontally condensed label', maxWidth: 125, textAlign: 'end' },
            { text: 'Partly outside viewport', x: -15, textAlign: 'start' },
        ] as const
        const transforms = [
            [1, 0, 0, 1, 0.375, 0.625],
            [1.25, 0, 0, 1.25, 0.125, 0.375],
            [0.8, 0, 0, 1.75, 0.5, 0.25],
            [0.9, 0.25, -0.3, 1.1, 80.25, -50.5],
            [-1, 0, 0, 1.4, 400.25, 0.75],
        ] as const
        const results = []
        for (const item of cases) {
            for (const matrix of transforms) {
                const request = {
                    font: '20px system-ui, sans-serif',
                    fontKerning: 'normal' as const,
                    textAlign: 'left' as CanvasTextAlign,
                    textBaseline: 'alphabetic' as CanvasTextBaseline,
                    direction: 'ltr' as CanvasDirection,
                    lang: 'en',
                    fillStyle: '#5a96cd',
                    x: 175.625,
                    y: 95.375,
                    matrix,
                    viewport: { width: 640, height: 320 },
                    ...item,
                }
                const reference = document.createElement('canvas')
                reference.width = request.viewport.width
                reference.height = request.viewport.height
                reference.lang = request.lang
                const native = reference.getContext('2d')!
                Object.assign(native, {
                    font: request.font,
                    fontKerning: request.fontKerning,
                    textAlign: request.textAlign,
                    textBaseline: request.textBaseline,
                    direction: request.direction,
                    fillStyle: request.fillStyle,
                })
                // The measured editor policy snaps only the final text origin to
                // 1/64 device px. Compare whole-string native shaping at that
                // independent origin while retaining the original pixel bounds.
                const originX = matrix[0] * request.x + matrix[2] * request.y + matrix[4]
                const originY = matrix[1] * request.x + matrix[3] * request.y + matrix[5]
                const snappedX = Math.round(originX * 64) / 64
                const snappedY = Math.round(originY * 64) / 64
                native.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], snappedX, snappedY)
                if ('maxWidth' in request) native.fillText(request.text, 0, 0, request.maxWidth)
                else native.fillText(request.text, 0, 0)
                const actual = document.createElement('canvas')
                actual.width = reference.width
                actual.height = reference.height
                const context = actual.getContext('2d')!
                const raster = getTextRaster(request)
                if (raster) context.drawImage(raster.source, raster.left, raster.top)
                const expected = native.getImageData(0, 0, reference.width, reference.height).data
                const received = context.getImageData(0, 0, actual.width, actual.height).data
                let maximumAlphaDifference = 0
                let alphaDifference = 0
                let expectedAlpha = 0
                let differingPixels = 0
                let maximumPremultipliedDifference = 0
                for (let i = 3; i < expected.length; i += 4) {
                    const difference = Math.abs(expected[i]! - received[i]!)
                    maximumAlphaDifference = Math.max(maximumAlphaDifference, difference)
                    alphaDifference += difference
                    expectedAlpha += expected[i]!
                    if (difference) differingPixels++
                    for (let channel = i - 3; channel < i; channel++) {
                        maximumPremultipliedDifference = Math.max(
                            maximumPremultipliedDifference,
                            Math.abs(
                                expected[channel]! * expected[i]! -
                                    received[channel]! * received[i]!,
                            ) / 255,
                        )
                    }
                }
                results.push({
                    condensed: 'maxWidth' in request,
                    text: request.text,
                    baseline: request.textBaseline,
                    matrix,
                    originDisplacement: Math.max(
                        Math.abs(snappedX - originX),
                        Math.abs(snappedY - originY),
                    ),
                    maximumAlphaDifference,
                    relativeAlphaDifference: alphaDifference / (expectedAlpha || 1),
                    differingPixels,
                    maximumPremultipliedDifference,
                })
            }
        }
        return results
    })
    for (const result of results) {
        const description = JSON.stringify(result)
        expect(result.originDisplacement, description).toBeLessThanOrEqual(1 / 128)
        // Condensing a label to a width scales its glyphs horizontally, which some platforms
        // hint differently when drawn directly and when drawn through the sprite: a few edge
        // pixels differ by up to a quarter of the range. A shifted or mis-scaled sprite differs
        // at every edge by far more.
        const tolerance = result.condensed
            ? { alpha: 96, relative: 0.05, premultiplied: 96 }
            : { alpha: 1, relative: 0.001, premultiplied: 1 }
        expect(result.maximumAlphaDifference, description).toBeLessThanOrEqual(tolerance.alpha)
        expect(result.relativeAlphaDifference, description).toBeLessThan(tolerance.relative)
        expect(result.maximumPremultipliedDifference, description).toBeLessThanOrEqual(
            tolerance.premultiplied,
        )
    }
})

test('text raster cache reuses integer translations and invalidates when fonts change', async ({
    page,
}) => {
    await page.goto('/')
    const results = await page.evaluate(async () => {
        const modulePath = '/src/rendering/textRaster.ts'
        const { clearTextRasterCache, getTextRaster, getTextRasterFontGeneration } = (await import(
            modulePath
        )) as typeof import('../../src/rendering/textRaster')
        const request = {
            text: 'Stage AV',
            x: 100.25,
            y: 90.375,
            font: '21px Arial',
            fillStyle: '#fff',
            matrix: [1.25, 0, 0, 1.75, 10.25, 25.5] as const,
        }
        const first = getTextRaster(request)!
        const moved = getTextRaster({ ...request, matrix: [1.25, 0, 0, 1.75, 30.25, -14.5] })!
        const noisy = getTextRaster({
            ...request,
            matrix: [1.25, 0, 0, 1.75, 30.25 + 4e-12, -14.5 - 4e-12],
        })!
        const fractional = getTextRaster({ ...request, matrix: [1.25, 0, 0, 1.75, 30.5, -14.5] })!
        const before = getTextRasterFontGeneration()
        document.fonts.dispatchEvent(new Event('loadingdone'))
        const after = getTextRaster(request)!
        const fontGenerationAdvanced = getTextRasterFontGeneration() > before
        clearTextRasterCache()
        const variedRequests = Array.from({ length: 100 }, (_, index) => ({
            ...request,
            text: 'Size',
            font: `${12 + index / 4}px Arial`,
        }))
        const variedSources = variedRequests.map((value) => getTextRaster(value)!.source)
        const variedStylesReused = variedRequests.every(
            (value, index) => getTextRaster(value)!.source === variedSources[index],
        )
        clearTextRasterCache()
        return {
            reused: first.source === moved.source,
            offset: [moved.left - first.left, moved.top - first.top],
            changedFraction: fractional.source !== first.source,
            reusedWithFloatNoise: noisy.source === moved.source,
            invalidated: after.source !== first.source,
            oldSourceIntact:
                first.source.width === first.width && first.source.height === first.height,
            fontGenerationAdvanced,
            variedStylesReused,
        }
    })
    expect(results).toEqual({
        reused: true,
        offset: [20, -40],
        changedFraction: true,
        reusedWithFloatNoise: true,
        invalidated: true,
        oldSourceIntact: true,
        fontGenerationAdvanced: true,
        variedStylesReused: true,
    })
})

test('fractional-DPR label anchors snap to the same pixel as native Canvas', async ({ page }) => {
    await page.goto('/')
    const positions = await page.evaluate(async () => {
        const modulePath = '/src/editor/canvas/labelSprites.ts'
        const { createLabelSprites } = (await import(
            modulePath
        )) as typeof import('../../src/editor/canvas/labelSprites')
        const contextPath = '/src/rendering/context.ts'
        const { getDrawContext, disposeDrawContext } = (await import(
            contextPath
        )) as typeof import('../../src/rendering/context')
        const scale = 1528 / 30
        const positions: number[][][] = []
        for (const gpu of [false, true]) {
            const canvas = document.createElement('canvas')
            canvas.width = 1910
            canvas.height = 300
            const ctx = gpu ? getDrawContext(canvas) : canvas.getContext('2d')!
            if ('ready' in ctx) await ctx.ready
            ctx.setTransform(scale * 1.25, 0, 0, scale * 1.25, 955, 100)
            const transform = ctx.getTransform()
            ctx.resetTransform()
            const draws: number[][] = []
            // Native and GPU matrices feed the same sprite-position observer;
            // no texture is uploaded, so this recorder has nothing to release.
            const recorder = {
                drawNameSprite: (_source: HTMLCanvasElement, ...args: number[]) => draws.push(args),
                releaseImage() {},
            }
            const sprites = createLabelSprites()
            sprites.beginFrame(1)
            const context = {
                ctx: recorder,
                scale,
                pixelRatio: 1.25,
                fontFamily: 'Arial',
                fontMiddle: 0.25,
            } as unknown as EditorDrawContext
            for (const lane of [-4.5, -1.5, 1.5, 4.5])
                sprites.draw(context, transform, 'Default', lane, 0, '#a0a')
            positions.push(draws)
            sprites.clear()
            if (gpu) disposeDrawContext(canvas)
        }
        return positions
    })
    expect(positions[1]).toEqual(positions[0])
})

test('transform state preserves native scalar conversion and composed precision', async ({
    page,
}) => {
    await page.goto('/')
    const results = await page.evaluate(async () => {
        const contextPath = '/src/rendering/context.ts'
        const { getDrawContext, disposeDrawContext } = (await import(
            contextPath
        )) as typeof import('../../src/rendering/context')
        const canvas = document.createElement('canvas')
        const gpu = getDrawContext(canvas)
        await gpu.ready
        const native = document.createElement('canvas').getContext('2d')!
        const values = (matrix: DOMMatrix) => [
            matrix.a,
            matrix.b,
            matrix.c,
            matrix.d,
            matrix.e,
            matrix.f,
        ]
        let maximumRelativeDifference = 0
        let count = 0
        const compare = () => {
            const expected = values(native.getTransform())
            for (const [index, actual] of values(gpu.getTransform()).entries()) {
                maximumRelativeDifference = Math.max(
                    maximumRelativeDifference,
                    Math.abs(actual - expected[index]!) / Math.max(1, Math.abs(expected[index]!)),
                )
            }
            count++
        }
        for (let seed = 1; seed <= 20; seed++) {
            let random = seed
            const next = () => {
                random = (1664525 * random + 1013904223) >>> 0
                return (random / 4294967296 - 0.5) * 10
            }
            for (let step = 0; step < 50; step++) {
                const args = [next(), next(), next(), next(), next(), next()] as const
                for (const ctx of [native, gpu]) {
                    switch (step % 6) {
                        case 0:
                            ctx.setTransform(...args)
                            break
                        case 1:
                            ctx.transform(...args)
                            break
                        case 2:
                            ctx.scale(args[0], args[1])
                            break
                        case 3:
                            ctx.translate(args[0], args[1])
                            break
                        case 4:
                            ctx.rotate(args[0])
                            break
                        default:
                            ctx.setTransform({
                                a: args[0],
                                b: args[1],
                                c: args[2],
                                d: args[3],
                                e: args[4],
                                f: args[5],
                            })
                    }
                }
                compare()
            }
        }
        for (const ctx of [native, gpu]) {
            ctx.setTransform(1, 0, 0, 1528 / 26, 0, 0)
            ctx.scale(1, 1000 / (1528 / 26))
        }
        compare()
        const composedScale = gpu.getTransform().d
        const preservedNativeComposition = composedScale === native.getTransform().d
        disposeDrawContext(canvas)
        return { maximumRelativeDifference, count, preservedNativeComposition }
    })
    expect(results.count).toBe(1001)
    expect(results.maximumRelativeDifference).toBeLessThan(1e-12)
    expect(results.preservedNativeComposition).toBe(true)
})
