import { expect, test } from '@playwright/test'

test('one-pixel waveform peaks survive nearest sampling in either axis and direction', async ({
    page,
}) => {
    await page.route('**/__waveform-sampling-test', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html></html>',
        }),
    )
    await page.goto('/__waveform-sampling-test')
    const failures = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const failures = []
        for (const axis of ['x', 'y']) {
            // Encode every source row/column independently. A skipped index
            // would hide an isolated attack in a peak waveform at this zoom.
            const image = new ImageData(axis === 'x' ? 2000 : 8, axis === 'y' ? 2000 : 8)
            for (let y = 0; y < image.height; y++) {
                for (let x = 0; x < image.width; x++) {
                    const index = axis === 'x' ? x : y
                    image.data.set(
                        [index % 256, Math.floor(index / 256), 0, 255],
                        (y * image.width + x) * 4,
                    )
                }
            }
            for (const direction of [1, -1]) {
                for (const phase of [0, 0.1, 0.25, 0.5, 0.75, 0.9]) {
                    const canvas = document.createElement('canvas')
                    canvas.width = axis === 'x' ? 1200 : 8
                    canvas.height = axis === 'y' ? 1200 : 8
                    const context = getDrawContext(canvas)
                    try {
                        if ('ready' in context) await context.ready
                        const translation = (direction === 1 ? -5 : 1995) + phase
                        context.setTransform(
                            axis === 'x' ? direction : 1,
                            0,
                            0,
                            axis === 'y' ? direction : 1,
                            axis === 'x' ? translation : 0,
                            axis === 'y' ? translation : 0,
                        )
                        context.imageSmoothingEnabled = false
                        if (
                            !('drawWaveform' in context) ||
                            typeof context.drawWaveform !== 'function'
                        )
                            throw new Error('The waveform renderer is unavailable')
                        context.drawWaveform(image, 0, 0)
                        const pixels = context.getImageData(
                            axis === 'x' ? 0 : 4,
                            axis === 'y' ? 0 : 4,
                            axis === 'x' ? 1200 : 1,
                            axis === 'y' ? 1200 : 1,
                        ).data
                        let mismatches = 0
                        for (let index = 0; index < 1200; index++) {
                            const source = (index + 0.5 - translation) / direction
                            // Canvas's tie convention chooses the lower source
                            // texel; away from a tie this is ordinary nearest.
                            const expected =
                                Math.abs(source - Math.round(source)) < 1e-8
                                    ? Math.round(source) - 1
                                    : Math.floor(source)
                            const actual = pixels[index * 4]! + pixels[index * 4 + 1]! * 256
                            if (actual !== expected || pixels[index * 4 + 3] !== 255) mismatches++
                        }
                        if (mismatches) failures.push({ axis, direction, phase, mismatches })
                    } finally {
                        context.dispose()
                    }
                }
            }
        }
        return failures
    })
    expect(failures).toEqual([])
})

test('near-one waveform zoom preserves every attack across adjacent tiles', async ({ page }) => {
    await page.route('**/__waveform-sampling-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }),
    )
    await page.goto('/__waveform-sampling-test')
    const failures = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const extent = 2000
        const images = [0, 1].map((tile) => {
            const image = new ImageData(8, extent)
            for (let row = 0; row < extent; row++) {
                const index = tile * extent + row
                for (let x = 0; x < image.width; x++)
                    image.data.set(
                        [index % 256, Math.floor(index / 256), 0, 255],
                        (row * image.width + x) * 4,
                    )
            }
            return image
        })
        const canvas = document.createElement('canvas')
        canvas.width = 8
        canvas.height = 4012
        const context = getDrawContext(canvas)
        const failures = []
        try {
            if ('ready' in context) await context.ready
            if (!('drawWaveform' in context) || typeof context.drawWaveform !== 'function')
                throw new Error('The waveform renderer is unavailable')
            for (const scale of [1, 1.000000036, 1.0000001, 1.00001, 1.0002]) {
                for (const direction of [1, -1]) {
                    for (const phase of [0, 0.1, 0.25, 0.5, 0.75, 0.9]) {
                        context.resetTransform()
                        context.clear()
                        const translation = (direction === 1 ? 4 : 4 + extent * 2 * scale) + phase
                        context.setTransform(1, 0, 0, direction * scale, 0, translation)
                        context.imageSmoothingEnabled = false
                        for (const [tile, image] of images.entries())
                            context.drawWaveform(image, 0, tile * extent)
                        const pixels = context.getImageData(4, 0, 1, canvas.height).data
                        const seen = new Set<number>()
                        let holes = 0
                        for (let row = 0; row < canvas.height; row++) {
                            const source = (row + 0.5 - translation) / (direction * scale)
                            // Outer quad edges can cover a fraction of a pixel;
                            // every interior source row must still be present.
                            if (source < 1 || source > extent * 2 - 1) continue
                            if (pixels[row * 4 + 3] !== 255) holes++
                            seen.add(pixels[row * 4]! + pixels[row * 4 + 1]! * 256)
                        }
                        const missing: number[] = []
                        for (let index = 2; index < extent * 2 - 2; index++)
                            if (!seen.has(index)) missing.push(index)
                        if (missing.length || holes)
                            failures.push({ scale, direction, phase, missing, holes })
                    }
                }
            }
        } finally {
            context.dispose()
        }
        return failures
    })
    expect(failures).toEqual([])
})

test('waveform meshes retain crop, clipping and opacity across texture release and reuse', async ({
    page,
}) => {
    await page.route('**/__waveform-sampling-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }),
    )
    await page.goto('/__waveform-sampling-test')
    const result = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const image = new ImageData(4, 4)
        for (let row = 0; row < 4; row++)
            for (let x = 0; x < 4; x++)
                image.data.set([255, 255, 255, row % 2 ? 128 : 255], (row * 4 + x) * 4)
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 16
        const context = getDrawContext(canvas)
        try {
            if ('ready' in context) await context.ready
            if (!('drawWaveform' in context) || typeof context.drawWaveform !== 'function')
                throw new Error('The waveform renderer is unavailable')
            context.imageSmoothingEnabled = false
            context.save()
            context.beginPath()
            context.rect(6, 4, 4, 4)
            context.clip()
            context.globalAlpha = 0.5
            context.drawWaveform(image, 0, 1, 4, 2, 4, 4, 8, 4)
            context.restore()
            context.drawWaveform(image, 12, 0)
            // Releasing a source must flush its queued readers before deleting it.
            context.releaseImage(image)
            const first = context.getImageData(0, 0, 16, 16).data
            const alpha = (pixels: Uint8ClampedArray, x: number, y: number) =>
                pixels[(y * 16 + x) * 4 + 3]!
            const samples = [
                [8, 4],
                [8, 6],
                [4, 4],
                [11, 4],
                [13, 0],
                [13, 1],
            ].map(([x, y]) => alpha(first, x!, y!))
            context.clear()
            context.drawWaveform(image, 0, 0, 16, 16)
            const second = context.getImageData(0, 0, 16, 16).data
            return {
                samples,
                reused: [alpha(second, 1, 1), alpha(second, 1, 5), alpha(second, 13, 1)],
            }
        } finally {
            context.dispose()
        }
    })
    expect(result.samples[0]).toBe(64)
    // Pixi's packed global alpha can round an exact half down by one unit.
    expect(Math.abs(result.samples[1]! - 128)).toBeLessThanOrEqual(1)
    expect(result.samples.slice(2)).toEqual([0, 0, 255, 128])
    expect(result.reused).toEqual([255, 128, 255])
})
