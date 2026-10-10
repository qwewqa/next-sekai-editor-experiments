import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// Each kind's own tool, its store grid and the lane field its move offsets.
const kinds = {
    stagePivotEvent: { grid: 'stagePivotEventJoint', field: 'pivotLane' },
    stageTransformEvent: { grid: 'stageTransformEventJoint', field: 'xTranslation' },
    stageStyleEvent: { grid: 'stageStyleEventJoint', field: 'editorLane' },
    timeScale: { grid: 'timeScale', field: 'editorLane' },
    stageMaskEvent: { grid: 'stageMaskEventJoint', field: 'maskLeft' },
    cameraEvent: { grid: 'cameraEventJoint', field: 'cameraLeft' },
} as const
type Kind = keyof typeof kinds

// Shows one object of the kind at beat (4) with its lane field at value, and picks the tool.
const setup = (
    page: Page,
    options: {
        kind: Kind
        tool: Kind | 'select'
        value: number
        laneDivision?: number
        division?: number
        maxLane?: number
        beat?: number
    },
) =>
    page.evaluate(
        async ({ kind, tool, value, laneDivision = 1, division = 4, maxLane = 0, beat = 4 }) => {
            const { show, fixtures, view, settings, appImport } = window.editorTest
            const events = fixtures.events
            show(
                {
                    ...fixtures.interaction,
                    slides: [],
                    ...(kind === 'stagePivotEvent'
                        ? {
                              stagePivotEvents: [
                                  { ...events.stagePivotEvents[0]!, beat, pivotLane: value },
                              ],
                          }
                        : kind === 'stageTransformEvent'
                          ? {
                                stageTransformEvents: [
                                    {
                                        ...events.stageTransformEvents[0]!,
                                        beat,
                                        xTranslation: value,
                                    },
                                ],
                            }
                          : kind === 'stageStyleEvent'
                            ? {
                                  stageStyleEvents: [
                                      { ...events.stageStyleEvents[0]!, beat, editorLane: value },
                                  ],
                              }
                            : kind === 'timeScale'
                              ? {
                                    timeScales: [
                                        {
                                            ...events.timeScales[0]!,
                                            groupId: 1 as never,
                                            beat,
                                            editorLane: value,
                                        },
                                    ],
                                }
                              : kind === 'stageMaskEvent'
                                ? {
                                      stageMaskEvents: [
                                          {
                                              ...events.stageMaskEvents[0]!,
                                              beat,
                                              maskLeft: value,
                                              maskSize: 2,
                                          },
                                      ],
                                  }
                                : {
                                      cameraEvents: [
                                          {
                                              ...events.cameraEvents[0]!,
                                              beat,
                                              cameraLeft: value,
                                              cameraSize: 6,
                                          },
                                      ],
                                  }),
                },
                3,
            )
            view.laneDivision = laneDivision
            view.laneSnapping = 'absolute'
            view.division = division
            view.snapping = 'absolute'
            settings.maxLane = maxLane
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo(tool)
        },
        options,
    )

const objects = (page: Page, kind: Kind) =>
    page.evaluate(
        ({ grid, field }) =>
            [...window.editorTest.history.state.value.store.grid[grid].values()]
                .flatMap((bucket) => [...bucket])
                .map((entity) => ({
                    beat: entity.beat,
                    lane: (entity as unknown as Record<string, number>)[field],
                })),
        kinds[kind],
    )

const canUndo = (page: Page) =>
    page.evaluate(async () => {
        const { canUndo } =
            await window.editorTest.appImport<typeof import('../../src/history')>(
                '/src/history/index.ts',
            )
        return canUndo.value
    })

// Presses lane at beat from (4), moves dx lanes sideways and beats down the chart, and releases.
const drag = async (page: Page, lane: number, dx: number, beats: number, from = 4) => {
    const { start, end, width } = await page.evaluate(
        ({ lane, beats, from }) => {
            const { point, view, settings } = window.editorTest
            return {
                start: point(lane, from),
                end: point(lane, from + beats),
                width: view.w / settings.width,
            }
        },
        { lane, beats, from },
    )
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + dx * width, (start.y + end.y) / 2, { steps: 4 })
    await page.mouse.move(start.x + dx * width, end.y, { steps: 4 })
    // A drag, not a tap: its preview shows.
    expect(await page.evaluate(() => window.editorTest.view.entities.creating.length)).toBe(1)
    await page.mouse.up()
}

for (const kind of [
    'stagePivotEvent',
    'stageTransformEvent',
    'stageStyleEvent',
    'timeScale',
] as const) {
    for (const tool of [kind, 'select'] as const) {
        test(`${kind}, ${tool}: a move offsets the lane by the pointer's movement`, async ({
            page,
        }) => {
            for (const [dx, lane] of [
                [0, 0.37],
                [0.45, 0.37],
                [-0.45, 0.37],
                [0.55, 1],
                [-0.55, 0],
            ] as const) {
                await setup(page, { kind, tool, value: 0.37 })
                await drag(page, 0.37, dx, 2)
                expect(await objects(page, kind)).toEqual([{ beat: 6, lane }])
            }
            // With two divisions per lane, half a step is a quarter lane.
            for (const [dx, lane] of [
                [0.2, 0.37],
                [0.3, 0.5],
                [-0.3, 0],
            ] as const) {
                await setup(page, { kind, tool, value: 0.37, laneDivision: 2 })
                await drag(page, 0.37, dx, 2)
                expect(await objects(page, kind)).toEqual([{ beat: 6, lane }])
            }
            // Relative snapping keeps the fraction.
            await setup(page, { kind, tool, value: 0.37 })
            await page.evaluate(() => (window.editorTest.view.laneSnapping = 'relative'))
            await drag(page, 0.37, 1.1, 2)
            expect(await objects(page, kind)).toEqual([{ beat: 6, lane: 1.37 }])
        })
    }
}

// Pressed lane inside each object; every one starts outside lane limits of 3.
const outside = {
    stagePivotEvent: { value: 3.37, press: 3.37 },
    stageTransformEvent: { value: 3.37, press: 3.37 },
    stageStyleEvent: { value: 3.37, press: 3.37 },
    timeScale: { value: 3.37, press: 3.37 },
    stageMaskEvent: { value: 2.37, press: 3.37 },
    cameraEvent: { value: 0.37, press: 3.37 },
} as const

for (const kind of Object.keys(kinds) as Kind[]) {
    for (const tool of [kind, 'select'] as const) {
        test(`${kind}, ${tool}: a drop that moves nothing leaves an object outside the lane limits`, async ({
            page,
        }) => {
            const { value, press } = outside[kind]
            // Less than half a beat step, straight down.
            await setup(page, { kind, tool, value, division: 1, maxLane: 3 })
            await drag(page, press, 0, 0.45)
            expect(await objects(page, kind)).toEqual([{ beat: 4, lane: value }])
            expect(await canUndo(page)).toBe(false)
            // A real move still brings it inside.
            await setup(page, { kind, tool, value, division: 1, maxLane: 3 })
            await drag(page, press, 0, 2)
            const [moved] = await objects(page, kind)
            expect(moved!.beat).toBe(6)
            expect(moved!.lane).toBeLessThan(value)
        })
    }
}

// 0.1 + 2.2 is 2.3000000000000003 in floats.
const pressLanes = { stageMaskEvent: 1.37, cameraEvent: 3.37 } as Partial<Record<Kind, number>>
for (const kind of Object.keys(kinds) as Kind[]) {
    test(`${kind}: a tool move lands exactly on the beat grid`, async ({ page }) => {
        await setup(page, { kind, tool: kind, value: 0.37, division: 10, beat: 0.1 })
        await page.evaluate(() => (window.editorTest.view.snapping = 'relative'))
        await drag(page, pressLanes[kind] ?? 0.37, 0, 2.2, 0.1)
        expect(await objects(page, kind)).toEqual([{ beat: 2.3, lane: 0.37 }])
    })
}

test('bpm: a tool move lands exactly on the beat grid', async ({ page }) => {
    await page.evaluate(async () => {
        const { show, fixtures, view, appImport } = window.editorTest
        show(
            {
                ...fixtures.interaction,
                slides: [],
                bpms: [
                    { beat: 0, bpm: 120 },
                    { beat: 0.1, bpm: 120 },
                ],
            },
            3,
        )
        view.division = 10
        view.snapping = 'relative'
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo('bpm')
    })
    await drag(page, 0, 0, 2.2, 0.1)
    expect(
        await page.evaluate(() =>
            [...window.editorTest.history.state.value.store.grid.bpm.values()]
                .flatMap((bucket) => [...bucket])
                .map((bpm) => bpm.beat)
                .sort((a, b) => a - b),
        ),
    ).toEqual([0, 2.3])
})

// Enable once moveBase.ts's toDraggedNoteObject gates lane limits as Select does (fix4-drag merge).
for (const tool of ['note', 'slide', 'select'] as const) {
    test.fixme(`${tool}: a drop that moves nothing leaves a note outside the lane limits`, async ({
        page,
    }) => {
        await page.evaluate(
            async ({ tool }) => {
                const { show, fixtures, view, settings, appImport } = window.editorTest
                const base = fixtures.interaction.slides[0]![0]!
                show(
                    {
                        ...fixtures.interaction,
                        slides: [[{ ...base, beat: 4, left: 2.37, size: 2 }]],
                    },
                    3,
                )
                view.laneDivision = 1
                view.laneSnapping = 'absolute'
                view.division = 1
                view.snapping = 'absolute'
                settings.maxLane = 3
                const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                    '/src/editor/tools/index.ts',
                )
                switchToolTo(tool)
            },
            { tool },
        )
        const notes = () =>
            page.evaluate(() =>
                [...window.editorTest.history.state.value.store.slides.note.values()]
                    .flat()
                    .map((note) => ({ beat: note.beat, left: note.left })),
            )
        await drag(page, 3.37, 0, 0.45)
        expect(await notes()).toEqual([{ beat: 4, left: 2.37 }])
        expect(await canUndo(page)).toBe(false)
    })
}
