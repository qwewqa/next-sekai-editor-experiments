import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
    await page.route('**/__webgl-context-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }),
    )
    await page.goto('/__webgl-context-test')
})

test('queued sprites retain their source pixels through mutation and disposal', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { getDrawContext, disposeDrawContext, peekDrawContext } =
            await import('/src/rendering/context.ts')
        const canvas = document.createElement('canvas')
        canvas.width = 128
        canvas.height = 64
        const target = getDrawContext(canvas)
        await ('ready' in target ? target.ready : undefined)
        const source = target.createSurface(32, 32)
        const drawing = source.getContext()
        drawing.fillStyle = '#ff0000'
        drawing.fillRect(0, 0, 32, 32)
        target.drawImage(source, 0, 0)
        // Mutating a sprite cannot alter an earlier queued draw of its pixels.
        drawing.fillStyle = '#00ff00'
        drawing.fillRect(0, 0, 32, 32)
        target.drawImage(source, 32, 0)
        // Nor can releasing the source discard the second queued draw.
        source.dispose()
        const red = [...target.getImageData(16, 16, 1, 1).data]
        const green = [...target.getImageData(48, 16, 1, 1).data]
        const child = target.createSurface(32, 32)
        const childContext = child.getContext()
        childContext.fillStyle = '#0000ff'
        childContext.fillRect(0, 0, 32, 32)
        target.drawImage(child, 64, 0)
        disposeDrawContext(canvas)
        const lost = childContext.isContextLost()
        // Disposing the parent already released this child; cleanup stays idempotent.
        child.dispose()
        disposeDrawContext(canvas)
        return { red, green, lost, unregistered: peekDrawContext(canvas) === undefined }
    })
    expect(result).toEqual({
        red: [255, 0, 0, 255],
        green: [0, 255, 0, 255],
        lost: true,
        unregistered: true,
    })
})

test('empty clips block all paint and recycled clip containers restore normal coverage', async ({
    page,
}) => {
    const results = await page.evaluate(async () => {
        const { getDrawContext, disposeDrawContext } = await import('/src/rendering/context.ts')
        const pathUrl = performance
            .getEntriesByType('resource')
            .reverse()
            .find(({ name }) => new URL(name).pathname === '/src/rendering/path.ts')?.name
        if (!pathUrl) throw new Error('The renderer did not load its path implementation')
        const { DrawPath } = (await import(pathUrl)) as typeof import('/src/rendering/path.ts')
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 48
        const ctx = getDrawContext(canvas)
        await ctx.ready
        const results = []
        try {
            for (const kind of ['empty', 'point', 'cancelled'] as const) {
                ctx.clear()
                // Prime reused drawing containers with actual visible geometry.
                ctx.fillStyle = '#f00'
                ctx.fillRect(0, 0, 48, 48)
                ctx.getImageData(0, 0, 1, 1)
                ctx.clear()
                const empty = new DrawPath()
                if (kind === 'point') {
                    empty.moveTo(12, 12)
                    empty.lineTo(12, 12)
                } else if (kind === 'cancelled') {
                    empty.rect(4, 4, 20, 20)
                    empty.rect(4, 4, 20, 20)
                }
                ctx.save()
                ctx.clip(empty, kind === 'cancelled' ? 'evenodd' : 'nonzero')
                ctx.fillStyle = '#0f0'
                ctx.fillRect(0, 0, 48, 48)
                const hidden = ctx.getImageData(0, 0, 48, 48).data
                ctx.restore()
                ctx.clear()
                const normal = new DrawPath()
                normal.rect(4, 4, 20, 20)
                ctx.save()
                ctx.clip(normal)
                ctx.fillStyle = '#00f'
                ctx.fillRect(0, 0, 48, 48)
                const visible = ctx.getImageData(0, 0, 48, 48).data
                ctx.restore()
                let wrong = 0
                for (let y = 0; y < 48; y++)
                    for (let x = 0; x < 48; x++) {
                        const i = (y * 48 + x) * 4
                        const inside = x >= 4 && x < 24 && y >= 4 && y < 24
                        if (
                            visible[i] !== 0 ||
                            visible[i + 1] !== 0 ||
                            visible[i + 2] !== (inside ? 255 : 0) ||
                            visible[i + 3] !== (inside ? 255 : 0)
                        )
                            wrong++
                    }
                results.push({ kind, hidden: hidden.some((value) => value !== 0), wrong })
                empty.dispose()
                normal.dispose()
            }
        } finally {
            disposeDrawContext(canvas)
        }
        return results
    })
    for (const result of results)
        expect(result, result.kind).toEqual({
            kind: result.kind,
            hidden: false,
            wrong: 0,
        })
})

test('drawing transforms, even-odd clips, alpha blending and image crops match native pixels', async ({
    page,
}, testInfo) => {
    const { results, images } = await page.evaluate(async () => {
        const { getDrawContext, disposeDrawContext } = await import('/src/rendering/context.ts')
        // Use the exact module URL already imported by the renderer, including
        // a development-server revision query, so instanceof checks stay valid.
        const pathUrl = performance
            .getEntriesByType('resource')
            .reverse()
            .find(({ name }) => new URL(name).pathname === '/src/rendering/path.ts')?.name
        if (!pathUrl) throw new Error('The renderer did not load its path implementation')
        const { DrawPath } = (await import(pathUrl)) as typeof import('/src/rendering/path.ts')
        const size = 160
        const source = document.createElement('canvas')
        source.width = 48
        source.height = 32
        const sourceContext = source.getContext('2d')!
        const sourcePixels = sourceContext.createImageData(source.width, source.height)
        for (let y = 0; y < source.height; y++) {
            for (let x = 0; x < source.width; x++) {
                const offset = (y * source.width + x) * 4
                sourcePixels.data.set([x * 5, y * 7, (x % 2) * 255, 255], offset)
            }
        }
        sourceContext.putImageData(sourcePixels, 0, 0)
        const translucentPixels = new ImageData(16, 16)
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
                translucentPixels.data.set([192, 96, 32, x < 8 ? 64 : 192], (y * 16 + x) * 4)
            }
        }
        const translucentCanvas = document.createElement('canvas')
        translucentCanvas.width = translucentCanvas.height = 16
        translucentCanvas.getContext('2d')!.putImageData(translucentPixels, 0, 0)
        const decode = async (canvas: HTMLCanvasElement) => {
            const image = new Image()
            image.src = canvas.toDataURL()
            await image.decode()
            return image
        }
        // These are the editor's actual native image producers: glyph canvases
        // and decoded waveform images. Preview/cover bitmaps use their own GL.
        const [sourceImage, translucentImage] = await Promise.all([
            decode(source),
            decode(translucentCanvas),
        ])
        const cases: {
            name: string
            edgeAntialias?: boolean
            draw: (ctx: CanvasRenderingContext2D, path: Path2D) => void
        }[] = [
            {
                name: 'putImageData replaces only its pixels and ignores drawing state',
                draw(ctx, path) {
                    ctx.fillStyle = '#2040e0'
                    ctx.fillRect(0, 0, size, size)
                    const data = new ImageData(12, 8)
                    for (let i = 0; i < data.data.length; i += 4) {
                        data.data.set([240, 48, 96, i % 8 ? 128 : 0], i)
                    }
                    path.rect(120, 120, 16, 16)
                    ctx.save()
                    ctx.clip(path)
                    ctx.translate(80, 80)
                    ctx.globalAlpha = 0.25
                    ctx.globalCompositeOperation = 'destination-out'
                    ctx.putImageData(data, 24, 32)
                    ctx.restore()
                },
            },
            ...(
                [
                    ['HTMLCanvasElement', source],
                    ['decoded HTMLImageElement', sourceImage],
                ] as const
            ).map(([name, image]) => ({
                name: `${name} preserves orientation and cropped pixels`,
                draw(ctx: CanvasRenderingContext2D) {
                    ctx.imageSmoothingEnabled = false
                    ctx.drawImage(image, 8, 8)
                    ctx.drawImage(image, 5, 7, 32, 16, 72, 8, 64, 32)
                    ctx.setTransform(-1, 0, 0, -1, 112, 120)
                    ctx.drawImage(image, 0, 0)
                },
            })),
            ...(
                [
                    ['HTMLCanvasElement', translucentCanvas],
                    ['decoded HTMLImageElement', translucentImage],
                ] as const
            ).map(([name, image]) => ({
                name: `${name} blends translucent source pixels`,
                draw(ctx: CanvasRenderingContext2D) {
                    ctx.fillStyle = '#2060c0'
                    ctx.fillRect(0, 0, 64, 64)
                    ctx.imageSmoothingEnabled = false
                    ctx.drawImage(image, 8, 8)
                    ctx.globalAlpha = 0.5
                    ctx.drawImage(image, 40, 40)
                    ctx.drawImage(image, 88, 88)
                },
            })),
            ...(['butt', 'round', 'square'] as const).flatMap((cap) =>
                [false, true].map((dashed) => ({
                    name: `fractional axis-scaled ${cap} lines${dashed ? ' with dashes' : ''}`,
                    edgeAntialias: true,
                    draw(ctx: CanvasRenderingContext2D, path: Path2D) {
                        ctx.strokeStyle = 'rgba(32,176,232,0.75)'
                        ctx.lineCap = cap
                        ctx.lineWidth = 2.75
                        if (dashed) {
                            ctx.setLineDash([7.25, 3.5])
                            ctx.lineDashOffset = 1.75
                        }
                        ctx.beginPath()
                        ctx.moveTo(12.25, 16.75)
                        ctx.lineTo(132.5, 32.125)
                        ctx.stroke()
                        // The editor uses axis-aligned scale/translation transforms.
                        ctx.setTransform(0.8, 0, 0, 1.1, 20.25, 40.75)
                        path.moveTo(8.125, 12.75)
                        path.lineTo(124.25, 36.5)
                        ctx.stroke(path)
                        // Current paths preserve their construction transform even
                        // when the transform changes before the stroke.
                        ctx.beginPath()
                        ctx.moveTo(16.25, 60.125)
                        ctx.lineTo(120.75, 72.5)
                        ctx.resetTransform()
                        ctx.lineWidth = 1.25
                        ctx.stroke()
                    },
                })),
            ),
            {
                name: 'fractional full-circle fills under transforms',
                edgeAntialias: true,
                draw(ctx) {
                    ctx.fillStyle = 'rgba(232,48,128,0.75)'
                    for (const [x, y, radius] of [
                        [18.25, 20.75, 7.125],
                        [62.125, 26.25, 18.75],
                        [118.5, 30.125, 23.375],
                    ]) {
                        ctx.beginPath()
                        ctx.arc(x!, y!, radius!, 0, Math.PI * 2)
                        ctx.fill()
                    }
                    ctx.setTransform(1.125, 0, 0, 0.875, 48.25, 76.5)
                    ctx.beginPath()
                    ctx.arc(24.125, 18.375, 19.75, 0, Math.PI * 2)
                    ctx.fill()
                },
            },
            {
                name: 'fractional full-circle butt strokes under transforms',
                edgeAntialias: true,
                draw(ctx) {
                    ctx.strokeStyle = 'rgba(32,192,96,0.75)'
                    ctx.lineCap = 'butt'
                    for (const [x, y, radius, width] of [
                        [18.25, 20.75, 7.125, 1.25],
                        [62.125, 26.25, 18.75, 2.75],
                        [118.5, 30.125, 23.375, 5.125],
                    ]) {
                        ctx.lineWidth = width!
                        ctx.beginPath()
                        ctx.arc(x!, y!, radius!, 0, Math.PI * 2)
                        ctx.stroke()
                    }
                    ctx.setTransform(1.125, 0, 0, 0.875, 48.25, 76.5)
                    ctx.beginPath()
                    ctx.arc(24.125, 18.375, 19.75, 0, Math.PI * 2)
                    ctx.stroke()
                },
            },
            {
                name: 'current path records each transform',
                draw(ctx) {
                    ctx.fillStyle = '#32b4e6'
                    ctx.setTransform(2, 0, 0, 2, 8, 4)
                    ctx.beginPath()
                    ctx.moveTo(4, 4)
                    ctx.lineTo(40, 4)
                    ctx.translate(8, 12)
                    ctx.lineTo(32, 32)
                    ctx.lineTo(-4, 32)
                    ctx.closePath()
                    ctx.resetTransform()
                    ctx.fill()
                },
            },
            {
                name: 'retained path applies current transform',
                draw(ctx, path) {
                    path.rect(8, 8, 40, 32)
                    ctx.fillStyle = '#e64696'
                    ctx.setTransform(2, 0, 0, 2, 4, 8)
                    ctx.fill(path)
                    ctx.setTransform(1, 0, 0, 1, 76, 90)
                    ctx.fill(path)
                },
            },
            {
                name: 'even-odd clipping and restore',
                draw(ctx, path) {
                    path.rect(8, 8, 64, 64)
                    path.rect(24, 24, 32, 32)
                    ctx.save()
                    ctx.setTransform(2, 0, 0, 2, 0, 0)
                    ctx.clip(path, 'evenodd')
                    ctx.resetTransform()
                    ctx.fillStyle = '#00c080'
                    ctx.fillRect(0, 0, size, size)
                    ctx.restore()
                    ctx.fillStyle = '#c040f0'
                    ctx.fillRect(64, 64, 32, 32)
                },
            },
            {
                name: 'source-over premultiplied alpha',
                draw(ctx) {
                    ctx.fillStyle = 'rgba(255,32,0,0.25)'
                    ctx.fillRect(16, 16, 96, 96)
                    ctx.globalAlpha = 0.6
                    ctx.fillStyle = 'rgba(0,128,255,0.75)'
                    ctx.fillRect(48, 48, 96, 96)
                    ctx.globalAlpha = 1
                    ctx.fillStyle = 'rgba(64,255,32,0.5)'
                    ctx.fillRect(32, 80, 80, 48)
                },
            },
            {
                name: 'image crop at one-to-one scale',
                draw(ctx) {
                    ctx.drawImage(source, 7, 5, 32, 24, 16, 20, 32, 24)
                    ctx.drawImage(source, -8, -6, 32, 24, 64, 60, 32, 24)
                    ctx.drawImage(source, 40, 26, 32, 24, 112, 110, 32, 24)
                },
            },
            {
                name: 'mirrored nearest image and transparent overlay',
                draw(ctx) {
                    ctx.imageSmoothingEnabled = false
                    ctx.setTransform(-2, 0, 0, -2, 120, 120)
                    ctx.drawImage(source, 0, 0)
                    ctx.resetTransform()
                    ctx.globalAlpha = 0.25
                    ctx.drawImage(source, 32, 32)
                },
            },
            {
                name: 'batched sprites preserve order, clips and saved alpha',
                draw(ctx, path) {
                    ctx.imageSmoothingEnabled = false
                    ctx.drawImage(source, 8, 8)
                    ctx.drawImage(source, 40, 16)
                    ctx.save()
                    path.rect(32, 32, 64, 64)
                    ctx.clip(path)
                    ctx.globalAlpha = 0.5
                    ctx.drawImage(source, 24, 24)
                    ctx.drawImage(source, 64, 64)
                    ctx.restore()
                    ctx.fillStyle = '#c040f0'
                    ctx.fillRect(40, 48, 32, 32)
                    ctx.drawImage(source, 80, 88)
                    ctx.globalAlpha = 0.25
                    ctx.drawImage(source, 104, 104)
                },
            },
            {
                name: 'transformed clear preserves pixels outside its bounds',
                draw(ctx) {
                    ctx.fillStyle = '#40c080'
                    ctx.fillRect(0, 0, size, size)
                    ctx.setTransform(2, 0, 0, 2, 8, 16)
                    ctx.clearRect(12, 12, 32, 24)
                    ctx.resetTransform()
                    ctx.fillStyle = '#c060e0'
                    ctx.fillRect(144, 144, 8, 8)
                },
            },
        ]
        const results: {
            name: string
            max: number
            maxAlpha: number
            differences: number
            first: number[][]
            nativeGeometry: {
                coverageChange: number
                centroidDelta: number
                beyondEdge: number
                firstEdge: number[][]
            }
            edgeAntialias: boolean
        }[] = []
        const images: { name: string; data: string }[] = []
        for (const { name, draw, edgeAntialias = false } of cases) {
            const pixels: Uint8ClampedArray[] = []
            for (const backend of ['native', 'webgl']) {
                const canvas = document.createElement('canvas')
                canvas.width = canvas.height = size
                const actual =
                    backend === 'native' ? canvas.getContext('2d')! : getDrawContext(canvas)
                await ('ready' in actual ? actual.ready : undefined)
                const path = backend === 'native' ? new Path2D() : new DrawPath()
                draw(actual as unknown as CanvasRenderingContext2D, path as Path2D)
                pixels.push(actual.getImageData(0, 0, size, size).data)
                if (path instanceof DrawPath) path.dispose()
                if (backend !== 'native') disposeDrawContext(canvas)
            }
            if (name.includes('full-circle')) {
                const comparison = document.createElement('canvas')
                comparison.width = size * 2
                comparison.height = size
                const comparisonContext = comparison.getContext('2d')!
                pixels.forEach((data, index) => {
                    const image = comparisonContext.createImageData(size, size)
                    image.data.set(data)
                    comparisonContext.putImageData(image, size * index, 0)
                })
                images.push({ name, data: comparison.toDataURL().split(',')[1]! })
            }
            const reference = pixels[0]!
            const actual = pixels[1]!
            let max = 0
            let maxAlpha = 0
            let differences = 0
            const first: number[][] = []
            for (let index = 0; index < actual.length; index++) {
                const alpha = (index & ~3) + 3
                if (index % 4 === 3) maxAlpha = Math.max(maxAlpha, actual[index]!)
                const a = index % 4 === 3 ? actual[index]! : (actual[index]! * actual[alpha]!) / 255
                const b =
                    index % 4 === 3
                        ? reference[index]!
                        : (reference[index]! * reference[alpha]!) / 255
                const error = Math.abs(a - b)
                max = Math.max(max, error)
                if (error > 2) {
                    differences++
                    if (first.length < 8) first.push([index, a, b])
                }
            }
            const coverage = (data: Uint8ClampedArray) => {
                let sum = 0
                let xSum = 0
                let ySum = 0
                for (let y = 0; y < size; y++) {
                    for (let x = 0; x < size; x++) {
                        const alpha = data[(y * size + x) * 4 + 3]!
                        sum += alpha
                        xSum += x * alpha
                        ySum += y * alpha
                    }
                }
                return { sum, x: xSum / sum, y: ySum / sum }
            }
            const nativeCoverage = coverage(reference)
            const gpuCoverage = coverage(actual)
            let beyondEdge = 0
            const firstEdge: number[][] = []
            for (const [left, right] of [
                [reference, actual],
                [actual, reference],
            ] as const) {
                for (let y = 1; y < size - 1; y++) {
                    for (let x = 1; x < size - 1; x++) {
                        let low = 255
                        let high = 0
                        for (let dy = -1; dy <= 1; dy++) {
                            for (let dx = -1; dx <= 1; dx++) {
                                const alpha = right[((y + dy) * size + x + dx) * 4 + 3]!
                                low = Math.min(low, alpha)
                                high = Math.max(high, alpha)
                            }
                        }
                        const alpha = left[(y * size + x) * 4 + 3]!
                        // Browser and WebGL rasterizers resolve fractional edge
                        // coverage differently. Solid interiors and pixels more
                        // than one pixel outside either silhouette must agree.
                        // Three alpha levels also exclude effectively transparent
                        // native fringe pixels (for example alpha 3 versus 0).
                        if (high - low <= 3) {
                            const offset = (y * size + x) * 4
                            const otherAlpha = right[offset + 3]!
                            let interiorError = Math.abs(alpha - otherAlpha)
                            for (let channel = 0; channel < 3; channel++) {
                                interiorError = Math.max(
                                    interiorError,
                                    Math.abs(
                                        (left[offset + channel]! * alpha) / 255 -
                                            (right[offset + channel]! * otherAlpha) / 255,
                                    ),
                                )
                            }
                            if (interiorError > 3) {
                                beyondEdge++
                                if (firstEdge.length < 4)
                                    firstEdge.push([x, y, alpha, low, high, interiorError])
                            }
                        }
                    }
                }
            }
            results.push({
                name,
                max,
                maxAlpha,
                differences,
                first,
                nativeGeometry: {
                    coverageChange: gpuCoverage.sum / nativeCoverage.sum - 1,
                    centroidDelta: Math.hypot(
                        gpuCoverage.x - nativeCoverage.x,
                        gpuCoverage.y - nativeCoverage.y,
                    ),
                    beyondEdge,
                    firstEdge,
                },
                edgeAntialias,
            })
        }
        return { results, images }
    })
    for (const { name, data } of images) {
        await testInfo.attach(name, { body: Buffer.from(data, 'base64'), contentType: 'image/png' })
    }
    await testInfo.attach('primitive-pixels', {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json',
    })
    for (const result of results) {
        const message = JSON.stringify(result)
        if (result.name === 'fractional axis-scaled round lines with dashes') {
            // These separated capsules are painted once. Degenerate cap ears
            // must not add coverage after GPU vertex/subpixel quantization.
            expect.soft(result.maxAlpha, message).toBeLessThanOrEqual(Math.ceil(0.75 * 255))
        }
        if (result.edgeAntialias) {
            // Preserve the silhouette and solid interiors, and bound edge color
            // and integrated coverage changes. Centroids are diagnostic only:
            // different AA weights on separated lines can move the aggregate
            // centroid without changing any line's position or dash geometry.
            expect.soft(result.nativeGeometry.beyondEdge, message).toBe(0)
            expect.soft(result.max, message).toBeLessThanOrEqual(96)
            expect.soft(Math.abs(result.nativeGeometry.coverageChange), message).toBeLessThan(0.03)
        } else expect.soft(result.differences, message).toBe(0)
    }
})

test('gradient transforms and reused gradients match native Canvas after scrolling', async ({
    page,
}, testInfo) => {
    const results = await page.evaluate(async () => {
        const { getDrawContext, disposeDrawContext } = await import('/src/rendering/context.ts')
        const size = 160
        const results: { name: string; max: number; differences: number; probes: number[][] }[] = []
        for (const name of [
            'creation transform',
            'cached pan',
            'cached scale',
            'transparent stops',
            'current path transform',
        ]) {
            const pixels: Uint8ClampedArray[] = []
            for (const backend of ['native', 'webgl']) {
                const canvas = document.createElement('canvas')
                canvas.width = canvas.height = size
                const actual =
                    backend === 'native' ? canvas.getContext('2d')! : getDrawContext(canvas)
                await ('ready' in actual ? actual.ready : undefined)
                // Both backends deliberately receive the same supported drawing
                // vocabulary; native Canvas supplies an independent raster oracle.
                const ctx = actual as unknown as CanvasRenderingContext2D
                ctx.setTransform(1.5, 0, 0, 0.75, 16, 8)
                const gradient = ctx.createLinearGradient(0, 0, 96, 0)
                gradient.addColorStop(
                    0,
                    name === 'transparent stops' ? 'rgba(255,0,0,0)' : '#ff0000',
                )
                gradient.addColorStop(
                    0.5,
                    name === 'transparent stops' ? 'rgba(0,255,0,0.5)' : '#00ff00',
                )
                gradient.addColorStop(1, '#0000ff')
                ctx.fillStyle = gradient
                ctx.setTransform(1, 0, 0, 1, 0, 0)
                if (name === 'current path transform') {
                    ctx.setTransform(2, 0, 0, 2, 16, 0)
                    ctx.beginPath()
                    ctx.rect(0, 0, 64, 16)
                    ctx.resetTransform()
                    ctx.fill()
                } else ctx.fillRect(0, 0, 150, 32)
                if (name === 'cached pan') ctx.translate(24, 40)
                else if (name === 'cached scale') ctx.setTransform(0.75, 0, 0, 1, 24, 40)
                else ctx.translate(0, 40)
                ctx.fillRect(0, 0, 128, 32)
                pixels.push(actual.getImageData(0, 0, size, size).data)
                if (backend === 'webgl') disposeDrawContext(canvas)
            }
            const reference = pixels[0]!
            const actual = pixels[1]!
            let max = 0
            let differences = 0
            for (let index = 0; index < actual.length; index++) {
                const alpha = (index & ~3) + 3
                const a = index % 4 === 3 ? actual[index]! : (actual[index]! * actual[alpha]!) / 255
                const b =
                    index % 4 === 3
                        ? reference[index]!
                        : (reference[index]! * reference[alpha]!) / 255
                const error = Math.abs(a - b)
                max = Math.max(max, error)
                if (error > 2) differences++
            }
            results.push({
                name,
                max,
                differences,
                probes: [16, 48, 80, 112].map((x) => {
                    const offset = (50 * size + x) * 4
                    return [
                        ...reference.slice(offset, offset + 4),
                        ...actual.slice(offset, offset + 4),
                    ]
                }),
            })
        }
        return results
    })
    await testInfo.attach('gradient-pixels', {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json',
    })
    for (const result of results) expect(result.differences, JSON.stringify(result)).toBe(0)
})

test('opacity layers apply inherited fractional clips once', async ({ page }, testInfo) => {
    const results = await page.evaluate(async () => {
        const { getDrawContext, disposeDrawContext } = await import('/src/rendering/context.ts')
        const size = 96
        const outerClip = (ctx: CanvasRenderingContext2D) => {
            ctx.beginPath()
            ctx.moveTo(8.25, 8.5)
            ctx.lineTo(88.5, 24.25)
            ctx.lineTo(64.75, 88.5)
            ctx.lineTo(12.5, 72.25)
            ctx.closePath()
            ctx.clip()
        }
        const innerClip = (ctx: CanvasRenderingContext2D) => {
            ctx.beginPath()
            ctx.rect(24, 16, 48, 64)
            ctx.clip()
        }
        const compare = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
            let max = 0
            let differences = 0
            let coverageA = 0
            let coverageB = 0
            for (let i = 0; i < a.length; i++) {
                const alpha = (i & ~3) + 3
                const left = i % 4 === 3 ? a[i]! : (a[i]! * a[alpha]!) / 255
                const right = i % 4 === 3 ? b[i]! : (b[i]! * b[alpha]!) / 255
                const error = Math.abs(left - right)
                max = Math.max(max, error)
                if (error > 2) differences++
                if (i % 4 === 3) {
                    coverageA += a[i]!
                    coverageB += b[i]!
                }
            }
            let interiorDifferences = 0
            for (const [left, right] of [
                [a, b],
                [b, a],
            ] as const) {
                for (let y = 1; y < size - 1; y++)
                    for (let x = 1; x < size - 1; x++) {
                        let low = 255
                        let high = 0
                        for (let dy = -1; dy <= 1; dy++)
                            for (let dx = -1; dx <= 1; dx++) {
                                const alpha = right[((y + dy) * size + x + dx) * 4 + 3]!
                                low = Math.min(low, alpha)
                                high = Math.max(high, alpha)
                            }
                        if (high - low > 3) continue
                        const offset = (y * size + x) * 4
                        for (let channel = 0; channel < 4; channel++) {
                            const l =
                                channel === 3
                                    ? left[offset + 3]!
                                    : (left[offset + channel]! * left[offset + 3]!) / 255
                            const r =
                                channel === 3
                                    ? right[offset + 3]!
                                    : (right[offset + channel]! * right[offset + 3]!) / 255
                            if (Math.abs(l - r) > 3) interiorDifferences++
                        }
                    }
            }
            return {
                max,
                differences,
                interiorDifferences,
                coverageChange: coverageA / coverageB - 1,
            }
        }
        const results = []
        for (const nested of [false, true]) {
            const pixels: Uint8ClampedArray[] = []
            for (const backend of ['native', 'webgl-layer', 'webgl-flat']) {
                const canvas = document.createElement('canvas')
                canvas.width = canvas.height = size
                const actual =
                    backend === 'native' ? canvas.getContext('2d')! : getDrawContext(canvas)
                await ('ready' in actual ? actual.ready : undefined)
                const ctx = actual as unknown as CanvasRenderingContext2D
                outerClip(ctx)
                if (backend === 'native') {
                    const group = document.createElement('canvas')
                    group.width = group.height = size
                    const groupContext = group.getContext('2d')!
                    if (nested) innerClip(groupContext)
                    groupContext.fillStyle = '#00b060'
                    groupContext.fillRect(0, 0, size, size)
                    ctx.globalAlpha = 0.5
                    ctx.drawImage(group, 0, 0)
                } else if (backend === 'webgl-layer') {
                    getDrawContext(canvas).saveLayer(0.5, 0, 0, size, size)
                    if (nested) innerClip(ctx)
                    ctx.fillStyle = '#00b060'
                    ctx.fillRect(0, 0, size, size)
                    ctx.restore()
                } else {
                    if (nested) innerClip(ctx)
                    ctx.globalAlpha = 0.5
                    ctx.fillStyle = '#00b060'
                    ctx.fillRect(0, 0, size, size)
                }
                pixels.push(actual.getImageData(0, 0, size, size).data)
                if (backend !== 'native') disposeDrawContext(canvas)
            }
            results.push({
                nested,
                native: compare(pixels[1]!, pixels[0]!),
                flat: compare(pixels[1]!, pixels[2]!),
                nativeFlat: compare(pixels[2]!, pixels[0]!),
            })
        }
        return results
    })
    await testInfo.attach('layer-clipping', {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json',
    })
    for (const result of results) {
        expect.soft(result.flat.differences, JSON.stringify(result)).toBe(0)
        // The layer must match the same renderer's direct opacity exactly.
        // Native diagonal clip coverage differs only at its one-pixel AA edge;
        // preserve exact interiors and bound that independently measured edge.
        expect.soft(result.native.interiorDifferences, JSON.stringify(result)).toBe(0)
        expect.soft(result.native.max, JSON.stringify(result)).toBeLessThanOrEqual(32)
        expect
            .soft(Math.abs(result.native.coverageChange), JSON.stringify(result))
            .toBeLessThan(0.02)
    }
})

test('two-stop alpha ramps preserve color and opacity after reuse and clipping', async ({
    page,
}, testInfo) => {
    const results = await page.evaluate(async () => {
        const { getDrawContext, disposeDrawContext } = await import('/src/rendering/context.ts')
        const size = 160
        const results = []
        for (const name of ['vertical fade', 'horizontal partial alpha', 'reversed fade']) {
            const pixels: Uint8ClampedArray[] = []
            for (const backend of ['native', 'webgl']) {
                const canvas = document.createElement('canvas')
                canvas.width = canvas.height = size
                const actual =
                    backend === 'native' ? canvas.getContext('2d')! : getDrawContext(canvas)
                await ('ready' in actual ? actual.ready : undefined)
                const ctx = actual as unknown as CanvasRenderingContext2D
                ctx.fillStyle = '#203060'
                ctx.fillRect(0, 0, size, size)
                const gradient =
                    name === 'horizontal partial alpha'
                        ? ctx.createLinearGradient(0, 0, 64, 0)
                        : name === 'reversed fade'
                          ? ctx.createLinearGradient(0, 64, 0, 0)
                          : ctx.createLinearGradient(0, 0, 0, 64)
                gradient.addColorStop(
                    0,
                    name === 'horizontal partial alpha'
                        ? 'rgba(64,192,128,0.25)'
                        : 'rgba(64,192,128,0)',
                )
                gradient.addColorStop(
                    1,
                    name === 'horizontal partial alpha'
                        ? 'rgba(64,192,128,0.75)'
                        : 'rgba(64,192,128,1)',
                )
                ctx.fillStyle = gradient
                ctx.fillRect(8, 8, 56, 56)
                ctx.save()
                ctx.beginPath()
                ctx.rect(80, 16, 56, 48)
                ctx.clip()
                ctx.translate(80, 16)
                ctx.globalAlpha = 0.5
                ctx.fillRect(0, 0, 64, 64)
                ctx.restore()
                ctx.setTransform(1.25, 0, 0, 0.5, 16, 104)
                ctx.fillRect(0, 0, 96, 64)
                pixels.push(actual.getImageData(0, 0, size, size).data)
                if (backend === 'webgl') disposeDrawContext(canvas)
            }
            let max = 0
            let differences = 0
            const first: number[][] = []
            for (let i = 0; i < pixels[0]!.length; i++) {
                const error = Math.abs(pixels[0]![i]! - pixels[1]![i]!)
                max = Math.max(max, error)
                if (error > 2) {
                    differences++
                    if (first.length < 8) first.push([i, pixels[0]![i]!, pixels[1]![i]!])
                }
            }
            results.push({ name, max, differences, first })
        }
        return results
    })
    await testInfo.attach('two-stop-gradient-pixels', {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json',
    })
    for (const result of results) expect.soft(result.differences, JSON.stringify(result)).toBe(0)
})

test('event circle markers preserve their device-space silhouette', async ({ page }, testInfo) => {
    const { results, comparisons } = await page.evaluate(async () => {
        const { getDrawContext, disposeDrawContext } = await import('/src/rendering/context.ts')
        const results = []
        const comparisons = []
        for (const pixelRatio of [1, 2, 3]) {
            const size = 64 * pixelRatio
            const comparison = document.createElement('canvas')
            comparison.width = size * 2
            comparison.height = size * 3
            const comparisonContext = comparison.getContext('2d')!
            comparisonContext.fillStyle = '#222'
            comparisonContext.fillRect(0, 0, comparison.width, comparison.height)
            for (const [row, scale] of [30, 50, 62.5].entries()) {
                const pixels: Uint8ClampedArray[] = []
                for (const [column, backend] of ['native', 'webgl'].entries()) {
                    const canvas = document.createElement('canvas')
                    canvas.width = canvas.height = size
                    const actual =
                        backend === 'native' ? canvas.getContext('2d')! : getDrawContext(canvas)
                    await ('ready' in actual ? actual.ready : undefined)
                    const ctx = actual as unknown as CanvasRenderingContext2D
                    ctx.setTransform(
                        scale * pixelRatio,
                        0,
                        0,
                        scale * pixelRatio,
                        32.25 * pixelRatio,
                        32.5 * pixelRatio,
                    )
                    ctx.fillStyle = '#00ffff'
                    ctx.strokeStyle = '#ffffff'
                    ctx.lineWidth = 2 / scale
                    ctx.beginPath()
                    ctx.arc(0, 0, 0.1, 0, Math.PI * 2)
                    ctx.fill()
                    ctx.stroke()
                    const data = actual.getImageData(0, 0, size, size).data
                    pixels.push(data)
                    const raster = document.createElement('canvas')
                    raster.width = raster.height = size
                    raster
                        .getContext('2d')!
                        .putImageData(new ImageData(new Uint8ClampedArray(data), size, size), 0, 0)
                    comparisonContext.drawImage(raster, column * size, row * size)
                    if (backend === 'webgl') disposeDrawContext(canvas)
                }
                const contour = (data: Uint8ClampedArray) => {
                    const points: [number, number][] = []
                    let coverage = 0
                    for (let y = 1; y < size - 1; y++)
                        for (let x = 1; x < size - 1; x++) {
                            const alpha = data[(y * size + x) * 4 + 3]!
                            coverage += alpha
                            if (alpha < 128) continue
                            if (
                                [
                                    [-1, 0],
                                    [1, 0],
                                    [0, -1],
                                    [0, 1],
                                ].some(
                                    ([dx, dy]) => data[((y + dy!) * size + x + dx!) * 4 + 3]! < 128,
                                )
                            )
                                points.push([x, y])
                        }
                    return { points, coverage }
                }
                const native = contour(pixels[0]!)
                const gpu = contour(pixels[1]!)
                let boundaryError = 0
                for (const [left, right] of [
                    [native.points, gpu.points],
                    [gpu.points, native.points],
                ]) {
                    for (const [x, y] of left!) {
                        boundaryError = Math.max(
                            boundaryError,
                            Math.min(...right!.map(([a, b]) => Math.hypot(x - a, y - b))),
                        )
                    }
                }
                results.push({
                    pixelRatio,
                    scale,
                    boundaryError,
                    cssBoundaryError: boundaryError / pixelRatio,
                    coverageChange: gpu.coverage / native.coverage - 1,
                    visible: gpu.points.length,
                })
            }
            comparisons.push({ pixelRatio, image: comparison.toDataURL().split(',')[1]! })
        }
        return { results, comparisons }
    })
    for (const { pixelRatio, image } of comparisons)
        await testInfo.attach(`event-markers-dpr-${pixelRatio}`, {
            body: Buffer.from(image, 'base64'),
            contentType: 'image/png',
        })
    await testInfo.attach('event-marker-boundaries', {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json',
    })
    for (const result of results) {
        expect.soft(result.visible, JSON.stringify(result)).toBeGreaterThan(0)
        expect.soft(result.boundaryError, JSON.stringify(result)).toBeLessThanOrEqual(1)
    }
})

test('coincident event lines retain native edge contrast as their strokes accumulate', async ({
    page,
}, testInfo) => {
    const results = await page.evaluate(async () => {
        const { getDrawContext, disposeDrawContext } = await import('/src/rendering/context.ts')
        const create = () => {
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 160
            return canvas
        }
        const canvas = create()
        const gpu = getDrawContext(canvas)
        await ('ready' in gpu ? gpu.ready : undefined)
        const results = []
        for (const axis of ['horizontal', 'vertical']) {
            for (const phase of [0, 0.25, 0.5, 0.75]) {
                for (const count of [1, 2, 8]) {
                    for (const alpha of [1, 0.5]) {
                        // Native readback can switch a reused Canvas to software
                        // rasterization, so every reference starts fresh.
                        const native = create().getContext('2d')!
                        const samples: number[][] = []
                        for (const context of [native, gpu]) {
                            const ctx = context as unknown as CanvasRenderingContext2D
                            ctx.resetTransform()
                            ctx.clearRect(0, 0, 160, 160)
                            ctx.globalAlpha = 1
                            ctx.fillStyle = '#404464'
                            ctx.fillRect(0, 0, 160, 160)
                            ctx.strokeStyle = '#00ffff'
                            ctx.lineWidth = 2
                            ctx.lineCap = 'butt'
                            ctx.setLineDash([])
                            ctx.globalAlpha = alpha
                            for (let index = 0; index < count; index++) {
                                const x0 = axis === 'horizontal' ? -16 : 64 + phase
                                const y0 = axis === 'horizontal' ? 64 + phase : -16
                                const x1 = axis === 'horizontal' ? 176 : 64 + phase
                                const y1 = axis === 'horizontal' ? 64 + phase : 176
                                if (
                                    'strokeLine' in context &&
                                    typeof context.strokeLine === 'function'
                                ) {
                                    // Exercise the same primitive as event lines.
                                    context.strokeLine(x0, y0, x1, y1)
                                } else {
                                    ctx.beginPath()
                                    ctx.moveTo(x0, y0)
                                    ctx.lineTo(x1, y1)
                                    ctx.stroke()
                                }
                            }
                            // These are real edge colors, not a silhouette-only
                            // oracle: fixed MSAA masks can preserve geometry while
                            // losing a third of a repeated cyan line's contrast.
                            samples.push([
                                ...context.getImageData(
                                    axis === 'horizontal' ? 80 : 61,
                                    axis === 'horizontal' ? 61 : 80,
                                    axis === 'horizontal' ? 1 : 7,
                                    axis === 'horizontal' ? 7 : 1,
                                ).data,
                            ])
                        }
                        const max = Math.max(
                            ...samples[0]!.map((value, index) =>
                                Math.abs(value - samples[1]![index]!),
                            ),
                        )
                        results.push({ axis, phase, count, alpha, max, samples })
                    }
                }
            }
        }
        disposeDrawContext(canvas)
        return results
    })
    await testInfo.attach('coincident-line-contrast', {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json',
    })
    for (const result of results)
        expect.soft(result.max, JSON.stringify(result)).toBeLessThanOrEqual(2)
})
