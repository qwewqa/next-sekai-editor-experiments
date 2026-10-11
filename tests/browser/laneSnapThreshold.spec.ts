import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

type Setup = {
    tool: 'select' | 'note' | 'slide'
    lefts: number[]
    mode?: 'absolute' | 'relative'
    division?: number
    layout?: 'basic' | 'composed'
    // Composed: an odd-parity stage, its lattice offset by half a lane; moving shifts it 0.5 lanes from beat 4 to 6.
    stage?: 'static' | 'moving'
}

const setup = (page: Page, options: Setup) =>
    page.evaluate(
        async ({ tool, lefts, mode = 'absolute', division = 1, layout = 'basic', stage }) => {
            const { show, fixtures, view, settings, history, appImport } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            const pivot = fixtures.events.stagePivotEvents[0]!
            show(
                {
                    ...fixtures.interaction,
                    ...(stage
                        ? {
                              isDynamicStages: true,
                              stagePivotEvents: [0, 8].map((beat) => ({
                                  ...pivot,
                                  beat,
                                  pivotLane: stage === 'moving' ? 0.2 + beat / 4 : 0.2,
                                  eventEase: 'linear' as const,
                                  divisionSize: 1,
                                  divisionParity: 'odd' as const,
                              })),
                          }
                        : {}),
                    slides: lefts.map((left, index) => [
                        { ...base, beat: 4 + index * 0.5, left, size: 2 },
                    ]),
                },
                3,
            )
            view.layout = layout
            view.laneDivision = division
            view.laneSnapping = mode
            view.snapping = 'absolute'
            settings.maxLane = 0
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo(tool)
            if (tool === 'select') {
                const source = history.state.value
                history.replaceState({
                    ...source,
                    selectedEntities: [...source.store.slides.note.values()].flat(),
                })
            }
        },
        options,
    )

const notes = (page: Page) =>
    page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const layout = createComposedLayout(history.state.value)
        return [...history.state.value.store.slides.note.values()]
            .flat()
            .sort((a, b) => a.beat - b.beat)
            .map((note) => ({
                beat: note.beat,
                left: note.left,
                shown: layout ? layout.notePosition(note).left : note.left,
            }))
    })

// Presses the first note's middle at beat 4, moves dx lanes sideways and to beat 6, and releases.
const drag = async (page: Page, dx: number, beats = 2) => {
    const [first] = await notes(page)
    const { start, end, lane } = await page.evaluate(
        ({ shown, beats }) => {
            const { point, view, settings } = window.editorTest
            return {
                start: point(shown + 1, 4),
                end: point(shown + 1, 4 + beats),
                lane: view.w / settings.width,
            }
        },
        { shown: first!.shown, beats },
    )
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + dx * lane, (start.y + end.y) / 2, { steps: 4 })
    await page.mouse.move(start.x + dx * lane, end.y, { steps: 4 })
    await page.mouse.up()
}

for (const tool of ['select', 'note', 'slide'] as const) {
    test(`${tool}: absolute lane snapping waits for half a lane step of sideways movement`, async ({
        page,
    }) => {
        for (const [dx, left] of [
            [0, 0.37],
            [0.45, 0.37],
            [-0.45, 0.37],
            [0.55, 1],
            [-0.55, 0],
        ] as const) {
            await setup(page, { tool, lefts: [0.37] })
            await drag(page, dx)
            const [moved] = await notes(page)
            expect(moved!.beat).toBe(6)
            expect(moved!.left).toBe(left)
        }
        // With two divisions per lane, half a step is a quarter lane.
        for (const [dx, left] of [
            [0.2, 0.37],
            [0.3, 0.5],
            [-0.3, 0],
        ] as const) {
            await setup(page, { tool, lefts: [0.37], division: 2 })
            await drag(page, dx)
            expect((await notes(page))[0]!.left).toBe(left)
        }
        // On the grid, nothing changes.
        for (const [dx, left] of [
            [0.45, 1],
            [0.55, 2],
        ] as const) {
            await setup(page, { tool, lefts: [1] })
            await drag(page, dx)
            expect((await notes(page))[0]!.left).toBe(left)
        }
    })
}

test('relative lane snapping is unchanged', async ({ page }) => {
    for (const tool of ['select', 'note'] as const) {
        for (const [dx, left] of [
            [0, 0.37],
            [0.45, 0.37],
            [0.55, 1.37],
            [-0.55, -0.63],
        ] as const) {
            await setup(page, { tool, lefts: [0.37], mode: 'relative' })
            await drag(page, dx)
            expect((await notes(page))[0]!.left).toBeCloseTo(left)
        }
    }
})

test('a multi-selection keeps its spacing and moves as one', async ({ page }) => {
    for (const [dx, lefts] of [
        [0, [0.37, -3.2]],
        [0.4, [0.37, -3.2]],
        [0.6, [1, -2.57]],
    ] as const) {
        await setup(page, { tool: 'select', lefts: [0.37, -3.2] })
        await drag(page, dx)
        const moved = await notes(page)
        expect(moved.map((note) => note.beat)).toEqual([6, 6.5])
        expect(moved[0]!.left).toBeCloseTo(lefts[0])
        expect(moved[1]!.left).toBeCloseTo(lefts[1])
    }
})

test('a sideways jitter shorter than half a step adds no undo step', async ({ page }) => {
    await setup(page, { tool: 'select', lefts: [0.37] })
    await drag(page, 0.4, 0)
    expect((await notes(page))[0]).toMatchObject({ beat: 4, left: 0.37 })
    expect(
        await page.evaluate(async () => {
            const { canUndo } =
                await window.editorTest.appImport<typeof import('../../src/history')>(
                    '/src/history/index.ts',
                )
            return canUndo.value
        }),
    ).toBe(false)
})

test('Composed waits in pointer lanes until the stage lattice moves', async ({ page }) => {
    for (const tool of ['select', 'note'] as const) {
        // An integer note on an odd-parity stage is off its half-lane lattice.
        for (const [dx, left] of [
            [0, 1],
            [0.45, 1],
            [-0.45, 1],
            [0.55, 1.5],
            [-0.55, 0.5],
        ] as const) {
            await setup(page, { tool, lefts: [1], layout: 'composed', stage: 'static' })
            await drag(page, dx)
            const [moved] = await notes(page)
            expect(moved!.beat).toBe(6)
            expect(moved!.left).toBe(left)
        }
        // A stage moved by half a lane moves its lattice, so the note snaps at once: it stays where it was shown.
        await setup(page, { tool, lefts: [1], layout: 'composed', stage: 'moving' })
        const [before] = await notes(page)
        await drag(page, 0)
        const [after] = await notes(page)
        expect(after!.left).toBe(0.5)
        expect(after!.shown - before!.shown).toBeCloseTo(0)
        // Beyond half a step, absolute snapping lands on the destination lattice.
        await setup(page, { tool, lefts: [1], layout: 'composed', stage: 'moving' })
        await drag(page, 0.6)
        const [snapped] = await notes(page)
        expect((snapped!.left - 0.5) % 1).toBeCloseTo(0)
    }
    // A note with a stage event takes the solved raw move.
    for (const [dx, left, pivotLane] of [
        [0, 1, 0.2],
        [0.45, 1, 0.2],
        [0.55, 1.5, 0.7],
    ] as const) {
        await setup(page, { tool: 'select', lefts: [1], layout: 'composed', stage: 'static' })
        await page.evaluate(() => {
            const { history } = window.editorTest
            const source = history.state.value
            const pivots = [...source.store.grid.stagePivotEventJoint.values()]
                .flatMap((bucket) => [...bucket])
                .filter((pivot) => pivot.beat === 8)
            history.replaceState({
                ...source,
                selectedEntities: [...[...source.store.slides.note.values()].flat(), ...pivots],
            })
        })
        await drag(page, dx)
        expect((await notes(page))[0]).toMatchObject({ beat: 6, left })
        expect(
            await page.evaluate(() =>
                [...window.editorTest.history.state.value.store.grid.stagePivotEventJoint.values()]
                    .flatMap((bucket) => [...bucket])
                    .map((pivot) => [pivot.beat, pivot.pivotLane]),
            ),
        ).toEqual([
            [0, 0.2],
            [10, pivotLane],
        ])
    }
})

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: an elevation-only drag in the Elevation Editor leaves lanes alone`, async ({
        page,
    }) => {
        for (const [dx, left] of [
            [0, 1],
            [0.45, 1],
            [0.55, layout === 'composed' ? 1.5 : 2],
        ] as const) {
            await setup(page, {
                tool: 'select',
                lefts: [1],
                layout,
                stage: layout === 'composed' ? 'static' : undefined,
            })
            await page.evaluate(() => {
                window.editorTest.settings.elevationEditorSideBySide = 'disallow'
            })
            if (layout === 'basic')
                await page.evaluate(async () => {
                    const { history, fixtures } = window.editorTest
                    const base = fixtures.interaction.slides[0]![0]!
                    window.editorTest.show(
                        { ...fixtures.interaction, slides: [[{ ...base, beat: 4, left: 4.3 }]] },
                        3,
                    )
                    const source = history.state.value
                    history.replaceState({
                        ...source,
                        selectedEntities: [...source.store.slides.note.values()].flat(),
                    })
                })
            await page.keyboard.press('t')
            await expect(page.locator('canvas.elevation-canvas')).toBeVisible()
            const point = await page.evaluate(async () => {
                const { elevationLayout } = await window.editorTest.appImport<
                    typeof import('../../src/editor/elevation/scene')
                >('/src/editor/elevation/scene.ts')
                const layout = elevationLayout.value
                const row = layout.rows[0]!
                const box = document
                    .querySelector('canvas.elevation-canvas')!
                    .getBoundingClientRect()
                return {
                    x: box.x + row.x,
                    y: box.y + row.y,
                    lane: layout.laneScale,
                    up: layout.yAt(1) - layout.yAt(0),
                }
            })
            await page.mouse.move(point.x, point.y)
            await page.mouse.down()
            await page.mouse.move(point.x + dx * point.lane, point.y + point.up, { steps: 6 })
            await page.mouse.up()
            const note = (
                await page.evaluate(() => [
                    ...window.editorTest.history.state.value.store.slides.note.values(),
                ])
            ).flat()[0]!
            expect(note.elevation).toBe(1)
            expect(note.left).toBe(layout === 'basic' ? (dx < 0.5 ? 4.3 : 5) : left)
            await page.keyboard.press('Escape')
        }
    })
}

for (const tool of ['stageMaskEvent', 'select'] as const) {
    test(`${tool}: a time-only drag leaves an off-grid stage mask in its lanes`, async ({
        page,
    }) => {
        for (const [dx, maskLeft] of [
            [0.2, 0.37],
            [-0.2, 0.37],
            [0.6, 1],
        ] as const) {
            await page.evaluate(
                async ({ tool }) => {
                    const { show, fixtures, view, history, appImport } = window.editorTest
                    show(
                        {
                            ...fixtures.interaction,
                            slides: [],
                            stageMaskEvents: [
                                {
                                    ...fixtures.events.stageMaskEvents[0]!,
                                    beat: 4,
                                    maskLeft: 0.37,
                                    maskSize: 4,
                                },
                            ],
                        },
                        3,
                    )
                    view.laneDivision = 1
                    view.laneSnapping = 'absolute'
                    const { switchToolTo } = await appImport<
                        typeof import('../../src/editor/tools')
                    >('/src/editor/tools/index.ts')
                    switchToolTo(tool)
                    const source = history.state.value
                    history.replaceState({
                        ...source,
                        selectedEntities: [
                            ...source.store.grid.stageMaskEventJoint.values(),
                        ].flatMap((bucket) => [...bucket]),
                    })
                },
                { tool },
            )
            const { start, end, lane } = await page.evaluate(() => {
                const { point, view, settings } = window.editorTest
                return {
                    start: point(2.37, 4),
                    end: point(2.37, 6),
                    lane: view.w / settings.width,
                }
            })
            await page.mouse.move(start.x, start.y)
            await page.mouse.down()
            await page.mouse.move(start.x + dx * lane, (start.y + end.y) / 2, { steps: 4 })
            await page.mouse.move(start.x + dx * lane, end.y, { steps: 4 })
            await page.mouse.up()
            const masks = await page.evaluate(() =>
                [...window.editorTest.history.state.value.store.grid.stageMaskEventJoint.values()]
                    .flatMap((bucket) => [...bucket])
                    .map((mask) => ({ beat: mask.beat, maskLeft: mask.maskLeft })),
            )
            expect(masks).toEqual([{ beat: 6, maskLeft }])
        }
    })
}
