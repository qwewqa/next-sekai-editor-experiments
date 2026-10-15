import { expect, test } from '@playwright/test'

// Keep the native oracle and its helpers in this serialized browser function.
const compareRectangles = async (kind: 'wide' | 'corners' | 'phase') => {
    const { getDrawContext } = await import('/src/rendering/context.ts')
    const pathUrl = performance
        .getEntriesByType('resource')
        .reverse()
        .find(({ name }) => new URL(name).pathname === '/src/rendering/path.ts')?.name
    if (!pathUrl) throw new Error('The renderer did not load its path implementation')
    const { DrawPath } = (await import(pathUrl)) as typeof import('/src/rendering/path.ts')
    const lyonUrl = performance
        .getEntriesByType('resource')
        .reverse()
        .find(({ name }) => new URL(name).pathname === '/src/rendering/lyon.ts')?.name
    if (!lyonUrl) throw new Error('The renderer did not load its fill implementation')
    const lyon = (await import(lyonUrl)) as typeof import('/src/rendering/lyon.ts')
    await lyon.initializeLyon()
    const activeLyon = lyon.triangulateLyon(
        [
            {
                points: [
                    [0, 0],
                    [4, 0],
                    [4, 4],
                    [0, 4],
                ],
            },
        ],
        'nonzero',
        1,
    )
    if (!activeLyon?.length) throw new Error('This regression requires the active Lyon kernel')

    type Fixture = {
        name: string
        size: [number, number]
        rect: [number, number, number, number]
        matrix: [number, number, number, number, number, number]
        width: number
        dash: [number, number]
        phase: number
        repetitions: number
        cap?: CanvasLineCap
        crop: [number, number, number, number]
        attach?: boolean
    }
    const fixtures: Fixture[] = []
    if (kind === 'wide') {
        // Exact chart22212 hovered240-lane anchor, captured in Firefox at DPR1.5.
        // The horizontal sides span38,732physical pixels, mostly outside the canvas.
        for (const dpr of [1, 1.25, 1.5, 2]) {
            const scale = dpr / 1.5
            const width = Math.round(2580 * scale)
            const height = Math.round(1925 * scale)
            const top = (-24.63920265780731 * 161.25 + 4844.3662109375) * scale
            const bottom = top + 0.8 * 161.25 * scale
            const y = Math.floor(top - 5 * scale)
            fixtures.push({
                name: `captured wide hover / DPR${dpr}`,
                size: [width, height],
                rect: [-120.1, -24.63920265780731, 240.2, 0.8],
                matrix: [
                    161.25 * scale,
                    0,
                    0,
                    161.25 * scale,
                    1290 * scale,
                    4844.3662109375 * scale,
                ],
                width: 0.018604651162790697,
                dash: [0.05581395348837209, 0.037209302325581395],
                phase: 0,
                repetitions: 1,
                crop: [0, y, width, Math.ceil(bottom + 5 * scale) - y],
                attach: dpr === 1.5,
            })
        }
    } else if (kind === 'corners') {
        for (const dpr of [1, 1.25, 1.5, 2]) {
            for (const [sx, sy] of [
                [1, 1],
                [-1, 1],
                [1, -1],
                [-1, -1],
            ] as const) {
                fixtures.push({
                    name: `fractional corners / DPR${dpr} / signs${sx},${sy}`,
                    size: [320, 256],
                    rect: [
                        sx > 0 ? 16.25 : 113.5,
                        sy > 0 ? 20.125 : 81.25,
                        sx * 97.25,
                        sy * 61.125,
                    ],
                    matrix: [dpr, 0, 0, dpr, 16.375, 16.25],
                    width: 2.4,
                    dash: [8.25, 4.8],
                    phase: 0,
                    repetitions: 1,
                    crop: [0, 0, 320, 256],
                    attach: dpr === 1 && sx === 1 && sy === 1,
                })
            }
        }
    } else {
        // With this nonzero phase, the first/last separate dash contours can
        // overlap at the closing corner. They must still shade once per stroke.
        for (const phase of [0, 9.5]) {
            for (const repetitions of [1, 2]) {
                fixtures.push({
                    name: `closing-corner phase${phase} / ${repetitions} strokes`,
                    size: [352, 128],
                    rect: [0, 0, 100, 8],
                    matrix: [3, 0, 0, 3, 24.375, 40.25],
                    width: 2,
                    dash: [6, 4],
                    phase,
                    repetitions,
                    crop: [0, 0, 352, 128],
                    attach: phase === 0 && repetitions === 1,
                })
            }
        }
        for (const cap of ['butt', 'round'] as const) {
            fixtures.push({
                name:
                    cap === 'butt'
                        ? 'short dash gaps retain aggregate union'
                        : 'round caps retain aggregate union',
                size: [352, 128],
                rect: [0, 0, 100, 8],
                matrix: [3, 0, 0, 3, 24.375, 40.25],
                width: 2,
                dash: [6, cap === 'butt' ? 2 : 4],
                phase: 9.5,
                repetitions: 1,
                cap,
                crop: [0, 0, 352, 128],
            })
        }
    }

    const results = []
    const images: { name: string; data: string }[] = []
    for (const fixture of fixtures) {
        const pixels: Uint8ClampedArray[] = []
        const siblings: number[][] = []
        for (const backend of ['native', 'webgl', 'general'] as const) {
            const canvas = document.createElement('canvas')
            ;[canvas.width, canvas.height] = fixture.size
            const gpu = backend !== 'native' ? getDrawContext(canvas) : undefined
            if (gpu) await gpu.ready
            const target = (gpu ?? canvas.getContext('2d')!) as unknown as CanvasRenderingContext2D
            const general = new DrawPath()
            const [rx, ry, rw, rh] = fixture.rect
            general.moveTo(rx, ry)
            general.lineTo(rx + rw, ry)
            general.lineTo(rx + rw, ry + rh)
            general.lineTo(rx, ry + rh)
            general.closePath()
            try {
                // strokeRect must leave the caller's current path untouched.
                target.beginPath()
                target.moveTo(2, 3)
                target.lineTo(14, 3)
                target.lineTo(14, 15)
                target.closePath()
                target.save()
                target.setTransform(...fixture.matrix)
                target.globalAlpha = 0.5
                target.strokeStyle = '#fff'
                target.lineWidth = fixture.width
                target.lineCap = fixture.cap ?? 'butt'
                target.lineJoin = 'miter'
                target.miterLimit = 10
                target.setLineDash(fixture.dash)
                target.lineDashOffset = fixture.phase
                for (let i = 0; i < fixture.repetitions; i++) {
                    if (backend === 'general') gpu!.stroke(general)
                    else target.strokeRect(...fixture.rect)
                }
                target.restore()
                target.fillStyle = '#2397e1'
                target.fill()
                siblings.push(Array.from(target.getImageData(10, 6, 1, 1).data))
                const data = target.getImageData(...fixture.crop)
                pixels.push(data.data)
                if (fixture.attach) {
                    const copy = document.createElement('canvas')
                    copy.width = data.width
                    copy.height = data.height
                    copy.getContext('2d')!.putImageData(data, 0, 0)
                    images.push({
                        name: `${backend}-${fixture.name}`,
                        data: copy.toDataURL().split(',')[1]!,
                    })
                }
            } finally {
                general.dispose()
                gpu?.dispose()
            }
        }

        const [native, actual, general] = pixels as [
            Uint8ClampedArray,
            Uint8ClampedArray,
            Uint8ClampedArray,
        ]
        const generalDifferentBytes = actual.reduce(
            (count, value, index) => count + +(value !== general[index]),
            0,
        )
        const [, , width, height] = fixture.crop
        let nativeCoverage = 0
        let actualCoverage = 0
        let maxNativeAlpha = 0
        let maxActualAlpha = 0
        let flatPixels = 0
        let maxFlatDifference = 0
        let generalFlatDifference = 0
        let generalChangedPixels = 0
        let maxGeneralDifference = 0
        const flatDifferences: {
            x: number
            y: number
            native: number
            actual: number
            general: number
        }[] = []
        let outsideSilhouette = 0
        // The exact opaque sibling has its own assertion and is excluded from
        // stroke opacity/coverage statistics when the crop includes that corner.
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                if (fixture.crop[1] === 0 && x < 18 && y < 18) continue
                const index = (y * width + x) * 4 + 3
                const expected = native[index]!
                const observed = actual[index]!
                const original = general[index]!
                if (observed !== original) generalChangedPixels++
                maxGeneralDifference = Math.max(maxGeneralDifference, Math.abs(observed - original))
                nativeCoverage += expected
                actualCoverage += observed
                maxNativeAlpha = Math.max(maxNativeAlpha, expected)
                maxActualAlpha = Math.max(maxActualAlpha, observed)
                let low = 255
                let high = 0
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const alpha = native[index + (dy * width + dx) * 4]!
                        low = Math.min(low, alpha)
                        high = Math.max(high, alpha)
                    }
                }
                if (high - low <= 2) {
                    flatPixels++
                    maxFlatDifference = Math.max(maxFlatDifference, Math.abs(expected - observed))
                    generalFlatDifference = Math.max(
                        generalFlatDifference,
                        Math.abs(expected - original),
                    )
                    if (Math.abs(expected - observed) > 2 && flatDifferences.length < 12)
                        flatDifferences.push({
                            x,
                            y,
                            native: expected,
                            actual: observed,
                            general: original,
                        })
                }
                if (high === 0 && observed > 2) outsideSilhouette++
            }
        }
        results.push({
            name: fixture.name,
            nativeCoverage,
            coverageChange: Math.abs(actualCoverage / nativeCoverage - 1),
            maxNativeAlpha,
            maxActualAlpha,
            flatPixels,
            maxFlatDifference,
            generalFlatDifference,
            generalChangedPixels,
            maxGeneralDifference,
            generalDifferentBytes,
            flatDifferences,
            outsideSilhouette,
            siblings,
        })
    }
    return { activeLyon: true, results, images }
}

test.beforeEach(async ({ page }) => {
    await page.route('**/__dashed-rect-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
    )
    await page.goto('/__dashed-rect-test')
})

for (const [kind, title, count] of [
    ['wide', 'the wide hovered anchor preserves native dashes at fractional device scales', 4],
    ['corners', 'fractional dashed rectangle corners preserve opacity for all size directions', 16],
    ['phase', 'rectangle dash joins and ineligible styles preserve single-stroke opacity', 6],
] as const) {
    test(title, async ({ page }, testInfo) => {
        const result = await page.evaluate(compareRectangles, kind)
        await testInfo.attach('native-dash-comparisons', {
            body: JSON.stringify({ activeLyon: result.activeLyon, results: result.results }),
            contentType: 'application/json',
        })
        expect(result.activeLyon).toBe(true)
        expect(result.results).toHaveLength(count)
        for (const image of result.images) {
            await testInfo.attach(image.name, {
                body: Buffer.from(image.data, 'base64'),
                contentType: 'image/png',
            })
        }
        for (const comparison of result.results) {
            const detail = JSON.stringify(comparison)
            expect(comparison.nativeCoverage, detail).toBeGreaterThan(10000)
            expect(comparison.flatPixels, detail).toBeGreaterThan(10000)
            // Native strokeRect has pre-existing negative-size dash and end-on
            // seam differences from the general closed-polyline renderer. This
            // optimization must preserve every existing byte in those cases.
            expect(comparison.generalDifferentBytes, detail).toBe(0)
            if (kind === 'wide') {
                expect(comparison.maxFlatDifference, detail).toBeLessThanOrEqual(2)
                expect(comparison.coverageChange, detail).toBeLessThanOrEqual(0.03)
                expect(comparison.outsideSilhouette, detail).toBe(0)
            }
            expect(comparison.maxActualAlpha, detail).toBeLessThanOrEqual(
                comparison.maxNativeAlpha + 2,
            )
            expect(comparison.siblings, detail).toEqual([
                [35, 151, 225, 255],
                [35, 151, 225, 255],
                [35, 151, 225, 255],
            ])
        }
    })
}
