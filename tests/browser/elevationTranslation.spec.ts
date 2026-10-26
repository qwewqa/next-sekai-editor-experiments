import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// Stage 1 is offset 6 lanes by pivot 2 and translation 4; stage 2 by pivot -4.
const run = (page: import('@playwright/test').Page, dynamic: boolean) =>
    page.evaluate(async (dynamic) => {
        const { fixtures, show, view, history, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const pivot = fixtures.events.stagePivotEvents[0]!
        const stage1 = base.stageId
        const stage2 = 2 as typeof base.stageId
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: dynamic,
                stagePivotEvents: [
                    { ...pivot, stageId: stage1, beat: 0, pivotLane: 2 },
                    { ...pivot, stageId: stage2, beat: 0, pivotLane: -4 },
                ],
                stageTransformEvents: [
                    {
                        stageId: stage1,
                        beat: 0,
                        rotation: 0,
                        xTranslation: 4,
                        yTranslation: 0,
                        elevation: 0,
                        anchor: 'default',
                        eventEase: 'linear',
                    },
                ],
                slides: [
                    [{ ...base, beat: 4, left: -2, size: 2 }],
                    [{ ...base, stageId: stage2, beat: 4, left: 2, size: 2 }],
                ],
            },
            2,
        )
        const [first] = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({ ...history.state.value, selectedEntities: [first!] })
        const { copy } = await appImport<typeof import('../../src/editor/commands/copy')>(
            '/src/editor/commands/copy/index.ts',
        )
        copy.execute()
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        const scene = await appImport<typeof import('../../src/editor/elevation/scene')>(
            '/src/editor/elevation/scene.ts',
        )
        const actions = await appImport<typeof import('../../src/editor/elevation/actions')>(
            '/src/editor/elevation/actions.ts',
        )
        const { getComposedNoteOffset } = await appImport<
            typeof import('../../src/editor/composedView')
        >('/src/editor/composedView.ts')
        openElevationEditor(4)
        // The editor stays open while the layout switches.
        const sample = (layout: 'basic' | 'composed') => {
            view.layout = layout
            const shown = (
                note: { left: number; size: number } & Parameters<typeof getComposedNoteOffset>[0],
            ) => note.left + getComposedNoteOffset(note)
            const lanes = scene.elevationNotes.value.map(({ note, lane, size }) => ({
                lane,
                size,
                chart: shown(note) + note.size / 2,
            }))
            view.stageId = stage1
            const added = actions.previewElevationNote(7, 0.5, 4, false)
            const pasted = actions.previewElevationPaste(7, 0.5, 4, {
                ctrl: false,
                shift: false,
            }).notes
            view.stageId = undefined
            return {
                lanes,
                added: { left: added.left, shown: shown(added) },
                pasted: pasted.map((note) => ({ left: note.left, shown: shown(note) })),
            }
        }
        return { composed: sample('composed'), basic: sample('basic'), again: sample('composed') }
    }, dynamic)

test('Elevation Editor lanes follow the chart layout, switching live', async ({ page }) => {
    const result = await run(page, true)
    // Composed: the composed lanes, as on the chart beside it.
    expect(result.composed.lanes).toEqual([
        { lane: 5, size: 2, chart: 5 },
        { lane: -1, size: 2, chart: -1 },
    ])
    expect(result.composed.added).toEqual({ left: 1, shown: 7 })
    // Basic: authored lanes, with no stage offsets.
    expect(result.basic.lanes).toEqual([
        { lane: -1, size: 2, chart: -1 },
        { lane: 3, size: 2, chart: 3 },
    ])
    expect(result.basic.added).toEqual({ left: 7, shown: 7 })
    // A paste lands under the pointer in either layout; data stays authored.
    expect(result.basic.pasted.map(({ shown }) => shown)).toEqual(
        result.composed.pasted.map(({ shown }) => shown),
    )
    expect(result.composed.pasted.map(({ left, shown }) => shown - left)).toEqual([6])
    expect(result.again).toEqual(result.composed)
})

test('without dynamic stages Elevation Editor lanes are authored in both layouts', async ({
    page,
}) => {
    const result = await run(page, false)
    for (const sample of [result.composed, result.basic]) {
        expect(sample.lanes).toEqual([
            { lane: -1, size: 2, chart: -1 },
            { lane: 3, size: 2, chart: 3 },
        ])
        expect(sample.added).toEqual({ left: 7, shown: 7 })
    }
})

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: width scaling in the Elevation Editor matches the same drag on the chart`, async ({
        page,
    }) => {
        const drag = async (pane: 'main' | 'elevation') => {
            await page.evaluate(
                async ({ layout }) => {
                    const { fixtures, show, view, settings, history, appImport } = window.editorTest
                    const base = fixtures.interaction.slides[0]![0]!
                    const pivot = fixtures.events.stagePivotEvents[0]!
                    show(
                        {
                            ...fixtures.interaction,
                            isDynamicStages: true,
                            stagePivotEvents: [{ ...pivot, beat: 0, pivotLane: 2.5 }],
                            stageTransformEvents: [
                                {
                                    stageId: base.stageId,
                                    beat: 0,
                                    rotation: 0,
                                    xTranslation: 1,
                                    yTranslation: 0,
                                    elevation: 0,
                                    anchor: 'default',
                                    eventEase: 'linear',
                                },
                            ],
                            slides: [[{ ...base, beat: 4, left: -2, size: 2, elevation: 3 }]],
                        },
                        2,
                    )
                    view.layout = layout
                    view.laneDivision = 1
                    view.laneSnapping = 'absolute'
                    settings.maxLane = 0
                    settings.elevationEditorSideBySide = 'allow'
                    history.replaceState({
                        ...history.state.value,
                        selectedEntities: [
                            ...history.state.value.store.slides.note.values(),
                        ].flat(),
                    })
                    const { openElevationEditor } = await appImport<
                        typeof import('../../src/editor/elevation/state')
                    >('/src/editor/elevation/state.ts')
                    openElevationEditor(4)
                },
                { layout },
            )
            await expect(page.locator('.elevation-canvas')).toBeVisible()
            await page.evaluate(async () => {
                const { scaleWidth } = await window.editorTest.appImport<
                    typeof import('../../src/editor/commands/scaleSelection')
                >('/src/editor/commands/scaleSelection/index.ts')
                void scaleWidth.execute()
            })
            await expect(page.locator('.scaling-panel')).toBeVisible()
            // The chart has taken the width the two panes leave it, and the view has measured it.
            await expect
                .poll(() =>
                    page.evaluate(() => {
                        const chart = document
                            .querySelector('canvas.editor-chart')!
                            .getBoundingClientRect()
                        const pane = document
                            .querySelector('.elevation-canvas')!
                            .getBoundingClientRect()
                        return window.editorTest.view.w === chart.width && chart.right <= pane.left
                    }),
                )
                .toBe(true)
            // Grab the right edge where it is shown; the stage's half-lane offset makes snapping differ.
            const points = await page.evaluate(async (pane) => {
                const { appImport, point, history } = window.editorTest
                const note = [...history.state.value.store.slides.note.values()].flat()[0]!
                const { getComposedNoteOffset } = await appImport<
                    typeof import('../../src/editor/composedView')
                >('/src/editor/composedView.ts')
                const edge = note.left + note.size + getComposedNoteOffset(note) - 0.1
                if (pane === 'main') return [point(edge, 4), point(edge + 1.7, 4)]
                const scene = await appImport<typeof import('../../src/editor/elevation/scene')>(
                    '/src/editor/elevation/scene.ts',
                )
                const layout = scene.elevationLayout.value
                const box = document.querySelector('.elevation-canvas')!.getBoundingClientRect()
                const y = box.y + layout.rows[0]!.y
                return [
                    { x: box.x + layout.xAt(edge), y },
                    { x: box.x + layout.xAt(edge + 1.7), y },
                ]
            }, pane)
            await page.mouse.move(points[0]!.x, points[0]!.y)
            await page.mouse.down()
            await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 4 })
            await page.mouse.up()
            return page.evaluate(async () => {
                const { appImport, history } = window.editorTest
                const { getPreviewState } =
                    await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
                return [...getPreviewState(history.state.value).store.slides.note.values()]
                    .flat()
                    .map(({ left, size }) => ({ left, size }))
            })
        }
        const main = await drag('main')
        await page.reload()
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        const elevation = await drag('elevation')
        expect(main).toEqual([{ left: -2, size: 4 }])
        expect(elevation).toEqual(main)
    })
}

test('Elevation Editor scrolling reaches notes in either layout', async ({ page }) => {
    const reach = await page.evaluate(async () => {
        const { fixtures, show, view, settings, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                stageTransformEvents: [
                    {
                        stageId: base.stageId,
                        beat: 0,
                        rotation: 0,
                        xTranslation: 20,
                        yTranslation: 0,
                        elevation: 0,
                        anchor: 'default',
                        eventEase: 'linear',
                    },
                ],
                slides: [[{ ...base, beat: 4, left: -1, size: 2 }]],
            },
            2,
        )
        settings.maxScrollX = 0
        settings.width = 20
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        const { scrollViewXBy } =
            await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
        const scene = await appImport<typeof import('../../src/editor/elevation/scene')>(
            '/src/editor/elevation/scene.ts',
        )
        openElevationEditor(4)
        const visible = () => {
            const layout = scene.elevationLayout.value
            const row = layout.rows[0]!
            return row.x >= 0 && row.x <= layout.width
        }
        const result = {} as Record<'basic' | 'composed', { lane: number; visible: boolean }>
        for (const layout of ['basic', 'composed'] as const) {
            view.layout = layout
            view.lane = 0
            for (let i = 0; i < 100; i++) scrollViewXBy(100)
            result[layout] = { lane: view.lane, visible: visible() }
        }
        return result
    })
    // Basic shows authored lanes, already in view; Composed scrolls out to the stage.
    expect(reach.basic).toEqual({ lane: 0, visible: true })
    expect(reach.composed.lane).toBeGreaterThan(0)
    expect(reach.composed.visible).toBe(true)
})

// Stage 1 sits 3.5 lanes over on whole lanes; stage 2 0.25 lanes over on half lanes.
const seedLattice = (page: import('@playwright/test').Page, layout: 'basic' | 'composed') =>
    page.evaluate(
        async ({ layout }) => {
            const { fixtures, show, view, settings, history, appImport } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            const pivot = fixtures.events.stagePivotEvents[0]!
            const stage1 = base.stageId
            const stage2 = 2 as typeof base.stageId
            const transform = {
                stageId: stage1,
                rotation: 0,
                yTranslation: 0,
                elevation: 0,
                anchor: 'default' as const,
            }
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: true,
                    stagePivotEvents: [
                        { ...pivot, stageId: stage1, beat: 0, pivotLane: 0.5, divisionSize: 1 },
                        {
                            ...pivot,
                            stageId: stage2,
                            beat: 0,
                            pivotLane: 0.25,
                            divisionSize: 1,
                            divisionParity: 'odd',
                        },
                    ],
                    stageTransformEvents: [
                        { ...transform, beat: 0, xTranslation: 0, eventEase: 'inOutQuad' },
                        { ...transform, beat: 8, xTranslation: 6, eventEase: 'linear' },
                    ],
                    slides: [
                        [{ ...base, beat: 4, left: -2, size: 2 }],
                        [{ ...base, stageId: stage2, beat: 4, left: -4.5, size: 2 }],
                    ],
                },
                2,
            )
            view.layout = layout
            view.laneDivision = 1
            view.laneSnapping = 'absolute'
            settings.width = 24
            settings.maxScrollX = 0
            settings.elevationEditorSideBySide = 'allow'
            const [first] = [...history.state.value.store.slides.note.values()].flat()
            history.replaceState({ ...history.state.value, selectedEntities: [first!] })
            const { copy } = await appImport<typeof import('../../src/editor/commands/copy')>(
                '/src/editor/commands/copy/index.ts',
            )
            copy.execute()
            history.replaceState({ ...history.state.value, selectedEntities: [] })
            const { openElevationEditor } = await appImport<
                typeof import('../../src/editor/elevation/state')
            >('/src/editor/elevation/state.ts')
            openElevationEditor(4)
        },
        { layout },
    )

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: Elevation Editor adds, pastes, moves and resizes on the stage lattice, as the chart does`, async ({
        page,
    }) => {
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
        await seedLattice(page, layout)
        await expect(page.locator('.elevation-canvas')).toBeVisible()
        type Pane = 'main' | 'elevation'
        // Displayed lane at beat 4, elevation 0, on either pane.
        const at = (pane: Pane, lane: number) =>
            page.evaluate(
                async ({ pane, lane }) => {
                    const { appImport, point } = window.editorTest
                    if (pane === 'main') return point(lane, 4)
                    const scene = await appImport<
                        typeof import('../../src/editor/elevation/scene')
                    >('/src/editor/elevation/scene.ts')
                    const layout = scene.elevationLayout.value
                    const box = document.querySelector('.elevation-canvas')!.getBoundingClientRect()
                    return { x: box.x + layout.xAt(lane), y: box.y + layout.yAt(0) }
                },
                { pane, lane },
            )
        // The point once the panes have stopped resizing: opening the editor and the previous
        // gesture's undo relayout both, and a click at a point from before that lands elsewhere.
        const settledAt = async (pane: Pane, lane: number) => {
            let last = await at(pane, lane)
            for (let attempt = 0; attempt < 50; attempt++) {
                await page.evaluate(
                    () =>
                        new Promise((resolve) =>
                            requestAnimationFrame(() => requestAnimationFrame(resolve)),
                        ),
                )
                const now = await at(pane, lane)
                if (now.x === last.x && now.y === last.y) return now
                last = now
            }
            return last
        }
        // Displayed lanes of the stage 2 note.
        const stage2Note = () =>
            page.evaluate(async () => {
                const { appImport, history } = window.editorTest
                const { getComposedNoteOffset } = await appImport<
                    typeof import('../../src/editor/composedView')
                >('/src/editor/composedView.ts')
                const note = [...history.state.value.store.slides.note.values()]
                    .flat()
                    .find((note) => note.stageId === 2)!
                const left = note.left + getComposedNoteOffset(note)
                return { left, right: left + note.size }
            })
        const setup = (tool: string, stageId?: number) =>
            page.evaluate(
                async ({ tool, stageId }) => {
                    const { appImport, view, history } = window.editorTest
                    const { switchToolTo } = await appImport<
                        typeof import('../../src/editor/tools')
                    >('/src/editor/tools/index.ts')
                    switchToolTo(tool as Parameters<typeof switchToolTo>[0])
                    view.stageId = stageId as typeof view.stageId
                    history.replaceState({ ...history.state.value, selectedEntities: [] })
                },
                { tool, stageId },
            )
        const notes = () =>
            page.evaluate(() =>
                [...window.editorTest.history.state.value.store.slides.note.values()]
                    .flat()
                    .map(({ stageId, left, size }) => ({ stageId, left, size }))
                    .sort((a, b) => a.stageId - b.stageId || a.left - b.left),
            )
        const gesture = async (pane: Pane, run: (pane: Pane) => Promise<void>) => {
            await run(pane)
            await page.evaluate(() => window.editorTest.nextTick())
            const result = await notes()
            await page.evaluate(() => window.editorTest.history.undoState())
            return result
        }
        const tap =
            (tool: string, lane: number, stageId?: number, shift = false) =>
            async (pane: Pane) => {
                await setup(tool, stageId)
                const point = await settledAt(pane, lane)
                await page.mouse.move(point.x - 2, point.y)
                await page.mouse.move(point.x, point.y)
                if (shift) await page.keyboard.down('Shift')
                await page.mouse.click(point.x, point.y)
                if (shift) await page.keyboard.up('Shift')
                // A paste reads the clipboard first.
                await expect.poll(notes).toHaveLength(3)
            }
        const drag =
            (tool: string, from: () => Promise<number>, by: number, stageId?: number) =>
            async (pane: Pane) => {
                await setup(tool, stageId)
                const lane = await from()
                const start = await settledAt(pane, lane)
                const end = await settledAt(pane, lane + by)
                await page.mouse.move(start.x, start.y)
                await page.mouse.down()
                await page.mouse.move(end.x, end.y, { steps: 6 })
                await page.mouse.up()
            }
        const gestures = {
            add: tap('note', -6.3, 1),
            addHalf: tap('note', 5.3, 2),
            addDrag: drag('note', async () => 5.3, 3.6, 2),
            paste: tap('paste', 6),
            // Shift flips the pasted notes.
            pasteFlipped: tap('paste', 6.3, undefined, true),
            move: drag('select', async () => (await stage2Note()).left + 1, 2.3),
            resize: drag('select', async () => (await stage2Note()).right - 0.1, 1.4),
        }
        const main: Record<string, unknown> = {}
        const elevation: Record<string, unknown> = {}
        for (const [name, run] of Object.entries(gestures)) {
            main[name] = await gesture('main', run)
            elevation[name] = await gesture('elevation', run)
        }
        expect(elevation).toEqual(main)
        if (layout === 'composed') {
            // Authored lanes on each stage's lattice: whole lanes on stage 1, half lanes on stage 2.
            expect(main.add).toContainEqual({ stageId: 1, left: -10, size: 2 })
            expect(main.addHalf).toContainEqual({ stageId: 2, left: 5.5, size: 2 })
            expect(main.move).toContainEqual({ stageId: 2, left: -2.5, size: 2 })
        }
    })
}
