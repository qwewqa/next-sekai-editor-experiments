import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, useTool } from './editorFixture'

// The hover and cursor lines stop a label inset short of the time and beat labels they meet.

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
const lineRow = (page: Page, line: Line) =>
    page.evaluate(async (line) => {
        const { view, settings } = window.editorTest
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        const canvas = document.querySelector<HTMLCanvasElement>(
            line === 'hover' ? 'canvas.editor-overlay' : 'canvas.editor-chart',
        )!
        const pane = canvas.getBoundingClientRect()
        const time = line === 'hover' ? view.hoverTime : view.cursorTime
        const y = 0.5 * view.h - (time - view.time) * settings.pps
        const ratio = canvas.width / canvas.clientWidth
        const data = canvas
            .getContext('2d')!
            .getImageData(0, Math.floor(y * ratio), canvas.width, 1).data
        const alphas = Array.from({ length: canvas.width }, (_, x) => data[x * 4 + 3]!)
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
            inset: parseFloat(getComputedStyle(labels[0]!).paddingLeft),
            left: Math.max(...met.filter((box) => box.left < middle).map((box) => box.right)),
            right: Math.min(...met.filter((box) => box.left > middle).map((box) => box.left)),
            width: pane.width,
        }
    }, line)

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
                // Drawn right after the left stop, where a dash starts, and within a dash cycle of the right one.
                afterLeft: lit(left + inset, left + inset + 5),
                beforeRight: lit(right - inset - 12, right - inset),
            }
        })
        .toEqual({
            meets: true,
            overLeft: false,
            overRight: false,
            afterLeft: true,
            beforeRight: true,
        })

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

        test('Basic zoomed in: the hover line stops short of its labels', async ({ page }) => {
            await page.setViewportSize({ width: 390, height: 844 })
            await setup(page, 'basic', 6)
            await useTool(page, 'select')
            await hoverAt(page, 10.5)
            await expectGaps(page, 'hover')
        })
    })
}

test('Basic at the default zoom: the hover line ends at the lanes, clear of its labels', async ({
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
