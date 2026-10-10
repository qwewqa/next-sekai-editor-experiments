import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async () => undefined,
        })
        Object.defineProperty(navigator.clipboard, 'readText', {
            configurable: true,
            value: async () => '',
        })
    })
})

type Layout = 'basic' | 'composed'
type Pane = 'main' | 'elevation'
type Config = { layout: Layout; snapping: 'absolute' | 'relative'; division: number }

// Stage 1: pivot 0.25 plus a 0 to 8 translation over beats 0 to 8, whole lanes.
// Stage 2: pivot -4 on half lanes, raised 0.5.
// A (stage 1, beat 2) and B (stage 2, beat 3) are copied with B as the anchor.
// At beat 3: B, C (off the lattice), D (a slide's anchor) and an attached tick.
const seed = (page: Page, config: Config) =>
    page.evaluate(async (config) => {
        const { fixtures, show, view, settings, history } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const pivot = fixtures.events.stagePivotEvents[0]!
        const stage1 = base.stageId
        const stage2 = 2 as typeof base.stageId
        const transform = {
            rotation: 0,
            yTranslation: 0,
            elevation: 0,
            anchor: 'default' as const,
            eventEase: 'linear' as const,
        }
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                stagePivotEvents: [
                    { ...pivot, stageId: stage1, beat: 0, pivotLane: 0.25, divisionSize: 1 },
                    {
                        ...pivot,
                        stageId: stage2,
                        beat: 0,
                        pivotLane: -4,
                        divisionSize: 1,
                        divisionParity: 'odd',
                    },
                ],
                stageTransformEvents: [
                    { ...transform, stageId: stage1, beat: 0, xTranslation: 0 },
                    { ...transform, stageId: stage1, beat: 8, xTranslation: 8 },
                    { ...transform, stageId: stage2, beat: 0, xTranslation: 0, elevation: 0.5 },
                ],
                slides: [
                    [{ ...base, beat: 2, left: -2, size: 2, elevation: 1 }],
                    [{ ...base, stageId: stage2, beat: 3, left: 1, size: 2, elevation: 0 }],
                    [{ ...base, beat: 3, left: 4.3, size: 2, elevation: 0.5 }],
                    [
                        { ...base, beat: 1, left: -10, size: 2 },
                        { ...base, beat: 3, left: -10, size: 0.5, noteType: 'anchor' },
                        { ...base, beat: 5, left: -10, size: 2 },
                    ],
                    [
                        { ...base, beat: 2, left: 0, size: 2 },
                        { ...base, beat: 3, left: 0, size: 2, isAttached: true },
                        { ...base, beat: 4, left: 0, size: 2 },
                    ],
                ],
            },
            1.5,
        )
        view.layout = config.layout
        view.laneDivision = config.division
        view.laneSnapping = config.snapping
        settings.width = 28
        settings.maxScrollX = 0
        settings.elevationEditorSideBySide = 'allow'
        history.replaceState({ ...history.state.value, selectedEntities: [] })
    }, config)

const notes = (page: Page) =>
    page.evaluate(() =>
        [...window.editorTest.history.state.value.store.slides.note.values()]
            .flat()
            .map(({ beat, stageId, left, size, elevation, isAttached, noteType }) => ({
                beat,
                stageId,
                left,
                size,
                elevation,
                isAttached,
                noteType,
            }))
            .sort(
                (a, b) =>
                    a.beat - b.beat ||
                    a.stageId - b.stageId ||
                    a.left - b.left ||
                    a.elevation - b.elevation,
            ),
    )

const openAt = (page: Page, beat: number) =>
    page.evaluate(async (beat) => {
        const { appImport, nextTick } = window.editorTest
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(beat)
        await nextTick()
    }, beat)

// A displayed lane and elevation at the Elevation Editor's beat, on either pane.
const at = (page: Page, pane: Pane, lane: number, elevation: number) =>
    page.evaluate(
        async ({ pane, lane, elevation }) => {
            const { appImport, point } = window.editorTest
            const { elevationBeat } = await appImport<
                typeof import('../../src/editor/elevation/state')
            >('/src/editor/elevation/state.ts')
            if (pane === 'main') return point(lane, elevationBeat.value)
            const scene = await appImport<typeof import('../../src/editor/elevation/scene')>(
                '/src/editor/elevation/scene.ts',
            )
            const layout = scene.elevationLayout.value
            const box = document.querySelector('.elevation-canvas')!.getBoundingClientRect()
            return { x: box.x + layout.xAt(lane), y: box.y + layout.yAt(elevation) }
        },
        { pane, lane, elevation },
    )

// The displayed edges and elevation of the note shown at beat 3 with this authored left.
const shown = (page: Page, left: number) =>
    page.evaluate(async (left) => {
        const { appImport } = window.editorTest
        const scene = await appImport<typeof import('../../src/editor/elevation/scene')>(
            '/src/editor/elevation/scene.ts',
        )
        const row = scene.elevationNotes.value.find((row) => row.note.left === left)!
        return {
            left: row.lane - row.size / 2,
            right: row.lane + row.size / 2,
            elevation: row.elevation,
        }
    }, left)

const setup = (page: Page, tool: string, selection: number[] = [], stageId?: number) =>
    page.evaluate(
        async ({ tool, selection, stageId }) => {
            const { appImport, view, history } = window.editorTest
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo(tool as Parameters<typeof switchToolTo>[0])
            view.stageId = stageId as typeof view.stageId
            const all = [...history.state.value.store.slides.note.values()].flat()
            history.replaceState({
                ...history.state.value,
                selectedEntities: all.filter(
                    (note) => note.beat === 3 && selection.includes(note.left),
                ),
            })
        },
        { tool, selection, stageId },
    )

// Copies A and B with B, hovered on the chart, as the anchor.
const copyAnchoredOnB = async (page: Page) => {
    await openAt(page, 3)
    await page.evaluate(() => {
        const { history } = window.editorTest
        const all = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({
            ...history.state.value,
            selectedEntities: all.filter(
                (note) => (note.beat === 2 && note.left === -2) || note.stageId === 2,
            ),
        })
    })
    const b = await shown(page, 1)
    const point = await at(page, 'main', (b.left + b.right) / 2, 0)
    await page.mouse.move(point.x - 2, point.y)
    await page.mouse.move(point.x, point.y)
    await page.keyboard.press('c')
    const anchor = await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { clipboardEntry } =
            await appImport<typeof import('../../src/clipboard')>('/src/clipboard/index.ts')
        const paste = await appImport<typeof import('../../src/editor/tools/paste')>(
            '/src/editor/tools/paste/index.ts',
        )
        const data = clipboardEntry.value!.data!
        return paste.getPasteNoteEntities()[data.anchor!]!.stageId
    })
    expect(anchor).toBe(2)
}

const pasteAt =
    (lane: number, options: { beat?: number; shift?: boolean; stageId?: number } = {}) =>
    async (page: Page, pane: Pane) => {
        await openAt(page, options.beat ?? 3)
        await setup(page, 'paste', [], options.stageId)
        const point = await at(page, pane, lane, 2)
        await page.mouse.move(point.x - 2, point.y)
        await page.mouse.move(point.x, point.y)
        if (options.shift) await page.keyboard.down('Shift')
        await page.mouse.click(point.x, point.y)
        if (options.shift) await page.keyboard.up('Shift')
        // A paste reads the clipboard first.
        await expect.poll(async () => (await notes(page)).length).toBe(11)
    }

// Drags one selected note's edge by a number of lanes.
const resizeBy =
    (left: number, side: 'left' | 'right', by: number) => async (page: Page, pane: Pane) => {
        await openAt(page, 3)
        await setup(page, 'select', [1, 4.3, -10, 0])
        const note = await shown(page, left)
        const lane = side === 'left' ? note.left + 0.1 : note.right - 0.1
        const start = await at(page, pane, lane, note.elevation)
        const end = await at(page, pane, lane + by, note.elevation)
        await page.mouse.move(start.x, start.y - 2)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(end.x, end.y, { steps: 6 })
        await page.mouse.up()
    }

const gestures = {
    paste: pasteAt(8.3),
    pasteFlipped: pasteAt(8.3, { shift: true }),
    pasteIntoStage1: pasteAt(8.3, { stageId: 1 }),
    pasteLater: pasteAt(6.2, { beat: 5 }),
    resizeRight: resizeBy(4.3, 'right', 1.4),
    resizeLeft: resizeBy(1, 'left', -1.3),
    resizeNudge: resizeBy(1, 'left', 0.3),
    resizeShrink: resizeBy(1, 'left', 2.8),
}

// The chart has no elevation axis: compare everything else.
const lanes = (value: unknown) =>
    (value as Awaited<ReturnType<typeof notes>>).map(
        ({ beat, stageId, left, size, isAttached, noteType }) => ({
            beat,
            stageId,
            left,
            size,
            isAttached,
            noteType,
        }),
    )

const runGesture = async (page: Page, pane: Pane, run: (page: Page, pane: Pane) => unknown) => {
    const before = await notes(page)
    const undoable = await page.evaluate(() => window.editorTest.history.canUndo.value)
    await run(page, pane)
    await page.evaluate(() => window.editorTest.nextTick())
    const result = await notes(page)
    // One undo step, restored exactly.
    await page.evaluate(() => window.editorTest.history.undoState())
    expect(await notes(page)).toEqual(before)
    expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(undoable)
    return result
}

const configs: Config[] = [
    { layout: 'basic', snapping: 'absolute', division: 1 },
    { layout: 'basic', snapping: 'relative', division: 2 },
    { layout: 'composed', snapping: 'absolute', division: 1 },
    { layout: 'composed', snapping: 'relative', division: 2 },
]

for (const config of configs) {
    const name = `${config.layout}, ${config.snapping}, lane division ${config.division}`
    test(`${name}: Elevation Editor multi-note paste and resize match the chart`, async ({
        page,
    }) => {
        await seed(page, config)
        await copyAnchoredOnB(page)
        const main: Record<string, unknown> = {}
        const elevation: Record<string, unknown> = {}
        for (const [key, run] of Object.entries(gestures)) {
            main[key] = await runGesture(page, 'main', run)
            elevation[key] = await runGesture(page, 'elevation', run)
        }
        for (const key of Object.keys(gestures))
            expect([key, lanes(elevation[key])]).toEqual([key, lanes(main[key])])
        // The attached tick stays attached.
        for (const result of Object.values(elevation))
            expect(
                (result as Awaited<ReturnType<typeof notes>>).filter((note) => note.isAttached),
            ).toHaveLength(1)
    })
}

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: an Elevation Editor paste lands the clipboard anchor at the pointer's elevation`, async ({
        page,
    }) => {
        await seed(page, { layout, snapping: 'absolute', division: 1 })
        await copyAnchoredOnB(page)
        const before = await notes(page)
        await pasteAt(8.3)(page, 'elevation')
        const added = (await notes(page)).filter(
            (note) => !before.some((old) => JSON.stringify(old) === JSON.stringify(note)),
        )
        // B (stage 2, raised 0.5) lands at 2; A keeps its displayed offset 0.5 above B.
        expect(added.map(({ beat, stageId, elevation }) => ({ beat, stageId, elevation }))).toEqual(
            [
                { beat: 2, stageId: 1, elevation: 2.5 },
                { beat: 3, stageId: 2, elevation: 1.5 },
            ],
        )
        // B is centred on the pointer's lane.
        const b = added.find((note) => note.stageId === 2)!
        const shownB = await shown(page, b.left)
        expect((shownB.left + shownB.right) / 2).toBe(layout === 'basic' ? 8 : 8.5)
    })
}

test('composed: a multi-note resize moves every edge by the grabbed edge snap and lets an anchor reach zero width', async ({
    page,
}) => {
    await seed(page, { layout: 'composed', snapping: 'absolute', division: 1 })
    await resizeBy(1, 'left', 0.9)(page, 'elevation')
    const at3 = (await notes(page)).filter((note) => note.beat === 3)
    // B snaps to its half-lane lattice; off-lattice C takes the same delta;
    // anchor D reaches zero width; the attached tick is unchanged.
    expect(at3).toEqual([
        expect.objectContaining({ stageId: 1, left: -9.5, size: 0, noteType: 'anchor' }),
        expect.objectContaining({ stageId: 1, left: 0, size: 2, isAttached: true }),
        expect.objectContaining({ stageId: 1, left: 4.8, size: 1.5 }),
        expect.objectContaining({ stageId: 2, left: 1.5, size: 1.5 }),
    ])
})

test('Escape cancels a multi-note Elevation Editor resize', async ({ page }) => {
    await seed(page, { layout: 'composed', snapping: 'absolute', division: 1 })
    await openAt(page, 3)
    await setup(page, 'select', [1, 4.3])
    const before = await notes(page)
    const note = await shown(page, 4.3)
    const start = await at(page, 'elevation', note.right - 0.1, note.elevation)
    const end = await at(page, 'elevation', note.right + 1.5, note.elevation)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 6 })
    // The preview resizes both.
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { appImport } = window.editorTest
                const scene = await appImport<typeof import('../../src/editor/elevation/scene')>(
                    '/src/editor/elevation/scene.ts',
                )
                return scene.elevationNotes.value
                    .filter((row) => !row.attached && row.note.noteType !== 'anchor')
                    .map((row) => row.size)
            }),
        )
        .toEqual([3.7, 3.7])
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await notes(page)).toEqual(before)
    expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
})

test('full-pane Elevation Editor paste and resize match the side-by-side chart', async ({
    page,
}) => {
    const config = { layout: 'composed', snapping: 'absolute', division: 1 } as const
    await seed(page, config)
    await copyAnchoredOnB(page)
    const chosen = {
        paste: gestures.paste,
        pasteFlipped: gestures.pasteFlipped,
        resizeLeft: gestures.resizeLeft,
    }
    const main: Record<string, unknown> = {}
    for (const [key, run] of Object.entries(chosen)) main[key] = await runGesture(page, 'main', run)
    await page.evaluate(() => {
        window.editorTest.settings.elevationEditorSideBySide = 'disallow'
    })
    const elevation: Record<string, unknown> = {}
    for (const [key, run] of Object.entries(chosen)) {
        elevation[key] = await runGesture(page, 'elevation', run)
        await expect(page.locator('canvas.editor-chart')).toBeHidden()
    }
    for (const key of Object.keys(chosen))
        expect([key, lanes(elevation[key])]).toEqual([key, lanes(main[key])])
})

test.describe('with touch', () => {
    test.use({ hasTouch: true })

    test('a touch edge drag in the Elevation Editor resizes the whole selection', async ({
        page,
    }) => {
        await seed(page, { layout: 'composed', snapping: 'absolute', division: 1 })
        await openAt(page, 3)
        await setup(page, 'select', [1, 4.3])
        const client = await page.context().newCDPSession(page)
        const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: [number, number][]) =>
            client.send('Input.dispatchTouchEvent', {
                type,
                touchPoints: points.map(([x, y], id) => ({ x, y, id })),
            })
        // B, clear of the quick-scroll zone at the pane's right.
        const note = await shown(page, 1)
        const start = await at(page, 'elevation', note.left + 0.1, note.elevation)
        const end = await at(page, 'elevation', note.left - 1.2, note.elevation)
        await touch('touchStart', [[start.x, start.y]])
        for (let step = 1; step <= 6; step++)
            await touch('touchMove', [[start.x + ((end.x - start.x) * step) / 6, start.y]])
        await touch('touchEnd', [])
        await expect
            .poll(async () =>
                (await notes(page))
                    .filter((note) => note.beat === 3 && note.noteType === 'default')
                    .filter((note) => !note.isAttached)
                    .map(({ stageId, left, size }) => ({ stageId, left, size })),
            )
            .toEqual([
                { stageId: 1, left: 2.8, size: 3.5 },
                { stageId: 2, left: -0.5, size: 3.5 },
            ])
    })
})

test('a Beat field arrow step at a non-binary division stores the grid beat', async ({ page }) => {
    await seed(page, { layout: 'basic', snapping: 'absolute', division: 1 })
    await page.evaluate(() => {
        window.editorTest.view.division = 3
    })
    await openAt(page, 2)
    const field = page
        .locator('.elevation-editor')
        .getByRole('spinbutton', { name: 'Beat', exact: true })
    await field.focus()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    const beat = () =>
        page.evaluate(async () => {
            const { appImport } = window.editorTest
            const { elevationBeat } = await appImport<
                typeof import('../../src/editor/elevation/state')
            >('/src/editor/elevation/state.ts')
            return elevationBeat.value
        })
    await expect.poll(beat).toBe(7 / 3)
    // Typed beats off the grid stay as typed.
    await field.fill('3.5')
    await field.press('Enter')
    await expect.poll(beat).toBe(2.5)
    // A note added at the stepped beat takes the chart's grid beat.
    await field.fill('3')
    await field.press('Enter')
    await field.focus()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await expect.poll(beat).toBe(7 / 3)
    await setup(page, 'note')
    const point = await at(page, 'elevation', -12, 3)
    await page.mouse.click(point.x, point.y)
    await expect
        .poll(async () => (await notes(page)).filter((note) => note.beat === 7 / 3).length)
        .toBe(1)
})
