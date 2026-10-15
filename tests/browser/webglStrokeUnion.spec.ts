import { expect, test } from '@playwright/test'

// This function is serialized into the page; keep its helpers inside the browser scope.
const clippingRegression = async (mode: 'dash' | 'mutation') => {
    const { getDrawContext } = await import('/src/rendering/context.ts')
    const pathUrl = performance
        .getEntriesByType('resource')
        .reverse()
        .find(({ name }) => new URL(name).pathname === '/src/rendering/path.ts')?.name
    if (!pathUrl) throw new Error('The renderer did not load its path implementation')
    const { DrawPath } = (await import(pathUrl)) as typeof import('/src/rendering/path.ts')
    const size = 384
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = getDrawContext(canvas)
    await ctx.ready
    const reference = document.createElement('canvas')
    reference.width = reference.height = size
    const native = reference.getContext('2d')!
    const comparisons: {
        label: string
        interiorPixels: number
        paintedInteriorPixels: number
        maxInteriorAlpha: number
        sibling: number[]
        expectedProbes: (number | undefined)[]
        actualProbes: (number | undefined)[]
    }[] = []
    const phaseChanges = []
    const mutations = []
    let snapshotChanges = 0
    const probes = [
        [30, 20],
        [65, 20],
        [70, 50],
        [100, 80],
    ] as const
    const changes = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
        a.reduce((count, value, i) => count + +(value !== b[i]), 0)
    const compare = (
        label: string,
        edge: InstanceType<typeof DrawPath>,
        body: InstanceType<typeof DrawPath>,
        nativeEdge: Path2D,
        nativeBody: Path2D,
        cap: CanvasLineCap = 'butt',
        dash: number[] = [],
        phase = 0,
    ) => {
        const pixels: Uint8ClampedArray[] = []
        for (const isNative of [true, false]) {
            const target = (isNative ? native : ctx) as unknown as CanvasRenderingContext2D
            target.resetTransform()
            target.clearRect(0, 0, size, size)
            target.save()
            target.setTransform(3, 0, 0, 3, 16.375, 16.25)
            target.beginPath()
            target.rect(4, 4, 112, 108)
            target.clip()
            target.lineWidth = 4
            target.lineCap = cap
            target.lineJoin = 'miter'
            target.globalAlpha = 0.5
            target.strokeStyle = '#fff'
            target.setLineDash(dash)
            target.lineDashOffset = phase
            if (isNative) {
                native.clip(nativeBody)
                native.stroke(nativeEdge)
            } else ctx.strokeClipped(edge, body)
            target.restore()
            target.fillStyle = '#2397e1'
            target.fillRect(2, 3, 11, 9)
            pixels.push(target.getImageData(0, 0, size, size).data)
        }
        const [expected, actual] = pixels as [Uint8ClampedArray, Uint8ClampedArray]
        let interiorPixels = 0
        let paintedInteriorPixels = 0
        let maxInteriorAlpha = 0
        // Use the existing stroke-union oracle unchanged: flat 3x3 native alpha,
        // then a maximum two-level alpha difference on those interior pixels.
        for (let y = 1; y < size - 1; y++)
            for (let x = 1; x < size - 1; x++) {
                const i = (y * size + x) * 4 + 3
                let flat = true
                for (let dy = -1; dy <= 1 && flat; dy++)
                    for (let dx = -1; dx <= 1 && flat; dx++)
                        if (Math.abs(expected[i]! - expected[i + (dy * size + dx) * 4]!) > 2)
                            flat = false
                if (!flat) continue
                interiorPixels++
                if (Math.abs(expected[i]! - 128) <= 2) paintedInteriorPixels++
                maxInteriorAlpha = Math.max(maxInteriorAlpha, Math.abs(expected[i]! - actual[i]!))
            }
        const alphaAtProbes = (data: Uint8ClampedArray) =>
            probes.map(([x, y]) => {
                const px = Math.floor(3 * x + 16.375)
                const py = Math.floor(3 * y + 16.25)
                return data[(py * size + px) * 4 + 3]
            })
        const sibling = (6 * size + 5) * 4
        comparisons.push({
            label,
            interiorPixels,
            paintedInteriorPixels,
            maxInteriorAlpha,
            sibling: Array.from(actual.slice(sibling, sibling + 4)),
            expectedProbes: alphaAtProbes(expected),
            actualProbes: alphaAtProbes(actual),
        })
        return { expected, actual }
    }
    try {
        if (mode === 'dash') {
            const edgeSvg = 'M12 24H98V88H22'
            const bodySvg = 'M6 15H54V97H6Z M68 15H104V97H68Z'
            const edge = new DrawPath(edgeSvg),
                body = new DrawPath(bodySvg)
            const nativeEdge = new Path2D(edgeSvg),
                nativeBody = new Path2D(bodySvg)
            for (const cap of ['butt', 'round', 'square'] as const) {
                const zero = compare(
                    `${cap}/phase0`,
                    edge,
                    body,
                    nativeEdge,
                    nativeBody,
                    cap,
                    [9, 6],
                )
                for (const phase of [1.75, -2.25]) {
                    const shifted = compare(
                        `${cap}/phase${phase}`,
                        edge,
                        body,
                        nativeEdge,
                        nativeBody,
                        cap,
                        [9, 6],
                        phase,
                    )
                    phaseChanges.push({
                        cap,
                        phase,
                        native: changes(zero.expected, shifted.expected),
                        actual: changes(zero.actual, shifted.actual),
                    })
                }
            }
        } else {
            const edge = new DrawPath('M20 20H70')
            const body = new DrawPath('M10 10H40V30H10Z')
            const nativeEdge = new Path2D('M20 20H70')
            const nativeBody = new Path2D('M10 10H40V30H10Z')
            compare('initial', edge, body, nativeEdge, nativeBody)
            const edgeCommands = edge.commands,
                bodyCommands = body.commands
            edge.lineTo(70, 80)
            body.rect(60, 10, 20, 80)
            nativeEdge.lineTo(70, 80)
            nativeBody.rect(60, 10, 20, 80)
            mutations.push(edge.commands === edgeCommands, body.commands === bodyCommands)
            const appended = compare('both appended in place', edge, body, nativeEdge, nativeBody)
            const oldEdge = edge.clone(),
                oldBody = body.clone()
            const oldNativeEdge = new Path2D(nativeEdge),
                oldNativeBody = new Path2D(nativeBody)
            edge.lineTo(110, 80)
            body.rect(60, 70, 58, 20)
            nativeEdge.lineTo(110, 80)
            nativeBody.rect(60, 70, 58, 20)
            mutations.push(edge.commands !== edgeCommands, body.commands !== bodyCommands)
            compare('both appended after cloning', edge, body, nativeEdge, nativeBody)
            const snapshot = compare(
                'earlier clones',
                oldEdge,
                oldBody,
                oldNativeEdge,
                oldNativeBody,
            )
            snapshotChanges = changes(appended.actual, snapshot.actual)
        }
        return { comparisons, phaseChanges, mutations, snapshotChanges }
    } finally {
        ctx.dispose()
    }
}

test.describe(`connector stroke coverage (WebGL2)`, () => {
    test.beforeEach(async ({ page }) => {
        await page.route('**/__stroke-union-test', (route) =>
            route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
        )
        await page.goto('/__stroke-union-test')
    })

    test('overlapping stroke triangles paint once inside nested clips', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const { getDrawContext } = await import('/src/rendering/context.ts')
            const pathUrl = performance
                .getEntriesByType('resource')
                .reverse()
                .find(({ name }) => new URL(name).pathname === '/src/rendering/path.ts')?.name
            if (!pathUrl) throw new Error('The renderer did not load its path implementation')
            const { DrawPath } = (await import(pathUrl)) as typeof import('/src/rendering/path.ts')
            const size = 384
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = size
            const ctx = getDrawContext(canvas)
            await ctx.ready
            const reference = document.createElement('canvas')
            reference.width = reference.height = size
            const native = reference.getContext('2d')!
            const fixtures = [
                ['miter contours', 'M-10 -10L0 0L-10 10M2.3 -3L2.3 3', 'butt'],
                ['square caps', 'M-10 -10L0 0M2.3 -3L2.3 3', 'square'],
                ['narrow U', 'M0 0V3H1V0', 'butt'],
                [
                    'same-contour miter',
                    'M-10 -10L0 0L-10 10L-10 20L10 20L10 -20L2.3 -20L2.3 3',
                    'butt',
                ],
                ['short L', 'M0 0L1 0L1 1', 'butt'],
            ] as const
            const results = []
            try {
                for (const [name, svg, cap] of fixtures) {
                    for (const mode of ['solid', 'repeat', 'gradient'] as const) {
                        const pixels: Uint8ClampedArray[] = []
                        for (const isNative of [true, false]) {
                            const target = (isNative
                                ? native
                                : ctx) as unknown as CanvasRenderingContext2D
                            target.resetTransform()
                            target.clearRect(0, 0, size, size)
                            target.save()
                            target.setTransform(8, 0, 0, 8, 192.375, 192.25)
                            target.beginPath()
                            target.rect(-20, -20, 40, 40)
                            target.clip()
                            target.beginPath()
                            target.moveTo(-24, 0)
                            target.lineTo(0, -24)
                            target.lineTo(24, 0)
                            target.lineTo(0, 24)
                            target.closePath()
                            target.clip()
                            target.lineWidth = 2
                            target.lineCap = cap
                            target.lineJoin = 'miter'
                            target.globalAlpha = 0.5
                            if (mode === 'gradient') {
                                const gradient = target.createLinearGradient(-20, -20, 20, 20)
                                gradient.addColorStop(0, '#ffffff40')
                                gradient.addColorStop(1, '#ffffffc0')
                                target.strokeStyle = gradient
                            } else target.strokeStyle = '#fff'
                            // Overlapping body contours must also shade only once.
                            const body = 'M-22 -22H2V22H-22Z M-2 -22H22V22H-2Z'
                            for (let i = 0; i < (mode === 'repeat' ? 2 : 1); i++) {
                                if (isNative) {
                                    native.save()
                                    native.clip(new Path2D(body))
                                    native.stroke(new Path2D(svg))
                                    native.restore()
                                } else ctx.strokeClipped(new DrawPath(svg), new DrawPath(body))
                            }
                            target.restore()
                            target.fillStyle = '#2397e1'
                            target.fillRect(2, 3, 11, 9)
                            pixels.push(target.getImageData(0, 0, size, size).data)
                        }
                        const [expected, actual] = pixels as [Uint8ClampedArray, Uint8ClampedArray]
                        let maxInteriorAlpha = 0
                        let interiorPixels = 0
                        for (let y = 1; y < size - 1; y++) {
                            for (let x = 1; x < size - 1; x++) {
                                const i = (y * size + x) * 4 + 3
                                let flat = true
                                for (let dy = -1; dy <= 1 && flat; dy++)
                                    for (let dx = -1; dx <= 1 && flat; dx++)
                                        if (
                                            Math.abs(
                                                expected[i]! - expected[i + (dy * size + dx) * 4]!,
                                            ) > 2
                                        )
                                            flat = false
                                if (flat) {
                                    interiorPixels++
                                    maxInteriorAlpha = Math.max(
                                        maxInteriorAlpha,
                                        Math.abs(expected[i]! - actual[i]!),
                                    )
                                }
                            }
                        }
                        const sibling = (6 * size + 5) * 4
                        results.push({
                            name,
                            mode,
                            interiorPixels,
                            maxInteriorAlpha,
                            sibling: Array.from(actual.slice(sibling, sibling + 4)),
                        })
                    }
                }
            } finally {
                ctx.dispose()
            }
            return results
        })
        for (const result of results) {
            expect(result.interiorPixels, JSON.stringify(result)).toBeGreaterThan(100000)
            expect(result.maxInteriorAlpha, JSON.stringify(result)).toBeLessThanOrEqual(2)
            expect(result.sibling).toEqual([35, 151, 225, 255])
        }
    })

    test('degenerate masks cannot replay old batches and erase keeps the established route', async ({
        page,
    }) => {
        const results = await page.evaluate(async () => {
            const { getDrawContext } = await import('/src/rendering/context.ts')
            const pathUrl = performance
                .getEntriesByType('resource')
                .reverse()
                .find(({ name }) => new URL(name).pathname === '/src/rendering/path.ts')?.name
            if (!pathUrl) throw new Error('The renderer did not load its path implementation')
            const { DrawPath } = (await import(pathUrl)) as typeof import('/src/rendering/path.ts')
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 160
            const ctx = getDrawContext(canvas)
            await ctx.ready
            const body = new DrawPath('M0 0H140V140H0Z')
            const edge = new DrawPath('M30 20V110H38V20')
            const normal = () => {
                ctx.clear()
                ctx.lineWidth = 16
                ctx.globalAlpha = 0.5
                ctx.strokeStyle = '#fff'
                ctx.strokeClipped(edge, body)
                return ctx.getImageData(0, 0, 160, 160).data
            }
            const difference = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
                a.reduce((count, value, i) => count + +(value !== b[i]), 0)
            const degenerate = []
            const erase = []
            try {
                const expected = normal()
                for (const svg of [
                    'M20 20L20 20',
                    'M20 20L20.000000001 20',
                    'M20 20L20.000000001 20M80 80L80.000000001 80',
                    'M1000000000000 20L1000000000000.001 20',
                ]) {
                    normal()
                    ctx.clear()
                    ctx.lineWidth = 1e-7
                    ctx.strokeClipped(new DrawPath(svg), body)
                    const nonzero = ctx.getImageData(0, 0, 160, 160).data.filter(Boolean).length
                    degenerate.push({
                        svg,
                        nonzero,
                        nextNormal: difference(expected, normal()),
                    })
                }
                for (const repetitions of [1, 2]) {
                    const pixels = []
                    for (const specialized of [false, true]) {
                        ctx.clear()
                        ctx.globalAlpha = 1
                        ctx.globalCompositeOperation = 'source-over'
                        ctx.fillStyle = '#80c0e0'
                        ctx.fillRect(0, 0, 160, 160)
                        ctx.globalAlpha = 0.5
                        ctx.globalCompositeOperation = 'destination-out'
                        for (let i = 0; i < repetitions; i++) {
                            if (specialized) ctx.strokeClipped(edge, body)
                            else {
                                ctx.save()
                                ctx.clip(body)
                                ctx.stroke(edge)
                                ctx.restore()
                            }
                        }
                        pixels.push(ctx.getImageData(0, 0, 160, 160).data)
                    }
                    erase.push(difference(pixels[0]!, pixels[1]!))
                }
            } finally {
                ctx.dispose()
            }
            return { degenerate, erase }
        })
        for (const result of results.degenerate) {
            expect(result.nonzero, result.svg).toBe(0)
            expect(result.nextNormal, result.svg).toBe(0)
        }
        expect(results.erase).toEqual([0, 0])
    })

    for (const mode of ['dash', 'mutation'] as const) {
        const title =
            mode === 'dash'
                ? 'dashed clipped strokes preserve nonzero dash phase'
                : 'stroke and body mutations refresh clipped coverage while clones preserve earlier pixels'
        test(title, async ({ page }) => {
            const result = await page.evaluate(clippingRegression, mode)
            for (const comparison of result.comparisons) {
                const detail = JSON.stringify(comparison)
                expect(comparison.interiorPixels, detail).toBeGreaterThan(100000)
                expect(comparison.paintedInteriorPixels, detail).toBeGreaterThan(100)
                expect(comparison.maxInteriorAlpha, detail).toBeLessThanOrEqual(2)
                expect(comparison.sibling, detail).toEqual([35, 151, 225, 255])
            }
            if (mode === 'dash') {
                expect(result.phaseChanges).toHaveLength(6)
                for (const phase of result.phaseChanges) {
                    expect(phase.native, JSON.stringify(phase)).toBeGreaterThan(100)
                    expect(phase.actual, JSON.stringify(phase)).toBeGreaterThan(100)
                }
            } else {
                expect(result.mutations).toEqual([true, true, true, true])
                expect(result.snapshotChanges).toBe(0)
                const expectedProbeCoverage = [
                    [128, 0, 0, 0],
                    [128, 128, 128, 0],
                    [128, 128, 128, 128],
                    [128, 128, 128, 0],
                ]
                expect(result.comparisons).toHaveLength(expectedProbeCoverage.length)
                for (const [step, comparison] of result.comparisons.entries())
                    comparison.actualProbes.forEach((alpha, index) => {
                        // Native Canvas may round half opacity to 127 or 128.
                        expect(
                            Math.abs(
                                comparison.expectedProbes[index]! -
                                    expectedProbeCoverage[step]![index]!,
                            ),
                            comparison.label,
                        ).toBeLessThanOrEqual(2)
                        expect(
                            Math.abs(alpha! - comparison.expectedProbes[index]!),
                            comparison.label,
                        ).toBeLessThanOrEqual(2)
                    })
            }
        })
    }
})
