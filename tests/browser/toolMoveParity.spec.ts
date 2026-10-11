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

// Note and Slide moves gate lane limits as Select does.
for (const tool of ['note', 'slide', 'select'] as const) {
    test(`${tool}: a drop that moves nothing leaves a note outside the lane limits`, async ({
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

// Every tool family: its own tool's drag of one object stores exactly what Select's does.
type Family = Kind | 'note' | 'slide' | 'bpm'
type Seed = {
    family: Family
    tool: Family | 'select'
    layout: 'basic' | 'composed'
    tick: boolean
    beat: number
    time: number
    laneDivision: number
    division: number
    laneSnapping: 'absolute' | 'relative'
    snapping: 'absolute' | 'relative'
}

// Shows one object of the family at beat (a note on a slide from beat 0, as an attached tick if
// asked; Composed adds a moving pivot) and returns the lane to press inside it.
const seed = (page: Page, options: Seed) =>
    page.evaluate(async (o) => {
        const { show, fixtures, view, settings, appImport } = window.editorTest
        const events = fixtures.events
        const base = fixtures.interaction.slides[0]![0]!
        const pivot = events.stagePivotEvents[0]!
        const isNote = o.family === 'note' || o.family === 'slide'
        const notes = !isNote
            ? []
            : o.tick
              ? [
                    { ...base, beat: 0, left: -4, size: 2 },
                    { ...base, beat: o.beat, left: 0, size: 2, isAttached: true },
                    { ...base, beat: o.beat + 2, left: 2, size: 2 },
                ]
              : [{ ...base, beat: o.beat, left: 0.37, size: 2 }]
        const one = {
            bpm: {
                bpms: [
                    { beat: 0, bpm: 120 },
                    { beat: o.beat, bpm: 120 },
                ],
            },
            stagePivotEvent: { stagePivotEvents: [{ ...pivot, beat: o.beat, pivotLane: 0.37 }] },
            stageTransformEvent: {
                stageTransformEvents: [
                    { ...events.stageTransformEvents[0]!, beat: o.beat, xTranslation: 0.37 },
                ],
            },
            stageStyleEvent: {
                stageStyleEvents: [
                    { ...events.stageStyleEvents[0]!, beat: o.beat, editorLane: 0.37 },
                ],
            },
            timeScale: {
                timeScales: [
                    {
                        ...events.timeScales[0]!,
                        groupId: 1 as never,
                        beat: o.beat,
                        editorLane: 0.37,
                    },
                ],
            },
            stageMaskEvent: {
                stageMaskEvents: [
                    { ...events.stageMaskEvents[0]!, beat: o.beat, maskLeft: 0.37, maskSize: 2 },
                ],
            },
            cameraEvent: {
                cameraEvents: [
                    { ...events.cameraEvents[0]!, beat: o.beat, cameraLeft: 0.37, cameraSize: 6 },
                ],
            },
        }[o.family as string]
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: o.layout === 'composed',
                slides: notes.length ? [notes] : [],
                // Away from an event's press, so Select doesn't take the pivot drawn on top.
                stagePivotEvents:
                    o.layout === 'composed'
                        ? [0, 8].map((beat) => ({
                              ...pivot,
                              beat,
                              pivotLane: (isNote ? 0.2 : -4) + beat / 4,
                              eventEase: 'linear' as const,
                          }))
                        : [],
                ...one,
            },
            o.time,
        )
        view.layout = o.layout
        view.laneDivision = o.laneDivision
        view.laneSnapping = o.laneSnapping
        view.division = o.division
        view.snapping = o.snapping
        settings.maxLane = 0
        settings.pps = 400
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo(o.tool)
        if (!isNote)
            return (
                ({ bpm: 6.4, stageMaskEvent: 1.37, cameraEvent: 3.37 } as Record<string, number>)[
                    o.family
                ] ?? 0.37
            )
        // The note's displayed middle, in the scene the canvas draws.
        const { sceneState } = await appImport<typeof import('../../src/editor/sceneState')>(
            '/src/editor/sceneState.ts',
        )
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const layout = createComposedLayout(sceneState.value)
        const note = [...window.editorTest.history.state.value.store.slides.note.values()]
            .flat()
            .find((note) => note.beat === o.beat)!
        const shown = layout?.notePosition(note) ?? note
        return shown.left + shown.size / 2
    }, options)

// The family's stored objects' fields, and whether there is an undo step.
const stored = (page: Page, family: Family) =>
    page.evaluate(
        async ({ family, grid }) => {
            const { history, appImport } = window.editorTest
            const { canUndo } =
                await appImport<typeof import('../../src/history')>('/src/history/index.ts')
            const { store } = history.state.value
            const entities: object[] =
                family === 'note' || family === 'slide'
                    ? [...store.slides.note.values()].flat()
                    : [...store.grid[grid as 'bpm'].values()].flatMap((bucket) => [...bucket])
            return {
                objects: entities
                    .map((entity) =>
                        // A rebuilt slide gets a new id.
                        Object.fromEntries(
                            Object.entries(entity).filter(
                                ([key, value]) => typeof value !== 'object' && key !== 'slideId',
                            ),
                        ),
                    )
                    .sort((a, b) => a.beat - b.beat),
                canUndo: canUndo.value,
            }
        },
        { family, grid: family in kinds ? kinds[family as Kind].grid : 'bpm' },
    )

type Scenario = {
    name: string
    beat?: number
    // How far above the object's beat the press lands.
    pressAt?: number
    dx: number
    beats: number
    laneDivision?: number
    division?: number
    laneSnapping?: 'absolute' | 'relative'
    snapping?: 'absolute' | 'relative'
    moves: boolean
    ticksOnly?: boolean
}

const scenarios: Scenario[] = [
    { name: 'a step sideways and down', dx: 0.55, beats: 1, moves: true },
    { name: 'under half a step each way', dx: -0.45, beats: 0.4, division: 1, moves: false },
    { name: 'two lane divisions', dx: 0.3, beats: 2, laneDivision: 2, moves: true },
    {
        name: 'relative snapping from an off-centre press',
        pressAt: 0.09,
        dx: 1.1,
        beats: 0.66,
        division: 8,
        laneSnapping: 'relative',
        snapping: 'relative',
        moves: true,
    },
    {
        name: 'an exact landing on the grid',
        beat: 0.1,
        dx: 0,
        beats: 2.2,
        division: 10,
        snapping: 'relative',
        moves: true,
    },
    { name: 'thirds', beat: 4 / 3, dx: 0, beats: 0.4, division: 3, moves: true },
    {
        name: 'a stop at beat 0',
        beat: 1,
        pressAt: 0.09,
        dx: 0,
        beats: -1.15,
        division: 50,
        snapping: 'relative',
        moves: true,
    },
    { name: 'past the slide end', beat: 4, dx: 0, beats: 3, moves: true, ticksOnly: true },
]

const parityCases: { family: Family; layout: 'basic' | 'composed'; tick: boolean }[] = [
    ...(['note', 'slide'] as const).flatMap((family) =>
        (['basic', 'composed'] as const).flatMap((layout) =>
            [false, true].map((tick) => ({ family, layout, tick })),
        ),
    ),
    ...(['bpm', ...Object.keys(kinds)] as Family[]).flatMap((family) =>
        (['basic', 'composed'] as const).map((layout) => ({ family, layout, tick: false })),
    ),
]

for (const { family, layout, tick } of parityCases) {
    test(`${family}${tick ? ' tick' : ''}, ${layout}: a tool move stores what a Select move does`, async ({
        page,
    }) => {
        for (const scenario of scenarios) {
            if (scenario.ticksOnly && !tick) continue
            const beat = scenario.beat ?? 4
            const pressAt = scenario.pressAt ?? 0
            const results = []
            for (const tool of [family, 'select'] as const) {
                const lane = await seed(page, {
                    family,
                    tool,
                    layout,
                    tick,
                    beat,
                    time: (beat + pressAt + scenario.beats / 2) / 2,
                    laneDivision: scenario.laneDivision ?? 1,
                    division: scenario.division ?? 4,
                    laneSnapping: scenario.laneSnapping ?? 'absolute',
                    snapping: scenario.snapping ?? 'absolute',
                })
                const before = await stored(page, family)
                await drag(page, lane, scenario.dx, scenario.beats, beat + pressAt)
                const after = await stored(page, family)
                if (scenario.moves)
                    expect(after.objects, `${scenario.name}, ${tool}`).not.toEqual(before.objects)
                else expect(after, `${scenario.name}, ${tool}`).toEqual(before)
                results.push(after)
            }
            expect(results[1], scenario.name).toEqual(results[0])
        }
    })
}

// An edge resize of an object outside lane limits of 3, pressed at this lane near its on-grid edge.
const resizes = {
    note: { value: 2, press: 3.9 },
    slide: { value: 2, press: 3.9 },
    stageMaskEvent: { value: 2, press: 3.9 },
    cameraEvent: { value: 0, press: 0.1 },
} as const

for (const family of Object.keys(resizes) as (keyof typeof resizes)[]) {
    test(`${family}: a tool edge resize applies lane limits once something moves, as Select's does`, async ({
        page,
    }) => {
        const { value, press } = resizes[family]
        for (const [dx, beats, moves] of [
            [0, 0.45, false],
            [0, 2, true],
            [0.6, 0, true],
        ] as const) {
            const results = []
            for (const tool of [family, 'select'] as const) {
                if (family === 'note' || family === 'slide')
                    await page.evaluate(
                        async ({ tool, value }) => {
                            const { show, fixtures, view, settings, appImport } = window.editorTest
                            const base = fixtures.interaction.slides[0]![0]!
                            show(
                                {
                                    ...fixtures.interaction,
                                    slides: [[{ ...base, beat: 4, left: value, size: 2 }]],
                                },
                                3,
                            )
                            view.laneDivision = 1
                            view.laneSnapping = 'absolute'
                            view.division = 1
                            view.snapping = 'absolute'
                            settings.maxLane = 3
                            const { switchToolTo } = await appImport<
                                typeof import('../../src/editor/tools')
                            >('/src/editor/tools/index.ts')
                            switchToolTo(tool)
                        },
                        { tool, value },
                    )
                else
                    await setup(page, {
                        kind: family,
                        tool: tool === 'select' ? tool : family,
                        value,
                        division: 1,
                        maxLane: 3,
                    })
                const before = await stored(page, family)
                await drag(page, press, dx, beats)
                const after = await stored(page, family)
                const label = `dx ${dx}, beats ${beats}, ${tool}`
                if (moves) {
                    expect(after.objects, label).not.toEqual(before.objects)
                    // A resize, not a move.
                    expect(after.objects.map((object) => object.beat)).toEqual([4])
                } else expect(after, label).toEqual(before)
                results.push(after)
            }
            expect(results[1], `dx ${dx}, beats ${beats}`).toEqual(results[0])
        }
    })
}

// Each object's moving edge at lane 4, pressed at 3.7 inside it: the edge follows the pointer's movement.
const edges = {
    note: { left: 2, size: 2 },
    slide: { left: 2, size: 2 },
    stageMaskEvent: { left: 2, size: 2 },
    cameraEvent: { left: -2, size: 6 },
} as const
const rightEdges = (objects: object[]) =>
    objects.map((object) => {
        const fields = object as Record<string, number>
        const left = fields.left ?? fields.maskLeft ?? fields.cameraLeft!
        const size = fields.size ?? fields.maskSize ?? fields.cameraSize!
        return left + size
    })

for (const family of Object.keys(edges) as (keyof typeof edges)[]) {
    test(`${family}: an edge resize moves the edge by the pointer's movement, in the tool and in Select`, async ({
        page,
    }) => {
        const { left, size } = edges[family]
        for (const [laneSnapping, dx, edge] of [
            ['absolute', 0.6, 5],
            ['absolute', 0.4, 4],
            ['absolute', -0.3, 4],
            ['relative', 0.6, 5],
            ['relative', -0.6, 3],
        ] as const) {
            const results = []
            for (const tool of [family, 'select'] as const) {
                await page.evaluate(
                    async ({ family, tool, left, size, laneSnapping }) => {
                        const { show, fixtures, view, settings, history, appImport } =
                            window.editorTest
                        const base = fixtures.interaction.slides[0]![0]!
                        const events = fixtures.events
                        show(
                            {
                                ...fixtures.interaction,
                                slides:
                                    family === 'note' || family === 'slide'
                                        ? [[{ ...base, beat: 4, left, size }]]
                                        : [],
                                stageMaskEvents:
                                    family === 'stageMaskEvent'
                                        ? [
                                              {
                                                  ...events.stageMaskEvents[0]!,
                                                  beat: 4,
                                                  maskLeft: left,
                                                  maskSize: size,
                                              },
                                          ]
                                        : [],
                                cameraEvents:
                                    family === 'cameraEvent'
                                        ? [
                                              {
                                                  ...events.cameraEvents[0]!,
                                                  beat: 4,
                                                  cameraLeft: left,
                                                  cameraSize: size,
                                              },
                                          ]
                                        : [],
                            },
                            3,
                        )
                        view.laneDivision = 1
                        view.laneSnapping = laneSnapping
                        view.division = 1
                        view.snapping = 'absolute'
                        settings.maxLane = 0
                        const { switchToolTo } = await appImport<
                            typeof import('../../src/editor/tools')
                        >('/src/editor/tools/index.ts')
                        switchToolTo(tool)
                        const source = history.state.value
                        history.replaceState({ ...source, selectedEntities: [] })
                    },
                    { family, tool, left, size, laneSnapping },
                )
                const before = await stored(page, family)
                await drag(page, 3.7, dx, 0)
                const after = await stored(page, family)
                const label = `${laneSnapping} ${dx} ${tool}`
                // A camera keeps its minimum size of 6.
                const expected = family === 'cameraEvent' ? Math.max(edge, 4) : edge
                expect(rightEdges(after.objects), label).toEqual([expected])
                if (expected === 4) expect(after, label).toEqual(before)
                results.push(after)
            }
            expect(results[1], `${laneSnapping} ${dx}`).toEqual(results[0])
        }
    })
}

for (const family of ['stageMaskEvent', 'cameraEvent'] as const) {
    test(`${family}: a Select resize moves each selected range's edge by the pointer's movement`, async ({
        page,
    }) => {
        await page.evaluate(
            async ({ family }) => {
                const { show, fixtures, view, settings, history, appImport } = window.editorTest
                const events = fixtures.events
                const ranges = [
                    { beat: 4, left: -2, size: 6 },
                    { beat: 5, left: -1.5, size: 7.5 },
                ]
                show(
                    {
                        ...fixtures.interaction,
                        slides: [],
                        stageMaskEvents:
                            family === 'stageMaskEvent'
                                ? ranges.map(({ beat, left, size }) => ({
                                      ...events.stageMaskEvents[0]!,
                                      beat,
                                      maskLeft: left,
                                      maskSize: size,
                                  }))
                                : [],
                        cameraEvents:
                            family === 'cameraEvent'
                                ? ranges.map(({ beat, left, size }) => ({
                                      ...events.cameraEvents[0]!,
                                      beat,
                                      cameraLeft: left,
                                      cameraSize: size,
                                  }))
                                : [],
                    },
                    3,
                )
                view.laneDivision = 1
                view.laneSnapping = 'absolute'
                view.division = 1
                view.snapping = 'absolute'
                settings.maxLane = 0
                const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                    '/src/editor/tools/index.ts',
                )
                switchToolTo('select')
                const source = history.state.value
                const grid =
                    family === 'stageMaskEvent'
                        ? source.store.grid.stageMaskEventJoint
                        : source.store.grid.cameraEventJoint
                history.replaceState({
                    ...source,
                    selectedEntities: [...grid.values()].flatMap((bucket) => [...bucket]),
                })
            },
            { family },
        )
        // The first range's right edge at 4, pressed at 3.7; the second's, at 6, moves with it.
        const { start, width } = await page.evaluate(() => {
            const { point, view, settings } = window.editorTest
            return { start: point(3.7, 4), width: view.w / settings.width }
        })
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(start.x + 1.1 * width, start.y, { steps: 4 })
        expect(await page.evaluate(() => window.editorTest.view.entities.creating.length)).toBe(2)
        await page.mouse.up()
        expect(rightEdges((await stored(page, family)).objects)).toEqual([5, 7])
    })
}

test('note and slide: a Composed edge resize on thirds stores exactly what Select does', async ({
    page,
}) => {
    const results = await page.evaluate(async () => {
        const { show, fixtures, view, settings, history, point, appImport } = window.editorTest
        const { tools } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const base = fixtures.interaction.slides[0]![0]!
        const pivot = fixtures.events.stagePivotEvents[0]!
        const modifiers = { ctrl: false, shift: false }
        const sizes: Record<string, number[]> = { note: [], slide: [], select: [] }
        for (const tool of ['note', 'slide', 'select'] as const) {
            for (let i = 0; i < 24; i++) {
                // An odd-parity stage puts the lattice half a lane off; its thirds carry float noise.
                show(
                    {
                        ...fixtures.interaction,
                        isDynamicStages: true,
                        stagePivotEvents: [
                            {
                                ...pivot,
                                beat: 0,
                                pivotLane: 0.2,
                                divisionSize: 1,
                                divisionParity: 'odd',
                            },
                        ],
                        slides: [[{ ...base, beat: 4, left: 2 / 3, size: 3 }]],
                    },
                    3,
                )
                view.layout = 'composed'
                view.laneDivision = 3
                view.laneSnapping = 'absolute'
                settings.maxLane = 0
                const source = history.state.value
                const note = [...source.store.slides.note.values()].flat()[0]!
                history.replaceState({
                    ...source,
                    selectedEntities: tool === 'select' ? [note] : [],
                })
                const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                    '/src/editor/tools/index.ts',
                )
                switchToolTo(tool)
                const shown = createComposedLayout(source).notePosition(note)
                const press = shown.left + shown.size - 0.2
                const start = point(press, 4)
                const end = point(press + 0.05 + i * 0.07, 4)
                tools[tool].dragStart!(start.x, start.y, modifiers)
                tools[tool].dragUpdate!(end.x, end.y, modifiers)
                await tools[tool].dragEnd!(end.x, end.y, modifiers)
                sizes[tool]!.push(
                    [...history.state.value.store.slides.note.values()].flat()[0]!.size,
                )
            }
        }
        return sizes
    })
    expect(results.note).toEqual(results.select)
    expect(results.slide).toEqual(results.select)
})

// Presses x at a beat, moves to (x + dx, beat + beats) by way of the middle, and releases.
const dragFrom = async (page: Page, x: number, beat: number, dx: number, beats: number) => {
    const { start, end, width } = await page.evaluate(
        ({ x, beat, beats }) => {
            const { point, view, settings } = window.editorTest
            return {
                start: point(x, beat),
                end: point(x, beat + beats),
                width: view.w / settings.width,
            }
        },
        { x, beat, beats },
    )
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + (dx * width) / 2, (start.y + end.y) / 2, { steps: 4 })
    await page.mouse.move(start.x + dx * width, end.y, { steps: 4 })
    await page.mouse.up()
}

for (const family of ['stageMaskEvent', 'cameraEvent'] as const) {
    test(`${family}: a Select resize moves every selected range's edge by the grabbed edge's snapped shift`, async ({
        page,
    }) => {
        // Right edges at 6 (grabbed) and 7.5; a camera is at least 6 wide.
        for (const [dx, beats, edges] of [
            [1, 0, [7, 8.5]],
            [0, 2, [6, 7.5]],
            [-1, 0, family === 'cameraEvent' ? [6, 6.5] : [5, 6.5]],
        ] as const) {
            await page.evaluate(
                async ({ family }) => {
                    const { show, fixtures, view, settings, history, appImport } = window.editorTest
                    const events = fixtures.events
                    const ranges = [
                        { beat: 4, size: 6 },
                        { beat: 5, size: 7.5 },
                    ]
                    show(
                        {
                            ...fixtures.interaction,
                            slides: [],
                            stageMaskEvents:
                                family === 'stageMaskEvent'
                                    ? ranges.map(({ beat, size }) => ({
                                          ...events.stageMaskEvents[0]!,
                                          beat,
                                          maskLeft: 0,
                                          maskSize: size,
                                      }))
                                    : [],
                            cameraEvents:
                                family === 'cameraEvent'
                                    ? ranges.map(({ beat, size }) => ({
                                          ...events.cameraEvents[0]!,
                                          beat,
                                          cameraLeft: 0,
                                          cameraSize: size,
                                      }))
                                    : [],
                        },
                        3,
                    )
                    view.laneDivision = 1
                    view.laneSnapping = 'absolute'
                    view.division = 1
                    view.snapping = 'absolute'
                    settings.maxLane = 0
                    const { switchToolTo } = await appImport<
                        typeof import('../../src/editor/tools')
                    >('/src/editor/tools/index.ts')
                    switchToolTo('select')
                    const source = history.state.value
                    const grid =
                        family === 'stageMaskEvent'
                            ? source.store.grid.stageMaskEventJoint
                            : source.store.grid.cameraEventJoint
                    history.replaceState({
                        ...source,
                        selectedEntities: [...grid.values()].flatMap((bucket) => [...bucket]),
                    })
                },
                { family },
            )
            const before = await stored(page, family)
            await dragFrom(page, 5.7, 4, dx, beats)
            const after = await stored(page, family)
            const label = `dx ${dx}, beats ${beats}`
            expect(rightEdges(after.objects), label).toEqual(edges)
            // Without a shift, nothing is edited.
            if (dx === 0) expect(after, label).toEqual(before)
            else expect(after.canUndo, label).toBe(true)
        }
    })
}

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: a Select resize of several notes moves every edge by the grabbed edge's snapped shift`, async ({
        page,
    }) => {
        // A's right edge on the lattice, grabbed; B's half a lane off it; C's on a third.
        const sizes = [2, 3.5, 10 / 3]
        for (const [dx, beats, shift] of [
            [1, 0, 1],
            [0, 2, 0],
            // A stops at its minimum width of a lane.
            [-1.9, 0, -2],
        ] as const) {
            const { press, grid } = await page.evaluate(
                async ({ layout, sizes }) => {
                    const { show, fixtures, view, settings, history, appImport } = window.editorTest
                    const { createComposedLayout } =
                        await appImport<typeof import('../../src/editor/composed')>(
                            '/src/editor/composed.ts',
                        )
                    const base = fixtures.interaction.slides[0]![0]!
                    const pivot = fixtures.events.stagePivotEvents[0]!
                    const chart = (grid: number) => ({
                        ...fixtures.interaction,
                        isDynamicStages: layout === 'composed',
                        stagePivotEvents:
                            layout === 'composed'
                                ? [{ ...pivot, beat: 0, pivotLane: 0.2, divisionSize: 1 }]
                                : [],
                        slides: sizes.map((size, i) => [
                            { ...base, beat: 4 + i, left: grid + i, size },
                        ]),
                    })
                    show(chart(0), 3)
                    view.layout = layout
                    view.laneDivision = 1
                    view.laneSnapping = 'absolute'
                    view.division = 1
                    view.snapping = 'absolute'
                    settings.maxLane = 0
                    const layoutOf = () =>
                        layout === 'composed'
                            ? createComposedLayout(history.state.value)
                            : undefined
                    const grid = layoutOf()?.gridOffset(base.stageId, 4) ?? 0
                    show(chart(grid), 3)
                    const source = history.state.value
                    const notes = [...source.store.slides.note.values()].flat()
                    history.replaceState({ ...source, selectedEntities: notes })
                    const { switchToolTo } = await appImport<
                        typeof import('../../src/editor/tools')
                    >('/src/editor/tools/index.ts')
                    switchToolTo('select')
                    const a = notes.find((note) => note.beat === 4)!
                    const shown = layoutOf()?.notePosition(a) ?? a
                    return { press: shown.left + shown.size - 0.3, grid }
                },
                { layout, sizes },
            )
            const before = await stored(page, 'note')
            await dragFrom(page, press, 4, dx, beats)
            const after = await stored(page, 'note')
            const label = `dx ${dx}, beats ${beats}`
            const fields = after.objects as { left: number; size: number }[]
            expect(
                fields.map((note) => note.left),
                label,
            ).toEqual([grid, grid + 1, grid + 2])
            fields.forEach((note, i) =>
                expect(note.size, `${label}, ${i}`).toBeCloseTo(Math.max(sizes[i]! + shift, 1), 9),
            )
            // Without a shift, nothing is edited.
            if (shift === 0) expect(after, label).toEqual(before)
            else expect(after.canUndo, label).toBe(true)
        }
    })
}

for (const family of Object.keys(edges) as (keyof typeof edges)[]) {
    test(`${family}: a tool edge resize dragged only along the beats edits nothing`, async ({
        page,
    }) => {
        const { left, size } = edges[family]
        await page.evaluate(
            async ({ family, left, size }) => {
                const { show, fixtures, view, settings, appImport } = window.editorTest
                const base = fixtures.interaction.slides[0]![0]!
                const events = fixtures.events
                show(
                    {
                        ...fixtures.interaction,
                        slides:
                            family === 'note' || family === 'slide'
                                ? [[{ ...base, beat: 4, left, size }]]
                                : [],
                        stageMaskEvents:
                            family === 'stageMaskEvent'
                                ? [
                                      {
                                          ...events.stageMaskEvents[0]!,
                                          beat: 4,
                                          maskLeft: left,
                                          maskSize: size,
                                      },
                                  ]
                                : [],
                        cameraEvents:
                            family === 'cameraEvent'
                                ? [
                                      {
                                          ...events.cameraEvents[0]!,
                                          beat: 4,
                                          cameraLeft: left,
                                          cameraSize: size,
                                      },
                                  ]
                                : [],
                    },
                    3,
                )
                view.laneDivision = 1
                view.laneSnapping = 'absolute'
                view.division = 1
                view.snapping = 'absolute'
                settings.maxLane = 0
                const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                    '/src/editor/tools/index.ts',
                )
                switchToolTo(family)
            },
            { family, left, size },
        )
        const before = await stored(page, family)
        await drag(page, 3.7, 0, 2)
        expect(await stored(page, family)).toEqual(before)
    })
}
