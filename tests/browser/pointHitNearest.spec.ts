import { expect, test, type Page } from '@playwright/test'
import type { Chart } from '../../src/chart'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Off every shape, the nearest one in reach takes the point: reach meets halfway.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

type Build = 'sideBySide' | 'zeroWidth' | 'inTime' | 'marker' | 'tick'

// 40 pixels a lane and per 0.25 s, at 120 BPM.
const show = (page: Page, build: Build) =>
    page.evaluate((build) => {
        const { show, fixtures, view, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const chart: Chart = {
            ...fixtures.events,
            isDynamicStages: true,
            bpms: [{ beat: 0, bpm: 120 }],
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [],
            slides: [],
        }
        switch (build) {
            case 'sideBySide':
                chart.slides = [
                    [{ ...base, beat: 4, left: -2.2, size: 2 }],
                    [{ ...base, beat: 4, left: 0.2, size: 2 }],
                ]
                break
            case 'zeroWidth':
                chart.slides = [
                    [{ ...base, beat: 4, left: 0, size: 0 }],
                    [{ ...base, beat: 4, left: 0.5, size: 3 }],
                ]
                break
            case 'inTime':
                // 0.8 lanes apart: 0.2 lanes between their boxes.
                chart.slides = [
                    [{ ...base, beat: 4, left: -1, size: 2 }],
                    [{ ...base, beat: 4.4, left: -1, size: 2 }],
                ]
                break
            case 'marker':
                chart.slides = [[{ ...base, beat: 4, left: 0, size: 2 }]]
                chart.stagePivotEvents = [
                    { ...fixtures.events.stagePivotEvents[0]!, beat: 4, pivotLane: -0.5 },
                ]
                break
            case 'tick':
                chart.slides = [
                    [
                        { ...base, beat: 3, left: -2, size: 4 },
                        { ...base, beat: 4, left: -2, size: 4, isAttached: true },
                        { ...base, beat: 5, left: -2, size: 4 },
                    ],
                    [{ ...base, beat: 4, left: 2.2, size: 2 }],
                ]
                break
        }
        show(chart, 2)
        settings.width = view.w / 40
        settings.pps = 160
        view.lane = 0
    }, build)

const at = (page: Page, lane: number, beat: number) =>
    page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), { lane, beat })

/** The first hit at each pixel along a line, as `type:beat:left` or empty. */
const sweep = (
    page: Page,
    from: { x: number; y: number },
    to: { x: number; y: number },
    minimumNoteWidth = 1.5,
) =>
    page.evaluate(
        async ({ from, to, minimumNoteWidth }) => {
            const utils = await window.editorTest.appImport<
                typeof import('../../src/editor/tools/utils')
            >('/src/editor/tools/utils.ts')
            const steps = Math.round(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)))
            return Array.from({ length: steps + 1 }, (_, i) => {
                const x = from.x + ((to.x - from.x) * i) / steps
                const y = from.y + ((to.y - from.y) * i) / steps
                const [hit] = utils.pointHitsAt(x, y, minimumNoteWidth).hits
                return {
                    x,
                    y,
                    hit: hit
                        ? `${hit.type}:${hit.beat}:${hit.type === 'note' ? hit.left : ''}`
                        : '',
                }
            })
        },
        { from, to, minimumNoteWidth },
    )

// Where the first hit changes from one to the other, with nothing else in between.
const crossover = (points: Awaited<ReturnType<typeof sweep>>, a: string, b: string) => {
    const hits = points.map(({ hit }) => hit)
    const last = hits.lastIndexOf(a)
    const first = hits.indexOf(b)
    expect(last, hits.join(' ')).toBeGreaterThanOrEqual(0)
    expect(first, hits.join(' ')).toBe(last + 1)
    expect(hits.slice(0, last + 1).every((hit) => hit === a)).toBe(true)
    expect(hits.slice(first).every((hit) => hit === b)).toBe(true)
    return points[first]!
}

test('two notes side by side meet halfway across their gap', async ({ page }) => {
    await show(page, 'sideBySide')
    for (const width of [1.5, 0.5]) {
        const points = await sweep(page, await at(page, -0.3, 4), await at(page, 0.3, 4), width)
        const middle = await at(page, 0, 4)
        expect(
            Math.abs(crossover(points, 'note:4:-2.2', 'note:4:0.2').x - middle.x),
        ).toBeLessThanOrEqual(1)
    }
})

test('a zero-width note and a wide note meet halfway, the minimum width notwithstanding', async ({
    page,
}) => {
    await show(page, 'zeroWidth')
    const points = await sweep(page, await at(page, 0.05, 4), await at(page, 0.55, 4))
    // Between the placeholder's edge at 0.1 and the wide note's at 0.5.
    const middle = await at(page, 0.3, 4)
    expect(Math.abs(crossover(points, 'note:4:0', 'note:4:0.5').x - middle.x)).toBeLessThanOrEqual(
        1,
    )
})

test('two notes close in time meet halfway between them', async ({ page }) => {
    await show(page, 'inTime')
    const points = await sweep(page, await at(page, 0, 4.1), await at(page, 0, 4.3))
    const middle = await at(page, 0, 4.2)
    expect(
        Math.abs(crossover(points, 'note:4:-1', 'note:4.4:-1').y - middle.y),
    ).toBeLessThanOrEqual(1)
})

test('a note and a marker in reach: the nearer shape takes the point', async ({ page }) => {
    await show(page, 'marker')
    // The marker's box ends at -0.4 and the note's at 0.
    const points = await sweep(page, await at(page, -0.35, 4), await at(page, -0.05, 4))
    const middle = await at(page, -0.2, 4)
    expect(
        Math.abs(crossover(points, 'stagePivotEventJoint:4:', 'note:4:0').x - middle.x),
    ).toBeLessThanOrEqual(1)
})

test("a tick's width box takes the point over a note in reach, and they meet halfway", async ({
    page,
}) => {
    await show(page, 'tick')
    // On the tick's box, past its diamond, within the other note's reach.
    const on = await at(page, 1.98, 4)
    expect(
        await page.evaluate(async (on) => {
            const utils = await window.editorTest.appImport<
                typeof import('../../src/editor/tools/utils')
            >('/src/editor/tools/utils.ts')
            return utils
                .pointHitsAt(on.x, on.y)
                .hits.map((hit) => `${hit.type}:${hit.beat}:${hit.type === 'note' ? hit.left : ''}`)
        }, on),
    ).toEqual(['note:4:-2', 'note:4:2.2'])
    await page.mouse.move(on.x - 2, on.y)
    await page.mouse.click(on.x, on.y)
    expect(await page.evaluate(() => window.editorTest.snapshot().selected)).toMatchObject([
        { beat: 4, left: -2 },
    ])
    const points = await sweep(page, await at(page, 1.95, 4), await at(page, 2.25, 4))
    const middle = await at(page, 2.1, 4)
    expect(Math.abs(crossover(points, 'note:4:-2', 'note:4:2.2').x - middle.x)).toBeLessThanOrEqual(
        1,
    )
})

test('Elevation Editor: rows side by side meet halfway', async ({ page }) => {
    await page.evaluate(async () => {
        const { show, fixtures, settings, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 3, left: -2.05, size: 2, elevation: 2 }],
                    [{ ...base, beat: 3, left: 0.05, size: 2, elevation: 2 }],
                ],
            },
            3,
        )
        settings.showSidebar = false
        settings.showPreview = false
        settings.elevationEditorSideBySide = 'disallow'
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(3)
    })
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    const result = await page.evaluate(async () => {
        const { appImport, nextTick } = window.editorTest
        await nextTick()
        const { elevationLayout } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const { elevationBounds } = await appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        const { editorNavigation } = await appImport<typeof import('../../src/editor/navigation')>(
            '/src/editor/navigation.ts',
        )
        const layout = elevationLayout.value
        const middle = elevationBounds.x + layout.xAt(0)
        const y = elevationBounds.y + layout.rows[0]!.y
        const hits = []
        for (let x = Math.floor(middle - 6); x <= middle + 6; x++)
            hits.push({
                x,
                left: (editorNavigation.value!.hitPoint(x, y, 1.5).hits[0] as { left: number })
                    .left,
            })
        return { middle, hits }
    })
    const switched = result.hits.find(({ left }) => left === 0.05)!
    expect(result.hits.filter(({ x }) => x < switched.x).every(({ left }) => left === -2.05)).toBe(
        true,
    )
    expect(result.hits.filter(({ x }) => x >= switched.x).every(({ left }) => left === 0.05)).toBe(
        true,
    )
    expect(Math.abs(switched.x - result.middle)).toBeLessThanOrEqual(1)
})
