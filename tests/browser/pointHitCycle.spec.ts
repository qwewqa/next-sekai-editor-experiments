import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Clicks cycle an overlap top to bottom, once per lap; selection affects it only via raised chains.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const selected = (page: Page) =>
    page.evaluate(() =>
        window.editorTest.history.state.value.selectedEntities.map((entity) =>
            entity.type === 'note' ? `${entity.beat}:${entity.left}` : entity.type,
        ),
    )

const click = async (page: Page, point: { x: number; y: number }) => {
    await page.mouse.move(point.x - 2, point.y)
    await page.mouse.click(point.x, point.y)
}

test('three stacked notes cycle top to bottom, and another overlap starts at its top', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { show, fixtures, settings, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    // Same beat: the later one is drawn on top.
                    [{ ...base, beat: 4, left: -2, size: 4 }],
                    [{ ...base, beat: 4, left: -1, size: 4 }],
                    [{ ...base, beat: 4, left: 0, size: 4 }],
                    // The earlier beat is drawn on top.
                    [{ ...base, beat: 6, left: -2, size: 4 }],
                    [{ ...base, beat: 6.05, left: -2, size: 4 }],
                ],
            },
            2.5,
        )
        settings.pps = 240
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo('select')
    })
    const stack = await page.evaluate(() => window.editorTest.point(1, 4))
    const pair = await page.evaluate(() => window.editorTest.point(0, 6.02))
    for (const note of ['4:0', '4:-1', '4:-2', '4:0', '4:-1']) {
        await click(page, stack)
        expect(await selected(page)).toEqual([note])
    }
    // The selection isn't in this overlap: it starts at its top.
    for (const note of ['6:-2', '6.05:-2', '6:-2']) {
        await click(page, pair)
        expect(await selected(page)).toEqual([note])
    }
    await click(page, stack)
    expect(await selected(page)).toEqual(['4:0'])
    // With several selected, the cycle goes on from the first of them.
    await page.evaluate(() => {
        const { history } = window.editorTest
        const notes = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({
            ...history.state.value,
            selectedEntities: [-1, -2].map((left) =>
                notes.find((note) => note.beat === 4 && note.left === left),
            ) as typeof notes,
        })
    })
    await click(page, stack)
    expect(await selected(page)).toEqual(['4:-2'])
})

test('Elevation Editor: overlapping rows cycle top to bottom, and another overlap starts at its top', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { show, fixtures, settings, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 3, left: -2, size: 4, elevation: 2 }],
                    [{ ...base, beat: 3, left: -1, size: 4, elevation: 2.1 }],
                    [{ ...base, beat: 3, left: 0, size: 4, elevation: 2.2 }],
                    [{ ...base, beat: 3, left: -2, size: 4, elevation: 4 }],
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
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo('select')
    })
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    const points = await page.evaluate(async () => {
        const { appImport, nextTick } = window.editorTest
        const { elevationLayout } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const { elevationBounds } = await appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        await nextTick()
        const rows = elevationLayout.value.rows
        const row = (elevation: number) => rows.find((row) => row.note.elevation === elevation)!
        const middle = row(2.1)
        const lane = elevationLayout.value.laneScale
        return {
            // Lane 1, where the three lower rows overlap.
            stack: { x: elevationBounds.x + middle.x + lane, y: elevationBounds.y + middle.y },
            single: { x: elevationBounds.x + row(4).x, y: elevationBounds.y + row(4).y },
        }
    })
    const elevations = () =>
        page.evaluate(() =>
            window.editorTest.history.state.value.selectedEntities.map((entity) =>
                entity.type === 'note' ? entity.elevation : undefined,
            ),
        )
    // Higher rows are drawn over lower ones.
    for (const elevation of [2.2, 2.1, 2, 2.2]) {
        await click(page, points.stack)
        expect(await elevations()).toEqual([elevation])
    }
    await click(page, points.single)
    expect(await elevations()).toEqual([4])
    await click(page, points.stack)
    expect(await elevations()).toEqual([2.2])
})

test('a selection made elsewhere starts a new cycle in its spot, not an old cycle', async ({
    page,
}) => {
    const taps = await page.evaluate(async () => {
        const { show, fixtures, view, settings, history, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const events = fixtures.events
        show(
            {
                ...events,
                isDynamicStages: true,
                bpms: [{ beat: 0, bpm: 120 }],
                cameraEvents: [],
                stageMaskEvents: [],
                stageTransformEvents: [],
                timeScales: [],
                // A pivot at 0, a zero-width note at 0.5 and a style at 1, about 15 pixels a lane.
                stagePivotEvents: [{ ...events.stagePivotEvents[0]!, beat: 4, pivotLane: 0 }],
                stageStyleEvents: [{ ...events.stageStyleEvents[0]!, beat: 4, editorLane: 1 }],
                slides: [[{ ...base, beat: 4, left: 0.5, size: 0 }]],
            },
            2,
        )
        settings.width = 100
        view.lane = 0
        const { select } = await appImport<typeof import('../../src/editor/tools/select')>(
            '/src/editor/tools/select.ts',
        )
        const name = () => history.state.value.selectedEntities.map((entity) => entity.type).join()
        const tap = (lane: number) => {
            const { x, y } = window.editorTest.point(lane, 4)
            void select.tap?.(x, y, { ctrl: false, shift: false })
            return name()
        }
        // The pivot and the note reach 0.1; the style, the note and the pivot reach 0.8, nearest first.
        const cycled = [tap(0.1), tap(0.1)]
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.grid.stageStyleEventJoint.values()]
                .flatMap((set) => [...set])
                .slice(0, 1),
        })
        return [...cycled, tap(0.8)]
    })
    expect(taps).toEqual(['stagePivotEventJoint', 'note', 'note'])
})

test("with a joint selected, taps on a chain-mate's marker over a note start at the marker", async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { show, fixtures, history, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const events = fixtures.events
        const pivot = { ...events.stagePivotEvents[0]!, pivotLane: 0 }
        show(
            {
                ...events,
                bpms: [{ beat: 0, bpm: 120 }],
                cameraEvents: [],
                stageMaskEvents: [],
                stageStyleEvents: [],
                stageTransformEvents: [],
                timeScales: [],
                stagePivotEvents: [
                    { ...pivot, beat: 4 },
                    { ...pivot, beat: 8 },
                ],
                slides: [[{ ...base, beat: 4, left: -1, size: 2 }]],
            },
            2,
        )
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo('select')
        // The joint at beat 8 raises the chain, drawing the one at 4 over the note.
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...window.editorTest.store.getAllEntities()].filter(
                (entity) => entity.type === 'stagePivotEventJoint' && entity.beat === 8,
            ),
        })
    })
    const spot = await page.evaluate(() => window.editorTest.point(0, 4))
    for (const entity of ['stagePivotEventJoint', '4:-1', 'stagePivotEventJoint']) {
        await click(page, spot)
        expect(await selected(page)).toEqual([entity])
    }
})
