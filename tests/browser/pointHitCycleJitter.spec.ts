import { expect, test, type Page } from '@playwright/test'
import type { Chart } from '../../src/chart'
import { installCanvasCounters, installEditorFixture, useTool } from './editorFixture'

// Clicks that jitter a pixel either side of an edge, where one note comes into reach as another
// goes, still reach every object of the stack each lap; the hover shows each click's pick.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// Two wide notes over lane 0, one ending there on its left and one starting there on its right.
const stack = [
    { left: -2, size: 4 },
    { left: -1.5, size: 3 },
    { left: -3, size: 3 },
    { left: 0, size: 3 },
]

const lefts = (page: Page, of: 'hovered' | 'selected') =>
    page.evaluate(
        (of) =>
            (of === 'hovered'
                ? window.editorTest.view.entities.hovered
                : window.editorTest.history.state.value.selectedEntities
            ).map((entity) => (entity.type === 'note' ? entity.left : entity.type)),
        of,
    )

/** Clicks left and right of the edge in turn; checks each hover is the click's pick; returns the picks. */
const jitterClicks = async (page: Page, edge: { x: number; y: number }) => {
    const picks: unknown[] = []
    const x = Math.round(edge.x)
    for (let i = 0; i < 4 * stack.length; i++) {
        const point = { x: i % 2 ? x + 1 : x - 1, y: Math.round(edge.y) }
        await page.mouse.move(point.x, point.y)
        const hovered = await lefts(page, 'hovered')
        await page.mouse.click(point.x, point.y)
        const selected = await lefts(page, 'selected')
        expect(selected, `click ${i}`).toEqual(hovered)
        picks.push(selected[0])
    }
    return picks
}

const expectEveryLap = (picks: unknown[]) => {
    // Every note within each run of 2n clicks.
    const lap = 2 * stack.length
    for (let from = 0; from + lap <= picks.length; from++)
        expect(new Set(picks.slice(from, from + lap)).size, `${picks.join()}`).toBe(stack.length)
}

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: one-pixel jitter reaches every note each lap`, async ({ page }) => {
        const edge = await page.evaluate(
            ({ layout, stack }) => {
                const { show, fixtures, view, settings } = window.editorTest
                const base = fixtures.interaction.slides[0]![0]!
                const chart: Chart = {
                    ...fixtures.events,
                    isDynamicStages: layout === 'composed',
                    bpms: [{ beat: 0, bpm: 120 }],
                    cameraEvents: [],
                    stageMaskEvents: [],
                    stagePivotEvents: [],
                    stageStyleEvents: [],
                    stageTransformEvents: [],
                    timeScales: [],
                    slides: stack.map((note) => [{ ...base, beat: 4, ...note }]),
                }
                show(chart, 2)
                view.layout = layout
                settings.width = view.w / 40
                settings.pps = 160
                view.lane = 0.3
                return window.editorTest.point(0, 4)
            },
            { layout, stack },
        )
        await useTool(page, 'select')
        expectEveryLap(await jitterClicks(page, edge))
    })
}

test('Elevation Editor: one-pixel jitter reaches every row each lap', async ({ page }) => {
    await page.evaluate(async (stack) => {
        const { show, fixtures, settings, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: stack.map((note, i) => [
                    { ...base, beat: 3, ...note, elevation: 2 + i * 0.02 },
                ]),
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
    }, stack)
    await useTool(page, 'select')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    const edge = await page.evaluate(async () => {
        const { appImport, nextTick } = window.editorTest
        const { elevationLayout } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        await nextTick()
        const layout = elevationLayout.value
        const box = document.querySelector('canvas.elevation-canvas')!.getBoundingClientRect()
        return { x: box.x + layout.xAt(0), y: box.y + layout.yAt(2.03) }
    })
    expectEveryLap(await jitterClicks(page, edge))
})
