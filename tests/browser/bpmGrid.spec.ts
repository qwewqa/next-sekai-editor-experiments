import { expect, test, type Page } from '@playwright/test'
import type { BeatDisplay } from '../../src/editor/beatDisplay'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const pageErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    pageErrors.set(page, errors)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test.afterEach(({ page }) => {
    expect(pageErrors.get(page), 'uncaught browser errors').toEqual([])
})

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })

// Every change keeps the fixture's 120 BPM, so this maps beats across them.
const point = (page: Page, lane: number, beat: number) =>
    page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), { lane, beat })

const cursor = (page: Page) =>
    page.evaluate(() => getComputedStyle(document.querySelector('.editor')!).cursor)

const bpms = (page: Page) =>
    page.evaluate(() => window.editorTest.history.state.value.bpms.map(({ x }) => x))

const noteBeats = (page: Page) =>
    page.evaluate(() => window.editorTest.snapshot().notes.map(({ beat }) => beat))

const creating = (page: Page) =>
    page.evaluate(() => window.editorTest.view.entities.creating.map(({ beat }) => beat))

const switchTool = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const { switchToolTo } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools')
        >('/src/editor/tools/index.ts')
        switchToolTo(name as never)
    }, name)

const grids = (page: Page) =>
    page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { liftedBpms } =
            await appImport<typeof import('../../src/editor/beatGrid')>('/src/editor/beatGrid.ts')
        const { drawnBpms } = await appImport<typeof import('../../src/editor/sceneState')>(
            '/src/editor/sceneState.ts',
        )
        return {
            lifted: liftedBpms.value?.map(({ x }) => x),
            drawn: drawnBpms.value.map(({ x }) => x),
        }
    })

// A change at 2.5, off the whole-beat grid: bars at 0, 2.5 and 6.5, at 1/1 snapping.
const setUp = async (
    page: Page,
    display: BeatDisplay,
    changes = [0, 2.5],
    layout: 'basic' | 'composed' = 'basic',
) => {
    await page.evaluate(
        ({ display, changes, layout }) => {
            const { fixtures, show, view, settings } = window.editorTest
            const pivot = fixtures.events.stagePivotEvents[0]!
            const bpms = changes.map((beat) => ({ beat, bpm: 120 }))
            show(
                layout === 'composed'
                    ? {
                          ...fixtures.interaction,
                          bpms,
                          isDynamicStages: true,
                          stagePivotEvents: [{ ...pivot, beat: 0, pivotLane: 2 }],
                      }
                    : { ...fixtures.interaction, bpms },
                2,
            )
            view.layout = layout
            view.division = 1
            settings.pps = 200
            settings.beatDisplay = display
        },
        { display, changes, layout },
    )
    await settle(page)
}

const drag = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await settle(page)
    await page.mouse.up()
    await settle(page)
}

for (const display of ['measure', 'both', 'beat'] as const)
    test(`${display}: placing snaps to the ${display === 'beat' ? 'global' : 'bar'} grid`, async ({
        page,
    }) => {
        await setUp(page, display)
        await switchTool(page, 'note')
        const bars = display !== 'beat'
        for (const [beat, expected] of [
            [2.2, 2],
            [2.3, bars ? 2.5 : 2],
            [3.4, bars ? 3.5 : 3],
            [4.4, bars ? 4.5 : 4],
        ] as const) {
            const at = await point(page, -5.5, beat)
            await page.mouse.move(at.x, at.y)
            await settle(page)
            expect(await creating(page), `${beat}`).toEqual([expected])
        }
        const at = await point(page, -5.5, 3.4)
        await page.mouse.click(at.x, at.y)
        await settle(page)
        expect(await noteBeats(page)).toContain(bars ? 3.5 : 3)
    })

for (const display of ['measure', 'beat'] as const)
    test(`${display}: a Select move lands on the grid after the wait; relative keeps the phase`, async ({
        page,
    }) => {
        await setUp(page, display)
        await switchTool(page, 'select')
        // The note at 5, grabbed on its line.
        await drag(page, await point(page, 1, 5), await point(page, 1, 5.3))
        expect(await noteBeats(page)).toEqual([3, 5, 7, 9])
        await drag(page, await point(page, 1, 5), await point(page, 1, 6.2))
        expect(await noteBeats(page)).toEqual([3, display === 'beat' ? 6 : 6.5, 7, 9])
        await page.keyboard.press('Control+z')
        await page.evaluate(() => {
            window.editorTest.view.snapping = 'relative'
        })
        await drag(page, await point(page, 1, 5), await point(page, 1, 6.2))
        expect(await noteBeats(page)).toEqual([3, 6, 7, 9])
    })

test('the drawn lines and labels are the snap targets', async ({ page }) => {
    await setUp(page, 'measure')
    const drawn = async () =>
        page.evaluate(async () => {
            const { appImport, history, view } = window.editorTest
            const { drawGrid, gridLabels } = await appImport<
                typeof import('../../src/editor/canvas/grid')
            >('/src/editor/canvas/grid.ts')
            const { drawnGrid } = await appImport<typeof import('../../src/editor/sceneState')>(
                '/src/editor/sceneState.ts',
            )
            const { snapGrid } =
                await appImport<typeof import('../../src/editor/beatGrid')>(
                    '/src/editor/beatGrid.ts',
                )
            const { snapBeat } = await appImport<typeof import('../../src/state/integrals/grid')>(
                '/src/state/integrals/grid.ts',
            )
            const { settings } = window.editorTest
            const ctx = document.createElement('canvas').getContext('2d')!
            let positions: number[] = []
            const strokes: { alpha: number; width: number; beats: number[] }[] = []
            ctx.beginPath = () => {
                positions = []
            }
            ctx.moveTo = (_x, y) => {
                positions.push(y)
            }
            ctx.stroke = () => {
                strokes.push({
                    alpha: ctx.globalAlpha,
                    width: ctx.lineWidth,
                    // At 120 BPM and one unit a second, a beat is y × 2.
                    beats: positions.map((y) => Math.round(y * 2 * 1e9) / 1e9),
                })
            }
            const context = {
                ctx,
                scale: 20,
                pixelRatio: 1,
                bounds: { l: -8, r: 8, t: 10, b: 0, w: 16, h: 10 },
                ups: 1,
                state: history.state.value,
                defaultGroupId: undefined,
                showStageName: false,
                showGroupName: false,
                nameContrast: false,
                recentlyActive: false,
                fontFamily: 'sans-serif',
                fontMiddle: 0.25,
                figureMiddle: 0.35,
            }
            const beats = { min: 0, max: 8 }
            const times = { min: 0, max: 4 }
            const labels = gridLabels(
                history.state.value,
                4,
                20,
                beats,
                times,
                settings.beatDisplay,
                drawnGrid.value,
            )
            drawGrid(
                context,
                beats,
                times,
                view.division,
                1,
                settings.beatDisplay,
                false,
                undefined,
                labels,
                drawnGrid.value,
            )
            const lines = strokes
                .filter((stroke) => Math.abs(stroke.width - 0.1) < 1e-6)
                .filter((stroke) => stroke.beats.every((beat) => beat >= 0 && beat <= 8))
                .slice(-2)
            return {
                division: lines[0]!.beats,
                beat: lines[1]!.beats,
                bars: strokes.find((stroke) => Math.abs(stroke.width - 0.15) < 1e-6)?.beats,
                labels: labels.right.map(({ text }) => text),
                snapped: [...lines[0]!.beats, ...lines[1]!.beats].every(
                    (beat) => snapBeat(snapGrid.value, beat, view.division) === beat,
                ),
            }
        })
    expect(await drawn()).toEqual({
        division: [],
        beat: [0, 1, 2, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5],
        bars: [0, 2.5, 6.5],
        labels: ['1.2', '1.3', '2.1', '2.2', '2.3', '2.4', '3.1', '3.2'],
        snapped: true,
    })
    await page.evaluate(() => {
        window.editorTest.settings.beatDisplay = 'beat'
    })
    expect(await drawn()).toEqual({
        division: [],
        beat: [0, 1, 2, 3, 4, 5, 6, 7, 8],
        bars: undefined,
        labels: ['2', '3', '4', '5', '6', '7', '8', '9'],
        snapped: true,
    })
})

test('a dense tempo ramp keeps drawing thinned lines and clear labels', async ({ page }) => {
    // A change every 1/16 beat from 4 to 8, at 1/4 snapping.
    const ramp = [0, ...Array.from({ length: 64 }, (_, i) => 4 + i / 16)]
    await setUp(page, 'measure', ramp)
    const result = await page.evaluate(async () => {
        const { appImport, history } = window.editorTest
        const { drawGrid, gridLabels } = await appImport<
            typeof import('../../src/editor/canvas/grid')
        >('/src/editor/canvas/grid.ts')
        const { drawnGrid } = await appImport<typeof import('../../src/editor/sceneState')>(
            '/src/editor/sceneState.ts',
        )
        const ctx = document.createElement('canvas').getContext('2d')!
        let positions: number[] = []
        const strokes: { width: number; ys: number[] }[] = []
        ctx.beginPath = () => {
            positions = []
        }
        ctx.moveTo = (_x, y) => {
            positions.push(y)
        }
        ctx.stroke = () => {
            strokes.push({ width: ctx.lineWidth, ys: positions })
        }
        const scale = 20
        const ups = 2
        const context = {
            ctx,
            scale,
            pixelRatio: 1,
            bounds: { l: -8, r: 8, t: 20, b: 0, w: 16, h: 20 },
            ups,
            state: history.state.value,
            defaultGroupId: undefined,
            showStageName: false,
            showGroupName: false,
            nameContrast: false,
            recentlyActive: false,
            fontFamily: 'sans-serif',
            fontMiddle: 0.25,
            figureMiddle: 0.35,
        }
        const beats = { min: 0, max: 12 }
        const times = { min: 0, max: 6 }
        const labels = gridLabels(
            history.state.value,
            ups,
            scale,
            beats,
            times,
            'measure',
            drawnGrid.value,
        )
        drawGrid(context, beats, times, 4, 1, 'measure', false, undefined, labels, drawnGrid.value)
        const ys = strokes
            .filter((stroke) => Math.abs(stroke.width - 2 / scale) < 1e-6)
            .slice(-2)
            .flatMap((stroke) => stroke.ys)
            .sort((a, b) => a - b)
        const gaps = ys.slice(1).map((y, index) => (y - ys[index]!) * scale)
        const labelYs = labels.right.map(({ y }) => y)
        return {
            lines: ys.length,
            inRamp: ys.filter((y) => y / ups > 2 && y / ups < 4).length,
            minGap: Math.min(...gaps),
            minLabelGap: Math.min(...labelYs.slice(1).map((y, index) => y - labelYs[index]!)),
        }
    })
    expect(result.lines).toBeGreaterThan(20)
    expect(result.inRamp).toBeGreaterThan(5)
    expect(result.minGap).toBeGreaterThanOrEqual(2 - 1e-6)
    expect(result.minLabelGap).toBeGreaterThanOrEqual(0.45 - 1e-9)
})

test('switching the beat display re-snaps the hover under a still mouse', async ({ page }) => {
    await setUp(page, 'measure')
    await switchTool(page, 'note')
    const at = await point(page, -5.5, 3.4)
    await page.mouse.move(at.x, at.y)
    await settle(page)
    expect(await creating(page)).toEqual([3.5])
    for (const [display, expected] of [
        ['beat', 3],
        ['both', 3.5],
        ['beat', 3],
        ['measure', 3.5],
    ] as const) {
        await page.evaluate((display) => {
            window.editorTest.settings.beatDisplay = display
        }, display)
        await settle(page)
        expect(await creating(page), display).toEqual([expected])
    }
})

for (const display of ['measure', 'beat'] as const)
    test(`${display}: the BPM tool grabs an off-grid change within its snapping`, async ({
        page,
    }) => {
        await setUp(page, display)
        await page.keyboard.press('q')
        const at = await point(page, -4, 2.95)
        await page.mouse.move(at.x, at.y)
        await settle(page)
        expect(await cursor(page)).toBe(display === 'beat' ? 'crosshair' : 'ns-resize')
    })

test('a dragged BPM change snaps to the grid without it, and drops it on cancel', async ({
    page,
}) => {
    await setUp(page, 'measure')
    await page.keyboard.press('q')
    const from = await point(page, -4, 2.5)

    // Later: whole beats, not its own 3.5.
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // Within the wait it hasn't moved, so the bars stay.
    const near = await point(page, -4, 2.75)
    await page.mouse.move(near.x, near.y, { steps: 3 })
    await settle(page)
    expect(await grids(page)).toEqual({ lifted: [0], drawn: [0, 2.5] })
    const to = await point(page, -4, 3.3)
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await settle(page)
    expect(await creating(page)).toEqual([3])
    expect(await grids(page)).toEqual({ lifted: [0], drawn: [0] })
    await page.mouse.up()
    await settle(page)
    expect(await bpms(page)).toEqual([0, 3])
    expect(await grids(page)).toEqual({ lifted: undefined, drawn: [0, 3] })
    await page.keyboard.press('Control+z')
    await settle(page)
    expect(await bpms(page)).toEqual([0, 2.5])

    // Earlier: the previous bar's beats.
    await drag(page, from, await point(page, -4, 1.8))
    expect(await bpms(page)).toEqual([0, 2])
    await page.keyboard.press('Control+z')
    await settle(page)

    // Escape and blur cancel; the next hover snaps to the chart's grid again.
    for (const cancel of ['Escape', 'blur'] as const) {
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        const to = await point(page, -4, 4.3)
        await page.mouse.move(to.x, to.y, { steps: 6 })
        await settle(page)
        expect(await grids(page)).toEqual({ lifted: [0], drawn: [0] })
        if (cancel === 'Escape') await page.keyboard.press('Escape')
        else await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        await page.mouse.up()
        await settle(page)
        expect(await bpms(page), cancel).toEqual([0, 2.5])
        expect(await grids(page), cancel).toEqual({ lifted: undefined, drawn: [0, 2.5] })
        await switchTool(page, 'note')
        const at = await point(page, -5.5, 3.4)
        await page.mouse.move(at.x, at.y)
        await settle(page)
        expect(await creating(page), cancel).toEqual([3.5])
        await page.keyboard.press('q')
    }
})

test('a Select move of a BPM change and its notes snaps to the grid without it', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, view, settings } = window.editorTest
        const [[head]] = fixtures.interaction.slides as [[object]]
        show(
            {
                ...fixtures.interaction,
                bpms: [
                    { beat: 0, bpm: 120 },
                    { beat: 2.5, bpm: 120 },
                ],
                slides: [[{ ...head, beat: 3.5, left: -4 }], [{ ...head, beat: 4.5, left: 0 }]],
            } as never,
            2,
        )
        view.division = 1
        settings.pps = 200
        settings.beatDisplay = 'measure'
        const { history } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.grid.bpm.values()]
                .flatMap((set) => [...set])
                .filter(({ beat }) => beat === 2.5)
                .concat(
                    [...window.editorTest.store.getAllEntities()].filter(
                        (e) => e.type === 'note',
                    ) as never,
                ),
        })
    })
    await settle(page)
    await switchTool(page, 'select')
    // Grabbed by its note at 3.5 and dropped near 5.3: whole beats, so the block moves by 1.5.
    await drag(page, await point(page, -3, 3.5), await point(page, -3, 5.3))
    expect(await bpms(page)).toEqual([0, 4])
    expect(await noteBeats(page)).toEqual([5, 6])
})

test('a scaling translate of a BPM change and its notes snaps to the grid without it', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, view, settings } = window.editorTest
        const [[head]] = fixtures.interaction.slides as [[object]]
        show(
            {
                ...fixtures.interaction,
                bpms: [
                    { beat: 0, bpm: 120 },
                    { beat: 2.5, bpm: 120 },
                ],
                slides: [[{ ...head, beat: 3.5, left: -4 }], [{ ...head, beat: 4.5, left: 0 }]],
            } as never,
            2,
        )
        view.division = 1
        settings.pps = 200
        settings.beatDisplay = 'measure'
        const { history } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.grid.bpm.values()]
                .flatMap((set) => [...set])
                .filter(({ beat }) => beat === 2.5)
                .concat(
                    [...window.editorTest.store.getAllEntities()].filter(
                        (e) => e.type === 'note',
                    ) as never,
                ),
        })
    })
    await settle(page)
    const from = await point(page, -3, 3.45)
    await page.mouse.move(from.x, from.y)
    await page.evaluate(async () => {
        const { scaleBeat } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/scaleSelection')
        >('/src/editor/commands/scaleSelection/index.ts')
        void scaleBeat.execute()
    })
    await expect(page.locator('.scaling-panel')).toBeVisible()
    const draft = () =>
        page.evaluate(async () => {
            const { history, appImport } = window.editorTest
            const { getPreviewState } =
                await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
            const state = getPreviewState(history.state.value)
            return {
                bpms: state.bpms.map(({ x }) => x),
                notes: [...state.store.slides.note.values()]
                    .flat()
                    .map(({ beat }) => beat)
                    .sort((a, b) => a - b),
            }
        })
    // Without the lift, 2.2 would snap to 2 against 3.5 and shift the block by 1.5.
    await drag(page, from, await point(page, -3, 2.2))
    expect(await draft()).toEqual({ bpms: [0, 1.5], notes: [2.5, 3.5] })
    expect(await grids(page)).toEqual({ lifted: undefined, drawn: [0, 1.5] })
})

test('Escape mid-scaling restores the draft and drops the lift', async ({ page }) => {
    await setUp(page, 'measure')
    await page.evaluate(() => {
        const { history } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [
                ...[...history.state.value.store.grid.bpm.values()]
                    .flatMap((set) => [...set])
                    .filter(({ beat }) => beat === 2.5),
                ...[...window.editorTest.store.getAllEntities()].filter((e) => e.type === 'note'),
            ] as never,
        })
    })
    const from = await point(page, -3, 3)
    await page.mouse.move(from.x, from.y)
    await page.evaluate(async () => {
        const { scaleBeat } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/scaleSelection')
        >('/src/editor/commands/scaleSelection/index.ts')
        void scaleBeat.execute()
    })
    await expect(page.locator('.scaling-panel')).toBeVisible()
    const session = () =>
        page.evaluate(async () => {
            const { scalingSession } = await window.editorTest.appImport<
                typeof import('../../src/editor/commands/scaleSelection/session')
            >('/src/editor/commands/scaleSelection/session.ts')
            const { factor, requestedFactor, valid } = scalingSession.value!
            return { factor, requestedFactor, valid }
        })
    const before = await session()
    await page.mouse.down()
    const to = await point(page, -3, 4.2)
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await settle(page)
    expect((await grids(page)).lifted).toEqual([0])
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await settle(page)
    expect(await session()).toEqual(before)
    expect((await grids(page)).lifted).toBeUndefined()
})

test('the Elevation Editor steps through the bar grid', async ({ page }) => {
    await setUp(page, 'measure')
    await page.keyboard.press('t')
    const beat = page.getByRole('spinbutton', { name: 'Beat', exact: true })
    const next = page.getByRole('button', { name: 'Next Beat', exact: true })
    const previous = page.getByRole('button', { name: 'Previous Beat', exact: true })
    const elevationBeat = () =>
        page.evaluate(
            async () =>
                (
                    await window.editorTest.appImport<
                        typeof import('../../src/editor/elevation/state')
                    >('/src/editor/elevation/state.ts')
                ).elevationBeat.value,
        )
    await beat.fill('3')
    await beat.press('Tab')
    expect(await elevationBeat()).toBe(2)
    const steps: number[] = []
    for (const button of [next, next, previous, previous]) {
        await button.click()
        steps.push(await elevationBeat())
    }
    expect(steps).toEqual([2.5, 3.5, 2.5, 2])
    // Arrow keys in the field take the same steps, never the global 3.
    await beat.focus()
    await beat.press('ArrowUp')
    expect(await elevationBeat()).toBe(2.5)
    await beat.press('ArrowUp')
    expect(await elevationBeat()).toBe(3.5)
    await beat.press('ArrowDown')
    expect(await elevationBeat()).toBe(2.5)
    // Typed noise stores the line.
    await beat.fill('4.4999999')
    await beat.press('Tab')
    expect(await elevationBeat()).toBe(3.5)

    // The beat display keeps the native step.
    await page.evaluate(() => {
        window.editorTest.settings.beatDisplay = 'beat'
    })
    await beat.fill('3')
    await beat.press('Tab')
    await beat.focus()
    await beat.press('ArrowUp')
    await beat.press('Tab')
    expect(await elevationBeat()).toBe(3)
    expect(await beat.getAttribute('step')).toBe('1')
})

for (const display of ['measure', 'beat'] as const)
    test(`${display}: Generate Slide Notes fills the grid's lines`, async ({ page }) => {
        await page.evaluate((display) => {
            const { fixtures, show, view, settings } = window.editorTest
            const [[head]] = fixtures.interaction.slides as [[object]]
            show(
                {
                    ...fixtures.interaction,
                    bpms: [
                        { beat: 0, bpm: 120 },
                        { beat: 2.5, bpm: 120 },
                    ],
                    slides: [
                        [
                            { ...head, beat: 1 },
                            { ...head, beat: 5 },
                        ],
                    ],
                } as never,
                2,
            )
            view.division = 1
            settings.pps = 200
            settings.beatDisplay = display
        }, display)
        const beats = await page.evaluate(async () => {
            const { appImport, store } = window.editorTest
            const { applyGeneratedSlideNotes } = await appImport<
                typeof import('../../src/editor/tools/generateSlideNotes')
            >('/src/editor/tools/generateSlideNotes/index.ts')
            const notes = [...store.getAllEntities()].filter((entity) => entity.type === 'note')
            applyGeneratedSlideNotes(notes as never)
            return window.editorTest.snapshot().notes.map(({ beat }) => beat)
        })
        expect(beats).toEqual(display === 'beat' ? [1, 2, 3, 4, 5] : [1, 2, 2.5, 3.5, 4.5, 5])
    })

for (const display of ['measure', 'beat'] as const)
    test(`${display}: a context-menu paste lands on the grid`, async ({ page }) => {
        await setUp(page, display)
        const at = await point(page, -5.5, 3.4)
        const beats = await page.evaluate(async (at) => {
            const { appImport, history, store } = window.editorTest
            const { pasteAtContextPosition } = await appImport<
                typeof import('../../src/editor/contextMenuPaste')
            >('/src/editor/contextMenuPaste.ts')
            const { copy } = await appImport<typeof import('../../src/editor/commands/copy')>(
                '/src/editor/commands/copy/index.ts',
            )
            Object.defineProperty(navigator.clipboard, 'writeText', {
                configurable: true,
                value: async () => undefined,
            })
            Object.defineProperty(navigator.clipboard, 'readText', {
                configurable: true,
                value: async () => {
                    throw new DOMException('Clipboard denied', 'NotAllowedError')
                },
            })
            const note = [...store.getAllEntities()].find(
                (entity) => entity.type === 'note' && entity.beat === 5,
            )!
            history.replaceState({ ...history.state.value, selectedEntities: [note] })
            copy.execute()
            await pasteAtContextPosition(at.x, at.y)
            return window.editorTest.snapshot().notes.map(({ beat }) => beat)
        }, at)
        expect(beats).toEqual(display === 'beat' ? [3, 3, 5, 7, 9] : [3, 3.5, 5, 7, 9])
    })

test('switching the beat display dismisses the context menu', async ({ page }) => {
    await setUp(page, 'measure')
    const at = await point(page, -5.5, 3.4)
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    await page.evaluate(() => {
        window.editorTest.settings.beatDisplay = 'beat'
    })
    await expect(page.getByRole('menu')).toHaveCount(0)
})

test('composed: placing and dragging a BPM change use the bar grid', async ({ page }) => {
    await setUp(page, 'measure', [0, 2.5], 'composed')
    await switchTool(page, 'note')
    for (const [beat, expected] of [
        [2.3, 2.5],
        [3.4, 3.5],
    ] as const) {
        const at = await point(page, -5.5, beat)
        await page.mouse.move(at.x, at.y)
        await settle(page)
        expect(await creating(page), `${beat}`).toEqual([expected])
    }
    await page.keyboard.press('q')
    await settle(page)
    const from = await point(page, -4, 2.5)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    const to = await point(page, -4, 3.3)
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await settle(page)
    expect(await creating(page)).toEqual([3])
    expect(await grids(page)).toEqual({ lifted: [0], drawn: [0] })
    await page.mouse.up()
    await settle(page)
    expect(await bpms(page)).toEqual([0, 3])
    expect(await grids(page)).toEqual({ lifted: undefined, drawn: [0, 3] })
})

test('the wheel on a focused Elevation Editor beat field steps through the bar grid', async ({
    page,
}) => {
    await setUp(page, 'measure')
    await page.keyboard.press('t')
    const beat = page.getByRole('spinbutton', { name: 'Beat', exact: true })
    await beat.fill('3')
    await beat.press('Tab')
    await beat.focus()
    const box = (await beat.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -100)
    await settle(page)
    await beat.press('Tab')
    expect(
        await page.evaluate(
            async () =>
                (
                    await window.editorTest.appImport<
                        typeof import('../../src/editor/elevation/state')
                    >('/src/editor/elevation/state.ts')
                ).elevationBeat.value,
        ),
    ).toBe(2.5)
})

test('a scaling drag from an end lifts the moving changes but not the anchor', async ({ page }) => {
    await page.evaluate(() => {
        const { fixtures, show, view, settings, history } = window.editorTest
        const [[head]] = fixtures.interaction.slides as [[object]]
        show(
            {
                ...fixtures.interaction,
                bpms: [0, 2.5, 4.75].map((beat) => ({ beat, bpm: 120 })),
                slides: [[{ ...head, beat: 6.75, left: -4 }]],
            } as never,
            2,
        )
        view.division = 1
        settings.pps = 200
        settings.beatDisplay = 'measure'
        history.replaceState({
            ...history.state.value,
            selectedEntities: [
                ...[...history.state.value.store.grid.bpm.values()]
                    .flatMap((set) => [...set])
                    .filter(({ beat }) => beat > 0),
                ...[...window.editorTest.store.getAllEntities()].filter((e) => e.type === 'note'),
            ] as never,
        })
    })
    await settle(page)
    // The note at 6.75 is the end; the change at 2.5 is the anchor and stays.
    const from = await point(page, -3, 6.75)
    await page.mouse.move(from.x, from.y)
    await page.evaluate(async () => {
        const { scaleBeat } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/scaleSelection')
        >('/src/editor/commands/scaleSelection/index.ts')
        void scaleBeat.execute()
    })
    await expect(page.locator('.scaling-panel')).toBeVisible()
    await page.mouse.down()
    const to = await point(page, -3, 8.6)
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await settle(page)
    expect((await grids(page)).lifted).toEqual([0, 2.5])
    await page.mouse.up()
    await settle(page)
    expect((await grids(page)).lifted).toBeUndefined()
})

test('switching the beat display moves a Composed paste ghost under a still mouse', async ({
    page,
}) => {
    await setUp(page, 'measure', [0, 2.5], 'composed')
    await page.evaluate(async () => {
        const { appImport, history, store } = window.editorTest
        const { copy } = await appImport<typeof import('../../src/editor/commands/copy')>(
            '/src/editor/commands/copy/index.ts',
        )
        Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async () => undefined,
        })
        const note = [...store.getAllEntities()].find(
            (entity) => entity.type === 'note' && entity.beat === 5,
        )!
        history.replaceState({ ...history.state.value, selectedEntities: [note] })
        copy.execute()
    })
    await switchTool(page, 'paste')
    const at = await point(page, -5.5, 3.4)
    await page.mouse.move(at.x, at.y)
    await settle(page)
    expect(await creating(page)).toEqual([3.5])
    for (const [display, expected] of [
        ['beat', 3],
        ['measure', 3.5],
    ] as const) {
        await page.evaluate((display) => {
            window.editorTest.settings.beatDisplay = display
        }, display)
        await settle(page)
        expect(await creating(page), display).toEqual([expected])
    }
})

test('Elevation Editor arrows on the bar grid step from a typed beat', async ({ page }) => {
    await setUp(page, 'measure')
    await page.keyboard.press('t')
    const beat = page.getByRole('spinbutton', { name: 'Beat', exact: true })
    await beat.fill('3')
    await beat.press('Tab')
    // Typed, not committed: 3.5 steps to 4.5, not 2 to 2.5.
    await beat.fill('4.5')
    await beat.press('ArrowUp')
    expect(
        await page.evaluate(
            async () =>
                (
                    await window.editorTest.appImport<
                        typeof import('../../src/editor/elevation/state')
                    >('/src/editor/elevation/state.ts')
                ).elevationBeat.value,
        ),
    ).toBe(4.5)
    await expect(beat).toHaveValue('5.5')
})
