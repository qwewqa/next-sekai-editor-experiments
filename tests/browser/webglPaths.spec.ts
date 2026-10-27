import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

test('WebGL retained paths preserve native Canvas geometry and strokes', async ({
    page,
}, testInfo) => {
    await page.addInitScript(() => performance.setResourceTimingBufferSize(5000))
    await page.goto('/')
    const results = await page.evaluate(async () => {
        const appImport = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url)
        const { getDrawContext, disposeDrawContext } = await appImport<
            typeof import('../../src/rendering/context')
        >('/src/rendering/context.ts')
        const pathUrl = performance
            .getEntriesByType('resource')
            .reverse()
            .find(({ name }) => new URL(name).pathname === '/src/rendering/path.ts')?.name
        if (!pathUrl) throw new Error('The renderer did not load its path implementation')
        const { DrawPath } = await appImport<typeof import('../../src/rendering/path')>(pathUrl)
        const size = 160
        const reference = document.createElement('canvas')
        reference.width = reference.height = size
        const context = reference.getContext('2d', { willReadFrequently: true })!
        const output = document.createElement('canvas')
        output.width = output.height = size
        const canvas = getDrawContext(output)
        await canvas.ready
        canvas.fillStyle = canvas.strokeStyle = '#fff'
        canvas.lineWidth = 3
        canvas.lineCap = 'butt'
        canvas.lineJoin = 'miter'
        canvas.miterLimit = 10

        type PathLike = Pick<
            Path2D,
            | 'moveTo'
            | 'lineTo'
            | 'closePath'
            | 'arc'
            | 'ellipse'
            | 'rect'
            | 'roundRect'
            | 'quadraticCurveTo'
            | 'bezierCurveTo'
        >
        const cases: {
            name: string
            svg?: string
            cap?: CanvasLineCap
            draw: (path: PathLike) => void
        }[] = [
            {
                name: 'open SVG continuation',
                svg: 'M20 20L120 20',
                draw: (path) => path.lineTo(120, 120),
            },
            {
                name: 'closed SVG continuation',
                svg: 'M20 20L120 20L120 120Z',
                draw: (path) => path.lineTo(20, 120),
            },
            {
                name: 'initial line',
                draw: (path) => {
                    path.lineTo(40, 50)
                    path.lineTo(110, 100)
                },
            },
            { name: 'initial quadratic', draw: (path) => path.quadraticCurveTo(35, 120, 120, 30) },
            {
                name: 'initial cubic',
                draw: (path) => path.bezierCurveTo(35, 120, 90, 100, 120, 30),
            },
            {
                name: 'closed continuation',
                draw: (path) => {
                    path.moveTo(30, 30)
                    path.lineTo(70, 40)
                    path.lineTo(50, 70)
                    path.closePath()
                    path.lineTo(120, 110)
                },
            },
            {
                name: 'negative rectangle',
                draw: (path) => {
                    path.rect(130, 30, -100, 100)
                    path.lineTo(10, 130)
                },
            },
            {
                name: 'elliptical corners',
                draw: (path) => path.roundRect(20, 40, 120, 60, { x: 30, y: 6 }),
            },
            {
                name: 'small corners',
                draw: (path) => path.roundRect(20, 40, 120, 60, { x: 1, y: 1 }),
            },
            {
                name: 'zero horizontal corner radius',
                draw: (path) => path.roundRect(20, 40, 120, 60, { x: 0, y: 20 }),
            },
            {
                name: 'zero vertical corner radius',
                draw: (path) => path.roundRect(20, 40, 120, 60, { x: 20, y: 0 }),
            },
            {
                name: 'zero width rounded rectangle',
                draw: (path) => path.roundRect(80, 40, 0, 60, { x: 0, y: 10 }),
            },
            {
                name: 'oversized corners',
                draw: (path) => path.roundRect(20, 40, 120, 60, [{ x: 100, y: 100 }, 20, 40, 5]),
            },
            {
                name: 'negative rounded rectangle',
                draw: (path) => {
                    path.roundRect(140, 100, -120, -60, [20, 10, 30, 0])
                    path.lineTo(70, 130)
                },
            },
            {
                name: 'flipped rounded rectangle',
                draw: (path) => path.roundRect(140, 40, -120, 60, [20, 10, 30, 0]),
            },
            { name: 'full circle', draw: (path) => path.arc(80, 80, 50, 0, Math.PI * 2) },
            {
                name: 'almost full circle',
                draw: (path) => path.arc(80, 80, 50, 0, Math.PI * 2 - 1e-8),
            },
            {
                name: 'opposite clockwise full turn',
                draw: (path) => path.arc(80, 80, 50, 0, -Math.PI * 2),
            },
            {
                name: 'connected full circle',
                draw: (path) => {
                    path.moveTo(20, 20)
                    path.arc(80, 80, 50, Math.PI / 4, Math.PI * 3)
                },
            },
            {
                name: 'reverse full circle',
                draw: (path) => path.arc(80, 80, 50, 0, -Math.PI * 2, true),
            },
            {
                name: 'opposite full turn',
                draw: (path) => path.arc(80, 80, 50, 0, Math.PI * 2, true),
            },
            {
                name: 'zero arc',
                draw: (path) => {
                    path.moveTo(20, 20)
                    path.arc(80, 80, 40, 1, 1)
                },
            },
            {
                name: 'ellipse',
                draw: (path) => path.ellipse(80, 80, 60, 30, 0, -Math.PI / 2, Math.PI * 1.5),
            },
            {
                name: 'rotated ellipse',
                draw: (path) => path.ellipse(80, 80, 60, 30, 0.7, -Math.PI / 2, Math.PI * 1.5),
            },
            {
                name: 'zero horizontal radius',
                draw: (path) => path.ellipse(80, 80, 0, 50, 0.4, 0, Math.PI * 2),
            },
        ]
        for (const cap of ['butt', 'round', 'square'] as const) {
            for (const duplicate of [false, true]) {
                cases.push({
                    name: `zero-length ${duplicate ? 'duplicate point' : 'move only'} ${cap}`,
                    cap,
                    draw: (path) => {
                        path.moveTo(80, 80)
                        if (duplicate) path.lineTo(80, 80)
                    },
                })
            }
        }
        for (const ccw of [false, true]) {
            for (const [start, end] of [
                [0.6, 1.2],
                [1.2, 0.6],
                [-7, 13],
                [13, -7],
            ]) {
                cases.push({
                    name: `arc ${start} ${end} ${ccw}`,
                    draw: (path) => {
                        path.moveTo(80, 80)
                        path.arc(80, 80, 50, start!, end!, ccw)
                        path.closePath()
                    },
                })
            }
        }
        const results = []
        try {
            for (const item of cases) {
                const expected = item.svg ? new Path2D(item.svg) : new Path2D()
                const actual = new DrawPath(item.svg)
                item.draw(expected)
                item.draw(actual)
                try {
                    for (const mode of ['fill', 'stroke', 'dash'] as const) {
                        context.clearRect(0, 0, size, size)
                        context.fillStyle = context.strokeStyle = '#fff'
                        context.lineWidth = 3
                        context.lineCap = canvas.lineCap = item.cap ?? 'butt'
                        context.setLineDash(mode === 'dash' ? [9, 6] : [])
                        if (mode === 'fill') context.fill(expected)
                        else context.stroke(expected)
                        canvas.clear()
                        canvas.setLineDash(mode === 'dash' ? [9, 6] : [])
                        if (mode === 'fill') canvas.fill(actual)
                        else canvas.stroke(actual)
                        const pixels = canvas.getImageData(0, 0, size, size).data
                        const baseline = context.getImageData(0, 0, size, size).data
                        let total = 0
                        let significant = 0
                        let mismatchedInterior = 0
                        for (let i = 3; i < baseline.length; i += 4) {
                            const difference = Math.abs(baseline[i]! - pixels[i]!)
                            total += difference
                            if (difference > 32) significant++
                            if (difference > 250) mismatchedInterior++
                        }
                        results.push({
                            name: `${item.name} ${mode}`,
                            meanAlphaError: total / (size * size),
                            significant,
                            mismatchedInterior,
                        })
                    }
                } finally {
                    actual.dispose()
                }
            }
        } finally {
            disposeDrawContext(output)
        }
        return results
    })
    const resultPath = testInfo.outputPath('path-parity.json')
    await writeFile(resultPath, JSON.stringify(results, null, 2))
    await testInfo.attach('path-parity', { path: resultPath, contentType: 'application/json' })
    for (const result of results) {
        expect.soft(result.meanAlphaError, JSON.stringify(result)).toBeLessThan(1.5)
        expect.soft(result.mismatchedInterior, JSON.stringify(result)).toBeLessThan(4)
    }
})

test("a frame's own paths leave the path cache after the frame while passed paths stay", async ({
    page,
}) => {
    await page.addInitScript(() => performance.setResourceTimingBufferSize(5000))
    await page.route('**/__path-cache', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html><body></body></html>',
        }),
    )
    await page.goto('/__path-cache')
    const frames = await page.evaluate(async () => {
        const { getDrawContext, disposeDrawContext } = await import('/src/rendering/context.ts')
        // The context's own module instance, so the passed path is recognized as one.
        const pathUrl = performance
            .getEntriesByType('resource')
            .reverse()
            .find(({ name }) => new URL(name).pathname === '/src/rendering/path.ts')?.name
        if (!pathUrl) throw new Error('The renderer did not load its path implementation')
        const { DrawPath } = (await import(pathUrl)) as typeof import('/src/rendering/path.ts')
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 64
        const ctx = getDrawContext(canvas)
        await ctx.ready
        const { paths } = ctx as unknown as {
            paths: { retainedBytes: number; stats: { native: number; fallback: number } }
        }
        const kept = new DrawPath()
        kept.rect(4, 4, 8, 8)
        const frames = []
        try {
            for (let y = 20; y < 28; y++) {
                ctx.clear()
                ctx.fillStyle = ctx.strokeStyle = '#fff'
                ctx.fill(kept)
                ctx.save()
                ctx.beginPath()
                ctx.rect(0, 0, 64, y + 10)
                ctx.clip()
                ctx.beginPath()
                ctx.moveTo(0, y)
                ctx.lineTo(64, y)
                ctx.stroke()
                ctx.restore()
                ctx.flush()
                frames.push({
                    bytes: paths.retainedBytes,
                    builds: paths.stats.native + paths.stats.fallback,
                })
            }
        } finally {
            disposeDrawContext(canvas)
        }
        return frames
    })
    // Each frame builds its own line and clip anew; the passed rectangle is built once.
    expect(frames.map(({ builds }) => builds)).toEqual(frames.map((_, i) => 3 + 2 * i))
    expect(frames.map(({ bytes }) => bytes)).toEqual(frames.map(() => frames[0]!.bytes))
})
