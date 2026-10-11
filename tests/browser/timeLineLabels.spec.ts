import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, useTool } from './editorFixture'

// The hover and cursor lines stop a label inset short of the time and beat labels they meet,
// and the hover labels' figures are centred on the line.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const setup = (page: Page, layout: 'basic' | 'composed', width: number) =>
    page.evaluate(
        ({ layout, width }) => {
            const { fixtures, show, settings, view } = window.editorTest
            settings.width = width
            settings.pps = 80
            show(
                {
                    ...fixtures.events,
                    bpms: [{ beat: 0, bpm: 120 }],
                    cameraEvents: [],
                    timeScales: [],
                    slides: [],
                },
                5,
            )
            view.layout = layout
            // Grid lines a beat apart, clear of the lines checked between them.
            view.division = 1
            for (const type of Object.keys(view.visibilities))
                view.visibilities[type as keyof typeof view.visibilities] = false
        },
        { layout, width },
    )

type Line = 'hover' | 'cursor'

// A line's pixel row, and the visible labels it meets, in CSS pixels across the pane.
const lineRow = (page: Page, line: Line, at?: number) =>
    page.evaluate(
        async ({ line, at }) => {
            const { view, settings } = window.editorTest
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            )
            const canvas = document.querySelector<HTMLCanvasElement>(
                line === 'hover' ? 'canvas.editor-overlay' : 'canvas.editor-chart',
            )!
            const pane = canvas.getBoundingClientRect()
            const time = at ?? (line === 'hover' ? view.hoverTime : view.cursorTime)
            const y = 0.5 * view.h - (time - view.time) * settings.pps
            const ratio = canvas.width / canvas.clientWidth
            const data = canvas
                .getContext('2d')!
                .getImageData(0, Math.floor(y * ratio), canvas.width, 1).data
            const alphas = Array.from({ length: canvas.width }, (_, x) => data[x * 4 + 3]!)
            const colors = Array.from({ length: canvas.width }, (_, x) =>
                data.slice(x * 4, x * 4 + 4).join(),
            )
            const labels = [
                ...document.querySelectorAll<HTMLElement>(
                    '.chart-pane > div:first-of-type > div > span, .chart-pane > div:nth-of-type(2) > span',
                ),
            ].filter((span) => span.checkVisibility({ visibilityProperty: true }))
            const met = labels.flatMap((span) => {
                const rect = span.getBoundingClientRect()
                return rect.top - pane.top <= y && y <= rect.bottom - pane.top
                    ? [{ left: rect.left - pane.left, right: rect.right - pane.left }]
                    : []
            })
            const middle = pane.width / 2
            return {
                ratio,
                alphas,
                colors,
                inset: parseFloat(getComputedStyle(labels[0]!).paddingLeft),
                left: Math.max(...met.filter((box) => box.left < middle).map((box) => box.right)),
                right: Math.min(...met.filter((box) => box.left > middle).map((box) => box.left)),
                width: pane.width,
            }
        },
        { line, at },
    )

const expectGaps = (page: Page, line: Line) =>
    // Polled: a label's new width reaches the line a frame after it lays out.
    expect
        .poll(async () => {
            const { ratio, alphas, inset, left, right, width } = await lineRow(page, line)
            const lit = (from: number, to: number) =>
                alphas
                    .slice(Math.round(from * ratio), Math.round(to * ratio))
                    .some((alpha) => alpha > 0)
            return {
                meets: left > 0 && right < width,
                // Clear over each label and the inset beside it, to within a device pixel.
                overLeft: lit(0, left + inset - 1 / ratio),
                overRight: lit(right - inset + 1 / ratio, width),
                // Drawn right after each stop, where the hover line's dashes start.
                afterLeft: lit(left + inset, left + inset + 5),
                beforeRight: lit(right - inset - 5, right - inset),
            }
        })
        .toEqual({
            meets: true,
            overLeft: false,
            overRight: false,
            afterLeft: true,
            beforeRight: true,
        })

// Pane x of lanes in Basic.
const lanesAt = (page: Page, lanes: number[]) =>
    page.evaluate((lanes) => {
        const { view, settings } = window.editorTest
        return lanes.map((lane) => view.w * (0.5 + (lane - view.lane) / settings.width))
    }, lanes)

// The first and last lit pixels of a row, in CSS pixels.
const litRange = ({ alphas, ratio }: { alphas: number[]; ratio: number }) => {
    const lit = alphas.flatMap((alpha, x) => (alpha > 0 ? [x] : []))
    return { min: Math.min(...lit) / ratio, max: (Math.max(...lit) + 1) / ratio }
}

// The cursor line's lit span: the pixels of its row that change when it moves away.
const cursorLine = async (page: Page) => {
    const on = await lineRow(page, 'cursor')
    const time = await page.evaluate(() => {
        const { view } = window.editorTest
        const time = view.cursorTime
        view.cursorTime = 0
        return time
    })
    const off = await lineRow(page, 'cursor', time)
    await page.evaluate((time) => (window.editorTest.view.cursorTime = time), time)
    return litRange({
        ratio: on.ratio,
        alphas: on.colors.map((color, x) => (color !== off.colors[x] ? 1 : 0)),
    })
}

// The hover line's dashes between its stops, in CSS pixels.
const dashes = async (page: Page) => {
    const { ratio, alphas, inset, left, right } = await lineRow(page, 'hover')
    const runs: [number, number][] = []
    alphas.forEach((alpha, x) => {
        const last = runs.at(-1)
        if (alpha < 64) return
        if (last && last[1] === x / ratio) last[1] = (x + 1) / ratio
        else runs.push([x / ratio, (x + 1) / ratio])
    })
    return { runs, from: left + inset, to: right - inset }
}

// Between beats, so off the grid lines.
const hoverAt = async (page: Page, beat: number) => {
    const { x, y } = await page.evaluate((beat) => window.editorTest.point(0, beat), beat)
    await page.mouse.move(x + 3, y)
}

for (const deviceScaleFactor of [1, 2]) {
    test.describe(`at ${deviceScaleFactor}x`, () => {
        test.use({ deviceScaleFactor })

        test('Composed: the hover line stops short of its labels', async ({ page }) => {
            await setup(page, 'composed', 24)
            await useTool(page, 'select')
            await hoverAt(page, 10.5)
            await expectGaps(page, 'hover')
            // Longer labels push the stops in.
            await page.evaluate(() => {
                window.editorTest.settings.beatDisplay = 'both'
                window.editorTest.view.time = 754
            })
            await hoverAt(page, 1508.5)
            await expectGaps(page, 'hover')
        })

        test('Composed: the cursor line stops short of the labels it meets', async ({ page }) => {
            await setup(page, 'composed', 24)
            await useTool(page, 'select')
            // Through the hover labels.
            await hoverAt(page, 10.5)
            await page.evaluate(() => {
                const { view } = window.editorTest
                view.cursorTime = view.hoverTime + 0.05
            })
            await expectGaps(page, 'cursor')
            // Between beats, through the labels at the top.
            await page.mouse.move(0, 0)
            await page.evaluate(() => {
                const { view, settings } = window.editorTest
                settings.beatDisplay = 'both'
                view.cursorTime = 754.25
                view.time = view.cursorTime - (view.h / 2 - 12) / settings.pps
            })
            await expectGaps(page, 'cursor')
        })

        test('Basic in a narrow pane: the hover line stops short of its labels', async ({
            page,
        }) => {
            await page.setViewportSize({ width: 390, height: 844 })
            await setup(page, 'basic', 16)
            await useTool(page, 'select')
            await hoverAt(page, 10.5)
            await expectGaps(page, 'hover')
        })

        test('Basic at the default zoom: the cursor line stops short of long beat labels', async ({
            page,
        }) => {
            await setup(page, 'basic', 16)
            await useTool(page, 'select')
            await page.evaluate(() => {
                const { settings, view } = window.editorTest
                settings.beatDisplay = 'both'
                // Grid labels, a beat apart, are clear of the line between them.
                settings.pps = 400
                view.time = 754
            })
            await hoverAt(page, 1508.5)
            // Through the hover labels, off the grid labels.
            await page.evaluate(() => {
                const { view } = window.editorTest
                view.cursorTime = view.hoverTime - 0.01
            })
            const [left, right] = await lanesAt(page, [-7, 7])
            await expect
                .poll(async () => {
                    const row = await lineRow(page, 'cursor')
                    const lit = await cursorLine(page)
                    return {
                        // The long beat label reaches inside lane 7; the time label doesn't reach lane -7.
                        cut: row.right - row.inset < right! && row.left + row.inset < left!,
                        left: Math.abs(lit.min - left!) <= 1,
                        right: Math.abs(lit.max - (row.right - row.inset)) <= 1 / row.ratio,
                    }
                })
                .toEqual({ cut: true, left: true, right: true })
        })

        test('the hover line dashes start at both stops', async ({ page }) => {
            await setup(page, 'composed', 24)
            await useTool(page, 'select')
            await hoverAt(page, 10.5)
            await expectGaps(page, 'hover')
            const first = await dashes(page)
            expect(first.runs[0]![0]).toBeCloseTo(first.from, 0)
            expect(first.runs.at(-1)![1]).toBeCloseTo(first.to, 0)
            // Dashes 6 and gaps 4 apart, but for one middle dash up to two dashes long.
            const odd = first.runs.filter(([from, to]) => Math.abs(to - from - 6) > 1)
            expect(odd.length).toBeLessThanOrEqual(1)
            for (const [from, to] of odd) expect(to - from).toBeLessThanOrEqual(13)
            first.runs.slice(1).forEach(([from], index) => {
                expect(Math.abs(from - first.runs[index]![1] - 4)).toBeLessThanOrEqual(1)
            })
            // A beat label of another width moves the dashes at its end with it, and leaves the others in place.
            const ratio = await page.evaluate(() => devicePixelRatio)
            const anchored = ({ runs, to }: typeof first) => [
                ...runs.slice(0, 5).flat(),
                ...runs.slice(-5).flatMap(([start, end]) => [end - to, start - to]),
            ]
            const before = anchored(first)
            for (const display of ['both', 'beat'] as const) {
                await page.evaluate(
                    (display) => (window.editorTest.settings.beatDisplay = display),
                    display,
                )
                await expect
                    .poll(async () => {
                        const next = await dashes(page)
                        return (
                            Math.abs(next.to - first.to) > 2 &&
                            anchored(next).every((x, i) => Math.abs(x - before[i]!) <= 1 / ratio)
                        )
                    })
                    .toBe(true)
            }
        })

        test('Basic lines stop short of the grid labels they cross', async ({ page }) => {
            await setup(page, 'basic', 16)
            await useTool(page, 'select')
            // The cursor on a labelled beat, away from the hover.
            await page.mouse.move(5, 5)
            const [left, right] = await lanesAt(page, [-6.1, 6.1])
            const [far] = await lanesAt(page, [7])
            const inset = 4
            await page.evaluate(() => (window.editorTest.view.cursorTime = 6))
            await expect
                .poll(async () => {
                    const lit = await cursorLine(page)
                    return [lit.min - (left! + inset), lit.max - (right! - inset)].map(
                        (gap) => Math.abs(gap) <= 1,
                    )
                })
                .toEqual([true, true])
            // Off the labels, it keeps lanes -7 to 7.
            await page.evaluate(() => (window.editorTest.view.cursorTime = 6.25))
            await expect
                .poll(async () => Math.abs((await cursorLine(page)).max - far!) <= 1)
                .toBe(true)
            // Zoomed out, the hover line on a labelled beat would end beside the label.
            await page.evaluate(() => (window.editorTest.settings.width = 100))
            const [zoomedLeft, zoomedRight] = await lanesAt(page, [-6.1, 6.1])
            const { x, y } = await page.evaluate(() => window.editorTest.point(0, 12))
            await page.mouse.move(x, y)
            await expect
                .poll(async () => {
                    const lit = litRange(await lineRow(page, 'hover'))
                    return [lit.min - (zoomedLeft! + inset), lit.max - (zoomedRight! - inset)].map(
                        (gap) => Math.abs(gap) <= 1,
                    )
                })
                .toEqual([true, true])
        })
    })
}

test('Basic zoomed out: the hover line ends at the lanes, clear of its labels', async ({
    page,
}) => {
    await setup(page, 'basic', 24)
    await useTool(page, 'select')
    await hoverAt(page, 10.5)
    const { ratio, alphas, width } = await lineRow(page, 'hover')
    const lanes = await page.evaluate(() => {
        const { view, settings } = window.editorTest
        return [-6, 6].map((lane) => view.w * (0.5 + (lane - view.lane) / settings.width))
    })
    const lit = alphas.flatMap((alpha, x) => (alpha > 0 ? [x / ratio] : []))
    expect(Math.min(...lit)).toBeGreaterThanOrEqual(lanes[0]! - 1)
    expect(Math.max(...lit)).toBeLessThanOrEqual(lanes[1]! + 1)
    expect(Math.max(...lit) - Math.min(...lit)).toBeGreaterThan(width / 4)
})

test('hovering across a cursor line that ends clear of the labels redraws only the overlay', async ({
    page,
}) => {
    await setup(page, 'basic', 24)
    await useTool(page, 'select')
    await hoverAt(page, 10.5)
    await page.evaluate(() => {
        const { view } = window.editorTest
        view.cursorTime = view.hoverTime
    })
    const { x, y } = await page.evaluate(() => window.editorTest.point(0, 10.5))
    // Warm the active-label state before counting.
    await page.mouse.move(x, y - 30)
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    )
    await page.evaluate(() => (window.editorFrames = { chart: 0, overlay: 0 }))
    for (let dy = -27; dy <= 30; dy += 3) await page.mouse.move(x, y + dy)
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    )
    const frames = await page.evaluate(() => window.editorFrames)
    expect(frames.chart).toBe(0)
    expect(frames.overlay).toBeGreaterThanOrEqual(4)
})

test('in playback, the Basic cursor line keeps its ends as grid labels pass it', async ({
    page,
}) => {
    // The cursor line's ends in lanes, by chart frame: full-opacity white horizontal lines.
    await page.evaluate(() => {
        const ends: number[] = []
        ;(window as unknown as { cursorEnds: number[] }).cursorEnds = ends
        const proto = CanvasRenderingContext2D.prototype
        const { moveTo, lineTo } = proto
        let from: [number, number] | undefined
        proto.moveTo = function (x, y) {
            from = [x, y]
            return moveTo.call(this, x, y)
        }
        proto.lineTo = function (x, y) {
            if (
                this.canvas.classList.contains('editor-chart') &&
                this.globalAlpha === 1 &&
                this.strokeStyle === '#ffffff' &&
                from?.[1] === y &&
                from[0] < 0 &&
                x > 0
            )
                ends.push(x)
            return lineTo.call(this, x, y)
        }
    })
    await setup(page, 'basic', 16)
    await useTool(page, 'select')
    await page.mouse.move(5, 5)
    await page.evaluate(() => {
        const { settings, view } = window.editorTest
        settings.pps = 200
        view.cursorTime = 5
    })
    const ends = await page.evaluate(async () => {
        const player =
            await window.editorTest.appImport<typeof import('../../src/editor/player')>(
                '/src/editor/player.ts',
            )
        const recorded = (window as unknown as { cursorEnds: number[] }).cursorEnds
        recorded.length = 0
        player.startOrStopPlayer()
        await new Promise((resolve) => setTimeout(resolve, 2000))
        player.startOrStopPlayer()
        return [...recorded]
    })
    // Past several labelled beats.
    expect(ends.length).toBeGreaterThan(20)
    expect([...new Set(ends)]).toEqual([7])
})

// The middle of a canvas line's rows, in CSS pixels: alpha-weighted down a strip at the
// pane's middle. On the chart canvas, the change when the line moves away, within a few pixels.
const lineMiddle = (page: Page, line: Line, near = 0) =>
    page.evaluate(
        async ({ line, near }) => {
            const { view } = window.editorTest
            const frames = () =>
                new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                )
            const canvas = document.querySelector<HTMLCanvasElement>(
                line === 'hover' ? 'canvas.editor-overlay' : 'canvas.editor-chart',
            )!
            const ratio = canvas.width / canvas.clientWidth
            const width = Math.round(20 * ratio)
            const strip = () => {
                const data = canvas
                    .getContext('2d')!
                    .getImageData(Math.round(canvas.width / 2), 0, width, canvas.height).data
                return Array.from({ length: canvas.height }, (_, y) => {
                    let sum = 0
                    for (let x = 0; x < width; x++) sum += data[(y * width + x) * 4 + 3]!
                    return sum
                })
            }
            await frames()
            let rows = strip()
            if (line === 'cursor') {
                const time = view.cursorTime
                view.cursorTime = 0
                await frames()
                const off = strip()
                rows = rows.map((sum, y) =>
                    Math.abs(y / ratio - near) < 4 ? Math.abs(sum - off[y]!) : 0,
                )
                view.cursorTime = time
                await frames()
            }
            let weight = 0
            let sum = 0
            rows.forEach((alpha, y) => {
                weight += alpha
                sum += alpha * (y + 0.5)
            })
            return sum / weight / ratio
        },
        { line, near },
    )

// The middle of the hover labels' figures, in CSS pixels down the pane: the ink of their first
// two characters, with the canvases hidden.
const figureMiddles = async (page: Page) => {
    const clips = await page.evaluate(() => {
        const pane = document.querySelector('.chart-pane')!.getBoundingClientRect()
        for (const canvas of document.querySelectorAll<HTMLCanvasElement>('.chart-pane canvas'))
            canvas.style.visibility = 'hidden'
        return [...document.querySelectorAll('.chart-pane > div:nth-of-type(2) > span')].map(
            (span) => {
                const range = document.createRange()
                range.setStart(span.firstChild!, 0)
                range.setEnd(span.firstChild!, 2)
                const text = range.getBoundingClientRect()
                const box = span.getBoundingClientRect()
                // Whole pixels, so the shot's rows start where the clip does.
                const y = Math.floor(box.top) - 2
                return {
                    paneTop: pane.top,
                    clip: {
                        x: Math.floor(text.left),
                        y,
                        width: Math.ceil(text.width),
                        height: Math.ceil(box.bottom) + 2 - y,
                    },
                }
            },
        )
    })
    const middles = []
    for (const { clip, paneTop } of clips) {
        const shot = await page.screenshot({ clip, scale: 'device' })
        const ink = await page.evaluate(async (data) => {
            const image = new Image()
            image.src = `data:image/png;base64,${data}`
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = image.width
            canvas.height = image.height
            const context = canvas.getContext('2d')!
            context.drawImage(image, 0, 0)
            const pixels = context.getImageData(0, 0, image.width, image.height).data
            // The background is the commonest colour.
            const counts = new Map<number, number>()
            for (let i = 0; i < pixels.length; i += 4) {
                const key = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!
                counts.set(key, (counts.get(key) ?? 0) + 1)
            }
            const background = [...counts].sort((a, b) => b[1] - a[1])[0]![0]
            const rows = Array.from({ length: image.height }, (_, y) => {
                let max = 0
                for (let x = 0; x < image.width; x++) {
                    const i = (y * image.width + x) * 4
                    for (const [channel, shift] of [
                        [0, 16],
                        [1, 8],
                        [2, 0],
                    ] as const)
                        max = Math.max(
                            max,
                            Math.abs(pixels[i + channel]! - ((background >> shift) & 255)),
                        )
                }
                return max
            })
            const peak = Math.max(...rows)
            const inked = rows.flatMap((value, y) => (value > peak * 0.3 ? [y] : []))
            return { top: inked[0]!, bottom: inked.at(-1)! + 1, ratio: devicePixelRatio }
        }, shot.toString('base64'))
        middles.push(clip.y - paneTop + (ink.top + ink.bottom) / 2 / ink.ratio)
    }
    await page.evaluate(() => {
        for (const canvas of document.querySelectorAll<HTMLCanvasElement>('.chart-pane canvas'))
            canvas.style.visibility = ''
    })
    return middles
}

for (const deviceScaleFactor of [1, 1.5, 2]) {
    for (const rootSize of [16, 20]) {
        test.describe(`at ${deviceScaleFactor}x and ${rootSize} pixel text`, () => {
            test.use({ deviceScaleFactor })

            test('the hover labels centre their figures on the line', async ({ page }) => {
                await page.addStyleTag({ content: `html { font-size: ${rootSize}px }` })
                await setup(page, 'composed', 24)
                await useTool(page, 'select')
                await hoverAt(page, 10.5)
                const time = await page.evaluate(() => window.editorTest.view.hoverTime)
                const offsets: number[] = []
                // Text lands on whole pixels; the line needn't.
                for (const shift of [0, 0.25, 0.5, 0.75]) {
                    await page.evaluate(
                        ({ time, shift }) => {
                            const { view, settings } = window.editorTest
                            view.hoverTime = time - shift / settings.pps
                            view.cursorTime = view.hoverTime
                        },
                        { time, shift },
                    )
                    const line = await lineMiddle(page, 'hover')
                    // The cursor line on the hover is the same line, to within its antialiasing over the chart.
                    expect(Math.abs((await lineMiddle(page, 'cursor', line)) - line)).toBeLessThan(
                        0.5 / deviceScaleFactor,
                    )
                    for (const middle of await figureMiddles(page)) offsets.push(middle - line)
                }
                // Within half a pixel, as text lands on whole ones, and centred on average; device
                // pixels that aren't whole pixels add up to half of one.
                const uneven = Number.isInteger(deviceScaleFactor) ? 0 : 0.5 / deviceScaleFactor
                const mean = offsets.reduce((a, b) => a + b) / offsets.length
                expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(0.51 + uneven)
                expect(Math.abs(mean)).toBeLessThanOrEqual(0.2 + uneven / 2)
            })
        })
    }
}
