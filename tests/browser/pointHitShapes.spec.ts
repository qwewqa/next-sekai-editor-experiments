import { expect, test, type Page } from '@playwright/test'
import type { Chart } from '../../src/chart'
import { installCanvasCounters, installEditorFixture, useTool } from './editorFixture'

// A press takes the object whose primary hit shape holds it, by the hit model's precedence:
// event and time-scale markers have shapes too. Flick arrows are decoration.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

type Build =
    | 'arrow'
    | 'diamondEdge'
    | 'pivotNearAnchor'
    | 'pivotInAnchor'
    | 'timeScaleInAnchor'
    | 'styleBesideNote'
    | 'jump'
    | 'edge'

// Each chart at 120 BPM, as the fixture's point() assumes.
const show = (page: Page, build: Build, layout: 'basic' | 'composed' = 'basic') =>
    page.evaluate(
        ({ build, layout }) => {
            const { show, fixtures, view, settings } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            const events = fixtures.events
            const chart: Chart = {
                ...events,
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
            const timeScale = {
                ...events.timeScales[0]!,
                groupId: base.groupId,
                timeScaleTransition: 'timeScale' as const,
                hideNotes: false,
            }
            switch (build) {
                case 'arrow':
                    // An up flick whose arrow is drawn over the later note above it.
                    chart.slides = [
                        [{ ...base, beat: 4, left: -2, size: 4, flickDirection: 'up' }],
                        [{ ...base, beat: 4.5, left: -1, size: 2 }],
                    ]
                    break
                case 'diamondEdge':
                    // A sized tick, drawn as its diamond, on top as the earlier beat.
                    chart.slides = [
                        [{ ...base, beat: 4, left: -3, size: 2, noteType: 'forceTick' }],
                        [{ ...base, beat: 4.05, left: -2, size: 4 }],
                    ]
                    break
                case 'pivotNearAnchor':
                case 'pivotInAnchor':
                case 'timeScaleInAnchor': {
                    // An anchor's outline box is 0.3 lanes tall; near, it is 0.3 lanes above the marker.
                    const beat =
                        build === 'pivotNearAnchor'
                            ? 4 + (2 * 0.3 * (view.w / settings.width)) / 240
                            : 4
                    chart.slides = [
                        [
                            { ...base, beat: 3, left: -3, size: 2 },
                            { ...base, beat, left: -1, size: 2, noteType: 'anchor' },
                            { ...base, beat: 5, left: 1, size: 2 },
                        ],
                    ]
                    if (build === 'timeScaleInAnchor')
                        chart.timeScales = [
                            { ...timeScale, beat: 4, editorLane: 0.3, timeScale: 2 },
                        ]
                    else
                        chart.stagePivotEvents = [
                            { ...events.stagePivotEvents[0]!, beat: 4, pivotLane: 0.3 },
                        ]
                    break
                }
                case 'styleBesideNote':
                    chart.slides = [[{ ...base, beat: 4, left: 0, size: 0.4 }]]
                    chart.stageStyleEvents = [
                        { ...events.stageStyleEvents[0]!, beat: 4, editorLane: 0.85 },
                    ]
                    break
                case 'jump':
                    // A same-beat jump: a marker for each change, on one spot.
                    chart.timeScales = [
                        { ...timeScale, beat: 4, editorLane: 3, timeScale: 2 },
                        { ...timeScale, beat: 4, editorLane: 3, timeScale: 3 },
                    ]
                    break
                case 'edge':
                    // A time scale's marker on a note's left edge, as charts place them at lane -6.
                    chart.slides = [[{ ...base, beat: 4, left: -6, size: 3 }]]
                    chart.timeScales = [{ ...timeScale, beat: 4, editorLane: -6, timeScale: 2 }]
                    break
            }
            show(chart, 2)
            view.layout = layout
            settings.pps = 240
        },
        { build, layout },
    )

const at = (page: Page, lane: number, beat: number) =>
    page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), { lane, beat })

// A point lanes above another.
const above = async (page: Page, point: { x: number; y: number }, lanes: number) => {
    const lane = await page.evaluate(
        () => window.editorTest.view.w / window.editorTest.settings.width,
    )
    return { x: point.x, y: point.y - lanes * lane }
}

const hover = async (page: Page, point: { x: number; y: number }) => {
    await page.mouse.move(point.x - 2, point.y)
    await page.mouse.move(point.x, point.y)
}

const click = async (page: Page, point: { x: number; y: number }) => {
    await hover(page, point)
    await page.mouse.down()
    await page.mouse.up()
}

const selected = (page: Page) => page.evaluate(() => window.editorTest.snapshot().selected)

const hits = (page: Page, point: { x: number; y: number }, type?: 'note') =>
    page.evaluate(
        async ({ point, type }) => {
            const utils = await window.editorTest.appImport<
                typeof import('../../src/editor/tools/utils')
            >('/src/editor/tools/utils.ts')
            return (
                type
                    ? utils.pointHitsOfType(type, point.x, point.y).hits
                    : utils.pointHitsAt(point.x, point.y).hits
            ).map((entity) => `${entity.type}:${entity.beat}`)
        },
        { point, type },
    )

const editor = (page: Page) => page.locator('.editor-chart').locator('..')

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: a flick arrow is decoration; a press on it over the next note takes that note`, async ({
        page,
    }) => {
        await show(page, 'arrow', layout)
        await useTool(page, 'select')
        // The arrow's middle, 0.9 lanes above its note's, on the later note's body.
        const point = await above(page, await at(page, 0, 4), 0.9)
        expect((await hits(page, point))[0]).toBe('note:4.5')
        await hover(page, point)
        await expect
            .poll(() => page.evaluate(() => window.editorTest.snapshot().hovered[0]?.beat))
            .toBe(4.5)
        await click(page, point)
        expect(await selected(page)).toMatchObject([{ type: 'note', beat: 4.5 }])
    })
}

test("a tick's diamond over another note's edge is grabbed, not the edge", async ({ page }) => {
    await show(page, 'diamondEdge')
    await useTool(page, 'select')
    // The diamond is drawn over the later note's left edge.
    const point = await at(page, -1.95, 4)
    expect(await hits(page, point)).toEqual(['note:4', 'note:4.05'])
    await hover(page, point)
    await expect(editor(page)).toHaveCSS('cursor', 'move')
    const lane = await page.evaluate(
        () => window.editorTest.view.w / window.editorTest.settings.width,
    )
    await page.mouse.down()
    await page.mouse.move(point.x + lane, point.y, { steps: 6 })
    await page.mouse.up()
    expect(await page.evaluate(() => window.editorTest.snapshot().notes)).toMatchObject([
        { beat: 4, left: -2, size: 2 },
        { beat: 4.05, left: -2, size: 4 },
    ])
})

test("a pivot's marker in an anchor's reach, past its box, takes the pivot", async ({ page }) => {
    await show(page, 'pivotNearAnchor')
    await useTool(page, 'select')
    const point = await at(page, 0.3, 4)
    const [first, second] = await hits(page, point)
    expect(first).toBe('stagePivotEventJoint:4')
    // The anchor is in reach there, past its outline.
    expect(second).toMatch(/^note:4./)
    await click(page, point)
    expect(await selected(page)).toMatchObject([{ type: 'stagePivotEventJoint', beat: 4 }])
})

test("on an anchor's box, precedence decides: the anchor over a pivot, a time scale over it", async ({
    page,
}) => {
    await show(page, 'pivotInAnchor')
    await useTool(page, 'select')
    const point = await at(page, 0.3, 4)
    expect(await hits(page, point)).toEqual(['note:4', 'stagePivotEventJoint:4'])
    await click(page, point)
    expect(await selected(page)).toMatchObject([{ type: 'note', beat: 4, left: -1 }])
    await show(page, 'timeScaleInAnchor')
    expect(await hits(page, point)).toEqual(['timeScale:4', 'note:4'])
    await click(page, point)
    expect(await selected(page)).toMatchObject([{ type: 'timeScale', beat: 4 }])
})

test("a style marker beside a narrow note's body takes the style", async ({ page }) => {
    await show(page, 'styleBesideNote')
    await useTool(page, 'select')
    const point = await at(page, 0.85, 4)
    expect(await hits(page, point)).toEqual(['stageStyleEventJoint:4', 'note:4'])
    await click(page, point)
    expect(await selected(page)).toMatchObject([{ type: 'stageStyleEventJoint', beat: 4 }])
    // Its body is still the note.
    await click(page, await at(page, 0.2, 4))
    expect(await selected(page)).toMatchObject([{ type: 'note', beat: 4 }])
})

test('clicks on a same-beat time-scale jump reach each change in turn', async ({ page }) => {
    await show(page, 'jump')
    await useTool(page, 'select')
    const point = await at(page, 3, 4)
    // Each change has its own box.
    expect(await hits(page, point)).toEqual(['timeScale:4', 'timeScale:4'])
    const picked = async () => {
        await click(page, point)
        return page.evaluate(() =>
            window.editorTest.history.state.value.selectedEntities.map((entity) =>
                entity.type === 'timeScale' ? entity.timeScale : undefined,
            ),
        )
    }
    // Identical boxes go to the one stored later first.
    expect(await picked()).toEqual([3])
    expect(await picked()).toEqual([2])
})

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: a time-scale marker on a note's edge is grabbed, not the edge`, async ({
        page,
    }) => {
        await show(page, 'edge', layout)
        await useTool(page, 'select')
        const point = await at(page, -6, 4)
        expect(await hits(page, point)).toEqual(['timeScale:4', 'note:4'])
        await hover(page, point)
        await expect(editor(page)).toHaveCSS('cursor', 'move')
        const lane = await page.evaluate(
            () => window.editorTest.view.w / window.editorTest.settings.width,
        )
        await page.mouse.down()
        await page.mouse.move(point.x + lane, point.y, { steps: 6 })
        await page.mouse.up()
        expect(
            await page.evaluate(() =>
                [...window.editorTest.history.state.value.store.grid.timeScale.values()]
                    .flatMap((entities) => [...entities])
                    .map((entity) => entity.editorLane),
            ),
        ).toEqual([-5])
        expect(await page.evaluate(() => window.editorTest.snapshot().notes)).toMatchObject([
            { beat: 4, left: -6, size: 3 },
        ])
        // Off the marker, the edge still resizes.
        await page.keyboard.press('Control+z')
        await page.evaluate(() => {
            const { history } = window.editorTest
            history.replaceState({ ...history.state.value, selectedEntities: [] })
        })
        await hover(page, await at(page, -5.9, 4.1))
        await expect(editor(page)).toHaveCSS('cursor', 'ew-resize')
    })
}

// In the Elevation Editor later rows go over earlier ones; arrows are decoration.
test('Elevation Editor: a press on a flick arrow under a higher row takes the row', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { show, fixtures, settings, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 3, left: -2, size: 4, elevation: 2, flickDirection: 'up' }],
                    [{ ...base, beat: 3, left: -1, size: 2, elevation: 2.85 }],
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
    const point = await page.evaluate(async () => {
        const { appImport, nextTick } = window.editorTest
        const { elevationLayout } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const { elevationBounds, elevationViewport } = await appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        const { editorNavigation } = await appImport<typeof import('../../src/editor/navigation')>(
            '/src/editor/navigation.ts',
        )
        // An elevation unit as wide as a lane.
        editorNavigation.value!.setScaleY(elevationLayout.value.laneScale)
        elevationViewport.center = 2.4
        await nextTick()
        const scale = elevationLayout.value.laneScale
        const flick = elevationLayout.value.rows.find((row) => row.note.flickDirection === 'up')!
        // The arrow's middle, on the higher row's body.
        return { x: elevationBounds.x + flick.x, y: elevationBounds.y + flick.y - 0.9 * scale }
    })
    await click(page, point)
    expect(await selected(page)).toMatchObject([{ type: 'note', beat: 3, left: -1 }])
})
