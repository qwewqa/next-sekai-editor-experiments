import { expect, test } from '@playwright/test'
import type { EditorDrawContext } from '../../src/editor/canvas/types'

test.describe('name halo overflow WebGL2', () => {
    test.beforeEach(async ({ page }) => {
        await page.route('**/__halo-overflow', (route) =>
            route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html lang="en"></html>',
            }),
        )
        // The reference takes the ordinary sprite path for the same fitted
        // string; only its per-sprite cache threshold is raised diagnostically.
        await page.route('**/src/editor/canvas/labelSprites.ts?halo*', async (route) => {
            const response = await route.fetch()
            const source = await response.text()
            const body = source.replace(
                /const maxSpritePixels = 256 \* 1024;/,
                route.request().url().endsWith('haloReference')
                    ? 'const maxSpritePixels = 1024 * 1024;'
                    : 'const maxSpritePixels = 1;',
            )
            if (body === source) throw new Error('Reference sprite threshold hook drifted')
            await route.fulfill({ response, body })
        })
        await page.goto('/__halo-overflow')
    })

    test('fitted oversized names preserve cached pixels, opacity and viewport clipping', async ({
        page,
    }) => {
        const result = await page.evaluate(async () => {
            const { getDrawContext, disposeDrawContext } = await import('/src/rendering/context.ts')
            const { createLabelSprites } = await import('/src/editor/canvas/labelSprites.ts')
            const referenceUrl = '/src/editor/canvas/labelSprites.ts?haloReference'
            const { createLabelSprites: createReference } = (await import(
                referenceUrl
            )) as typeof import('../../src/editor/canvas/labelSprites')
            const canvas = document.createElement('canvas')
            canvas.width = 3840
            canvas.height = 160
            const ctx = getDrawContext(canvas)
            const actual = createLabelSprites(),
                reference = createReference()
            const errors: number[] = []
            try {
                await ctx.ready
                const gl = canvas.getContext('webgl2')
                if (!gl) throw new Error('Missing test GL context')
                const context = {
                    ctx,
                    scale: 120,
                    fontFamily: 'Arial, sans-serif',
                    fontMiddle: 0.25,
                } as EditorDrawContext
                let drawnSource: { source: HTMLCanvasElement; x: number; y: number } | undefined
                const drawNameSprite = ctx.drawNameSprite
                ctx.drawNameSprite = function (source, x, y) {
                    drawnSource = { source, x, y }
                    return drawNameSprite.call(this, source, x, y)
                }
                // Actual fitName at1920 CSSpx, DPR2, width16 produces this47-code-unit string.
                const text = `${'M'.repeat(46)}\u2026`
                const samples = []
                let frame = 0
                for (const alpha of [1, 0.35]) {
                    for (const x of [0, -0.125, 0.5]) {
                        const render = (sprites: typeof actual) => {
                            ctx.clear()
                            ctx.globalAlpha = alpha
                            sprites.beginFrame(++frame)
                            const drawn = sprites.draw(
                                context,
                                new DOMMatrix([240, 0, 0, 240, 0, 0]),
                                text,
                                x,
                                0.4,
                                '#f6f',
                                0.4,
                                'left',
                                0.25,
                                true,
                            )
                            if (!drawn) throw new Error('Halo draw declined')
                            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
                            if (!drawnSource) throw new Error('Missing drawn source')
                            const { source, x: left, y: top } = drawnSource
                            const image = source
                                .getContext('2d')
                                ?.getImageData(0, 0, source.width, source.height)
                            if (!image) throw new Error('Missing native source pixels')
                            return { pixels, image, left, top }
                        }
                        const expectedSource = render(reference),
                            actualSource = render(actual)
                        const expected = expectedSource.pixels,
                            pixels = actualSource.pixels
                        let cpuMismatches = 0,
                            maxCpuDelta = 0
                        const sourcePixel = (source: typeof actualSource, i: number) => {
                            const pixel = Math.floor(i / 4),
                                x = (pixel % canvas.width) - source.left,
                                y = Math.floor(pixel / canvas.width) - source.top
                            if (
                                x < 0 ||
                                y < 0 ||
                                x >= source.image.width ||
                                y >= source.image.height
                            )
                                return 0
                            return (
                                source.image.data[(y * source.image.width + x) * 4 + (i % 4)] ?? 0
                            )
                        }
                        let mismatches = 0,
                            maxDelta = 0,
                            painted = 0,
                            maxAlphaDelta = 0,
                            maxPremultipliedDelta = 0,
                            flatMismatches = 0
                        for (let i = 0; i < pixels.length; i++) {
                            const cpuDelta = Math.abs(
                                sourcePixel(actualSource, i) - sourcePixel(expectedSource, i),
                            )
                            if (cpuDelta) cpuMismatches++
                            maxCpuDelta = Math.max(maxCpuDelta, cpuDelta)
                            const delta = Math.abs((pixels[i] ?? 0) - (expected[i] ?? 0))
                            if (delta) mismatches++
                            maxDelta = Math.max(maxDelta, delta)
                            if ((pixels[i] ?? 0) > 0) painted++
                            const base = i - (i % 4)
                            if (i % 4 === 3) maxAlphaDelta = Math.max(maxAlphaDelta, delta)
                            else
                                maxPremultipliedDelta = Math.max(
                                    maxPremultipliedDelta,
                                    Math.abs(
                                        ((pixels[i] ?? 0) * (pixels[base + 3] ?? 0)) / 255 -
                                            ((expected[i] ?? 0) * (expected[base + 3] ?? 0)) / 255,
                                    ),
                                )
                            if (
                                delta &&
                                base >= canvas.width * 4 &&
                                base + canvas.width * 4 + 4 < pixels.length &&
                                (base / 4) % canvas.width > 0 &&
                                (base / 4) % canvas.width < canvas.width - 1
                            ) {
                                let flat = true
                                for (const offset of [-canvas.width * 4, 0, canvas.width * 4])
                                    for (const column of [-4, 0, 4])
                                        for (let c = 0; c < 4; c++)
                                            if (
                                                pixels[base + offset + column + c] !==
                                                    pixels[base + c] ||
                                                expected[base + offset + column + c] !==
                                                    expected[base + c]
                                            )
                                                flat = false
                                if (flat) flatMismatches++
                            }
                        }
                        errors.push(gl.getError())
                        samples.push({
                            alpha,
                            x,
                            mismatches,
                            maxDelta,
                            painted,
                            maxAlphaDelta,
                            maxPremultipliedDelta,
                            flatMismatches,
                            cpuMismatches,
                            maxCpuDelta,
                        })
                    }
                }
                return {
                    samples,
                    errors,
                    webgl2:
                        typeof WebGL2RenderingContext !== 'undefined' &&
                        gl instanceof WebGL2RenderingContext,
                }
            } finally {
                actual.clear()
                reference.clear()
                disposeDrawContext(canvas)
            }
        })
        expect(result.webgl2).toBe(true)
        expect(result.errors).toEqual(Array(6).fill(0))
        for (const sample of result.samples) {
            expect(sample.painted).toBeGreaterThan(0)
            expect(sample.flatMismatches, JSON.stringify(sample)).toBe(0)
            if (sample.x === 0) {
                // Same texture width, so the same texels. A GPU or driver may still round the
                // sampling of an anti-aliased edge by a level or two, so edges differ by at most 2
                // channel levels in a few pixels. A wrong opacity changes flat interiors, which stay
                // exact above, and a shifted texture moves edges by far more than 2.
                expect(sample.maxDelta, JSON.stringify(sample)).toBeLessThanOrEqual(2)
                expect(sample.mismatches / sample.painted, JSON.stringify(sample)).toBeLessThan(
                    0.01,
                )
            } else {
                // Clipping changes the texture's width, so native linear UV
                // interpolation can round an AA edge differently. Keep shape,
                // flat interiors and opacity strict; permit <=2 premultiplied
                // channel levels and one alpha level only at nonflat edges.
                expect(sample.maxAlphaDelta, JSON.stringify(sample)).toBeLessThanOrEqual(1)
                expect(sample.maxPremultipliedDelta, JSON.stringify(sample)).toBeLessThan(2)
            }
        }
    })

    test('oversized upload is flushed and deleted while its immutable CPU raster remains reusable', async ({
        page,
    }) => {
        const result = await page.evaluate(async () => {
            const { getDrawContext, disposeDrawContext } = await import('/src/rendering/context.ts')
            const { createLabelSprites } = await import('/src/editor/canvas/labelSprites.ts')
            const { clearTextRasterCache } = await import('/src/rendering/textRaster.ts')
            const canvas = document.createElement('canvas')
            canvas.width = 3840
            canvas.height = 160
            const ctx = getDrawContext(canvas),
                sprites = createLabelSprites()
            try {
                await ctx.ready
                const gl = canvas.getContext('webgl2')
                if (!gl) throw new Error('Missing test GL context')
                const uploads = new Map<WebGLTexture, HTMLCanvasElement>()
                const deleted = new Set<WebGLTexture>()
                const sources: HTMLCanvasElement[] = []
                const texImage2D = gl.texImage2D,
                    deleteTexture = gl.deleteTexture
                gl.texImage2D = function (...args: unknown[]) {
                    Reflect.apply(texImage2D, gl, args)
                    const source = args.find((value) => value instanceof HTMLCanvasElement)
                    if (source instanceof HTMLCanvasElement) {
                        const texture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture
                        uploads.set(texture, source)
                        sources.push(source)
                    }
                } as typeof gl.texImage2D
                gl.deleteTexture = function (texture) {
                    if (texture) deleted.add(texture)
                    deleteTexture.call(gl, texture)
                }
                const context = {
                    ctx,
                    scale: 120,
                    fontFamily: 'Arial, sans-serif',
                    fontMiddle: 0.25,
                } as EditorDrawContext
                const samples = []
                let expected: Uint8ClampedArray | undefined
                for (let frame = 1; frame <= 3; frame++) {
                    ctx.clear()
                    ctx.globalAlpha = 0.35
                    sprites.beginFrame(frame)
                    sprites.draw(
                        context,
                        new DOMMatrix([240, 0, 0, 240, 0, 0]),
                        `${'M'.repeat(46)}\u2026`,
                        0,
                        0.4,
                        '#0aa',
                        0.4,
                        'left',
                        0.25,
                        true,
                    )
                    // Inspect before readback: fallback release itself must have
                    // submitted and deleted this frame's queued texture source.
                    const uploaded = uploads.size,
                        live = [...uploads.keys()].filter((texture) => !deleted.has(texture)).length
                    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
                    expected ??= pixels
                    samples.push({
                        uploaded,
                        live,
                        samePixels: expected.every((value, index) => value === pixels[index]),
                    })
                }
                sprites.clear()
                clearTextRasterCache()
                return {
                    samples,
                    uniqueSources: new Set(sources).size,
                    intact: sources.every((source) => source.width > 0 && source.height > 0),
                    painted: expected?.some((value) => value > 0),
                    error: gl.getError(),
                }
            } finally {
                sprites.clear()
                disposeDrawContext(canvas)
            }
        })
        expect(result.samples).toEqual([
            { uploaded: 1, live: 0, samePixels: true },
            { uploaded: 2, live: 0, samePixels: true },
            { uploaded: 3, live: 0, samePixels: true },
        ])
        expect(result).toMatchObject({
            uniqueSources: 1,
            intact: true,
            painted: true,
            error: 0,
        })
    })

    test('fallback keeps native whole-string language, direction, font and baseline semantics', async ({
        page,
    }) => {
        const result = await page.evaluate(async () => {
            const { getDrawContext, disposeDrawContext } = await import('/src/rendering/context.ts')
            const fallbackUrl = '/src/editor/canvas/labelSprites.ts?haloForceFallback'
            const referenceUrl = '/src/editor/canvas/labelSprites.ts?haloReference'
            const { createLabelSprites: createFallback } = (await import(
                fallbackUrl
            )) as typeof import('../../src/editor/canvas/labelSprites')
            const { createLabelSprites: createReference } = (await import(
                referenceUrl
            )) as typeof import('../../src/editor/canvas/labelSprites')
            const { clearTextRasterCache } = await import('/src/rendering/textRaster.ts')
            const canvas = document.createElement('canvas')
            canvas.width = 600
            canvas.height = 120
            const ctx = getDrawContext(canvas),
                actual = createFallback(),
                reference = createReference()
            let source: HTMLCanvasElement | undefined
            const drawNameSprite = ctx.drawNameSprite
            ctx.drawNameSprite = function (image, x, y) {
                source = image
                return drawNameSprite.call(this, image, x, y)
            }
            try {
                await ctx.ready
                let frame = 0
                const cases = [
                    {
                        text: 'Stage AV fi 0123',
                        family: 'Arial, sans-serif',
                        lang: 'en',
                        direction: 'ltr',
                        align: 'left',
                    },
                    {
                        text: '\u821e\u53f0\u30fb\u521d\u97f3\u30df\u30af \ud83c\udfb5',
                        family: 'sans-serif',
                        lang: 'ja',
                        direction: 'ltr',
                        align: 'center',
                    },
                    {
                        text: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629 123',
                        family: 'Arial, sans-serif',
                        lang: 'ar',
                        direction: 'rtl',
                        align: 'start',
                    },
                    {
                        text: 'Stage AV fi 0123',
                        family: 'serif',
                        lang: 'en',
                        direction: 'ltr',
                        align: 'end',
                    },
                ] as const
                const samples = []
                for (const item of cases) {
                    document.documentElement.lang = item.lang
                    ctx.direction = item.direction
                    const context = {
                        ctx,
                        scale: 33,
                        fontFamily: item.family,
                        fontMiddle: 0.35,
                    } as EditorDrawContext
                    const render = (sprites: typeof actual) => {
                        ctx.clear()
                        ctx.globalAlpha = 0.35
                        sprites.beginFrame(++frame)
                        if (
                            !sprites.draw(
                                context,
                                new DOMMatrix([41.25, 0, 0, 41.25, 0, 0]),
                                item.text,
                                6,
                                1,
                                '#0aa',
                                0.4,
                                item.align,
                                0.35,
                                true,
                            )
                        )
                            throw new Error('Halo declined')
                        return ctx.getImageData(0, 0, 600, 120).data
                    }
                    const expected = render(reference),
                        pixels = render(actual)
                    let maxPremultipliedDelta = 0,
                        maxAlphaDelta = 0
                    for (let i = 0; i < pixels.length; i += 4) {
                        maxAlphaDelta = Math.max(
                            maxAlphaDelta,
                            Math.abs((pixels[i + 3] ?? 0) - (expected[i + 3] ?? 0)),
                        )
                        for (let c = 0; c < 3; c++)
                            maxPremultipliedDelta = Math.max(
                                maxPremultipliedDelta,
                                Math.abs(
                                    ((pixels[i + c] ?? 0) * (pixels[i + 3] ?? 0)) / 255 -
                                        ((expected[i + c] ?? 0) * (expected[i + 3] ?? 0)) / 255,
                                ),
                            )
                    }
                    const beforeFontInvalidation = source
                    clearTextRasterCache()
                    render(actual)
                    samples.push({
                        ...item,
                        maxPremultipliedDelta,
                        maxAlphaDelta,
                        painted: pixels.some((value) => value > 0),
                        sourceLang: source?.lang,
                        fontInvalidationReplacedSource: source !== beforeFontInvalidation,
                    })
                }
                return samples
            } finally {
                actual.clear()
                reference.clear()
                disposeDrawContext(canvas)
            }
        })
        for (const sample of result) {
            expect(sample.painted).toBe(true)
            expect(sample.sourceLang).toBe(sample.lang)
            expect(sample.fontInvalidationReplacedSource).toBe(true)
            expect(sample.maxAlphaDelta, JSON.stringify(sample)).toBeLessThanOrEqual(1)
            expect(sample.maxPremultipliedDelta, JSON.stringify(sample)).toBeLessThan(2)
        }
    })
})
