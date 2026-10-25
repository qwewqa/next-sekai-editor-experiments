import { expect, test } from '@playwright/test'

// The preview's selection outline has a renderer of its own, which both preview hosts use. It
// must draw what the editor's stroked path of the same segments draws.
test.beforeEach(async ({ page }) => {
    await page.route('**/__preview-outline-test', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
    )
    await page.goto('/__preview-outline-test')
})

test('the outline renderer draws what a stroked path draws at each device scale', async ({
    page,
}) => {
    const results = await page.evaluate(async () => {
        const { disposeDrawContext, getDrawContext } = await import('/src/rendering/context.ts')
        const { createOutlineRenderer } = await import('/src/preview/outlineRenderer.ts')
        // The editor's paths are tessellated by Lyon once it loads, which is at once.
        const { initializeLyon } = await import('/src/rendering/lyon.ts')
        await initializeLyon()
        // Outline shapes in CSS pixels, as the preview draws them: a slanted note,
        // a curved connector cut into slices, a lone line, a hairpin and an empty edge.
        const segments: number[] = []
        const edge = (ax: number, ay: number, bx: number, by: number) =>
            segments.push(ax, ay, bx, by)
        const note: [number, number][] = [
            [20, 40],
            [90, 36.5],
            [94.25, 52],
            [24, 57.75],
        ]
        note.forEach(([x, y], i) => {
            const [nx, ny] = note[(i + 1) % 4]!
            edge(x, y, nx, ny)
        })
        const side = (x: number, y: number) => x + 18 * Math.sin(y / 23)
        for (let y = 70; y < 210; y += 7) {
            edge(side(110, y), y, side(110, y + 7), y + 7)
            edge(side(150, y), y, side(150, y + 7), y + 7)
        }
        edge(side(110, 70), 70, side(150, 70), 70)
        edge(side(110, 210), 210, side(150, 210), 210)
        edge(210, 30, 300, 30.4)
        edge(220, 80, 290, 150)
        edge(290, 150, 224, 86)
        edge(250, 200, 250, 200)
        // Both drawing buffers, premultiplied, as WebGL holds them.
        const read = (canvas: HTMLCanvasElement) => {
            const gl = canvas.getContext('webgl2')!
            const data = new Uint8Array(canvas.width * canvas.height * 4)
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
            return data
        }
        const results = []
        for (const [label, sx, sy] of [
            ['1x', 1, 1],
            ['1.25x', 1.25, 1.25],
            ['2x', 2, 2],
            ['3x', 3, 3],
            ['stretched while resizing', 2.5, 1.75],
        ] as const) {
            const width = Math.round(320 * sx)
            const height = Math.round(240 * sy)
            const path = document.createElement('canvas')
            path.width = width
            path.height = height
            const ctx = getDrawContext(path)
            await ctx.ready
            ctx.setTransform(sx, 0, 0, sy, 0, 0)
            ctx.lineCap = 'round'
            ctx.lineJoin = 'round'
            for (const [color, lineWidth] of [
                ['#06151d', 5],
                ['#67e8f9', 2],
            ] as const) {
                ctx.strokeStyle = color
                ctx.lineWidth = lineWidth
                ctx.beginPath()
                for (let i = 0; i < segments.length; i += 4) {
                    ctx.moveTo(segments[i]!, segments[i + 1]!)
                    ctx.lineTo(segments[i + 2]!, segments[i + 3]!)
                }
                ctx.stroke()
            }
            ctx.flush()
            const expected = read(path)
            disposeDrawContext(path)
            const outline = document.createElement('canvas')
            const renderer = createOutlineRenderer(outline, (error) => {
                throw error
            })
            renderer.draw(segments, width, height, sx, sy)
            const actual = read(outline)
            renderer.dispose()
            const at = (data: Uint8Array, x: number, y: number, c: number) =>
                data[(y * width + x) * 4 + c]!
            let coverage = 0
            let expectedCoverage = 0
            let interiorDifferences = 0
            let maxDifference = 0
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) {
                    coverage += at(actual, x, y, 3)
                    expectedCoverage += at(expected, x, y, 3)
                    let difference = 0
                    for (let c = 0; c < 4; c++)
                        difference = Math.max(
                            difference,
                            Math.abs(at(expected, x, y, c) - at(actual, x, y, c)),
                        )
                    if (!difference) continue
                    maxDifference = Math.max(maxDifference, difference)
                    // An edge pixel has a neighbour of another colour in the stroked path.
                    let edge = false
                    for (let dy = -1; dy <= 1 && !edge; dy++)
                        for (let dx = -1; dx <= 1 && !edge; dx++) {
                            const nx = Math.min(width - 1, Math.max(0, x + dx))
                            const ny = Math.min(height - 1, Math.max(0, y + dy))
                            for (let c = 0; c < 4; c++)
                                if (at(expected, nx, ny, c) !== at(expected, x, y, c)) edge = true
                        }
                    if (!edge) interiorDifferences++
                }
            results.push({
                label,
                expectedCoverage,
                coverage,
                interiorDifferences,
                maxDifference,
            })
        }
        return results
    })
    for (const result of results) {
        expect(result.expectedCoverage, result.label).toBeGreaterThan(255 * 3000)
        // The segments' bodies are exact; the path's union moves slanted edges by
        // a few hundredths of a pixel, which turns one or two of 4 MSAA samples
        // at some edge pixels. Interiors, colours, order and thickness match.
        expect(result.interiorDifferences, result.label).toBe(0)
        expect(result.maxDifference, result.label).toBeLessThanOrEqual(128)
        expect(Math.abs(result.coverage / result.expectedCoverage - 1), result.label).toBeLessThan(
            0.02,
        )
    }
})
