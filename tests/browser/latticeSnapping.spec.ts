import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

type Tool = 'select' | 'note' | 'slide'
type NoteSpec = { beat: number; left: number; size?: number; isAttached?: boolean; stage?: 1 | 2 }
type PivotSpec = {
    beat: number
    pivotLane: number
    divisionSize?: number
    divisionParity?: 'even' | 'odd'
    eventEase?: 'linear' | 'none'
    stage?: 1 | 2
    // Left out of an all selection.
    unselected?: boolean
}
type Load = {
    tool: Tool
    slides: NoteSpec[][]
    pivots?: PivotSpec[]
    bpms?: { beat: number; bpm: number }[]
    cameras?: { beat: number; cameraLeft: number; cameraSize: number }[]
    // Stage 1 ends at its last mask event.
    masks?: number[]
    layout?: 'basic' | 'composed'
    laneDivision?: number
    laneSnapping?: 'absolute' | 'relative'
    division?: number
    snapping?: 'absolute' | 'relative'
    // Selected for Select: every note, the cameras and pivots too, or the notes at these beats.
    select?: 'notes' | 'all' | number[]
    // BPM changes also selected, by beat.
    selectBpms?: number[]
    beatDisplay?: 'beat' | 'measure' | 'both'
    time?: number
}

const load = (page: Page, options: Load) =>
    page.evaluate(async (o) => {
        const { show, fixtures, view, settings, history, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const pivot = fixtures.events.stagePivotEvents[0]!
        const camera = fixtures.events.cameraEvents[0]!
        const mask = fixtures.events.stageMaskEvents[0]!
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: !!o.pivots,
                ...(o.bpms ? { bpms: o.bpms } : {}),
                ...(o.masks
                    ? {
                          stages: new Map(
                              [...fixtures.interaction.stages].map(([id, stage]) => [
                                  id,
                                  { ...stage, isUntilEnd: (id as number) !== 1 },
                              ]),
                          ),
                          stageMaskEvents: o.masks.map((beat) => ({
                              ...mask,
                              stageId: 1 as never,
                              beat,
                          })),
                      }
                    : {}),
                stagePivotEvents: (o.pivots ?? []).map((spec) => ({
                    ...pivot,
                    stageId: (spec.stage ?? 1) as never,
                    beat: spec.beat,
                    pivotLane: spec.pivotLane,
                    divisionSize: spec.divisionSize ?? 2,
                    divisionParity: spec.divisionParity ?? 'even',
                    eventEase: spec.eventEase ?? 'linear',
                })),
                cameraEvents: (o.cameras ?? []).map((spec) => ({ ...camera, ...spec })),
                slides: o.slides.map((notes) =>
                    notes.map((spec) => ({
                        ...base,
                        beat: spec.beat,
                        left: spec.left,
                        size: spec.size ?? 2,
                        isAttached: !!spec.isAttached,
                        stageId: (spec.stage ?? 1) as never,
                    })),
                ),
            },
            o.time ?? 3,
        )
        view.layout = o.layout ?? 'composed'
        view.laneDivision = o.laneDivision ?? 1
        view.laneSnapping = o.laneSnapping ?? 'absolute'
        view.division = o.division ?? 4
        view.snapping = o.snapping ?? 'absolute'
        settings.maxLane = 0
        settings.pps = 100
        if (o.beatDisplay) settings.beatDisplay = o.beatDisplay
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo(o.tool)
        if (o.tool !== 'select' || !o.select) return
        const source = history.state.value
        const notes = [...source.store.slides.note.values()].flat()
        const select = o.select
        history.replaceState({
            ...source,
            selectedEntities: [
                ...notes.filter((note) => !Array.isArray(select) || select.includes(note.beat)),
                ...(select === 'all'
                    ? [
                          ...source.store.grid.cameraEventJoint.values(),
                          ...source.store.grid.stagePivotEventJoint.values(),
                      ]
                          .flatMap((bucket) => [...bucket])
                          .filter(
                              (entity) =>
                                  !o.pivots?.some(
                                      (spec) =>
                                          spec.unselected &&
                                          entity.type === 'stagePivotEventJoint' &&
                                          entity.beat === spec.beat &&
                                          (entity.stageId as number) === (spec.stage ?? 1),
                                  ),
                          )
                    : []),
                ...[...source.store.grid.bpm.values()]
                    .flatMap((bucket) => [...bucket])
                    .filter((bpm) => o.selectBpms?.includes(bpm.beat)),
            ],
        })
    }, options)

type Stored = { beat: number; left: number; shown: number; stageId: number; isAttached: boolean }

// Notes by beat, with their displayed left; from the scene the canvas draws, or the chart.
const notes = (page: Page, scene = false) =>
    page.evaluate(async (scene) => {
        const { history, appImport } = window.editorTest
        const { sceneState } = await appImport<typeof import('../../src/editor/sceneState')>(
            '/src/editor/sceneState.ts',
        )
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const { view } = window.editorTest
        const source = scene ? sceneState.value : history.state.value
        const layout =
            view.layout === 'composed' && source.isDynamicStages
                ? createComposedLayout(source)
                : undefined
        return [...source.store.slides.note.values()]
            .flat()
            .sort((a, b) => a.beat - b.beat)
            .map((note): Stored => ({
                beat: note.beat,
                left: note.left,
                shown: layout ? layout.notePosition(note).left : note.left,
                stageId: note.stageId as number,
                isAttached: note.isAttached,
            }))
    }, scene)

// A stage's lattice at a beat in the chart: its offset and its grid's phase.
const lattice = (page: Page, beat: number, stage = 1) =>
    page.evaluate(
        async ({ beat, stage }) => {
            const { history, appImport } = window.editorTest
            const { createComposedLayout } =
                await appImport<typeof import('../../src/editor/composed')>(
                    '/src/editor/composed.ts',
                )
            const layout = createComposedLayout(history.state.value)
            return {
                offset: layout.offset(stage as never, beat),
                grid: layout.gridOffset(stage as never, beat),
            }
        },
        { beat, stage },
    )

// A whole number of lane steps at one division.
const expectOnGrid = (lanes: number) =>
    expect(Math.abs(lanes - Math.round(lanes))).toBeLessThan(1e-9)

const canUndo = (page: Page) =>
    page.evaluate(async () => {
        const { canUndo } =
            await window.editorTest.appImport<typeof import('../../src/history')>(
                '/src/history/index.ts',
            )
        return canUndo.value
    })

// The screen point of a displayed lane at a beat, through the chart's tempo.
const at = (page: Page, lane: number, beat: number) =>
    page.evaluate(
        async ({ lane, beat }) => {
            const { view, settings, history, appImport } = window.editorTest
            const { beatToTime } = await appImport<typeof import('../../src/state/integrals/bpms')>(
                '/src/state/integrals/bpms.ts',
            )
            return {
                x: view.x + view.w * (0.5 + (lane - view.lane) / settings.width),
                y:
                    view.y +
                    view.h / 2 -
                    (beatToTime(history.state.value.bpms, beat) - view.time) * settings.pps,
            }
        },
        { lane, beat },
    )

// Presses the note at beat (its displayed middle, or the given lane), moves dx lanes and to beat to; releases unless held.
const drag = async (
    page: Page,
    from: number,
    to: number,
    dx: number,
    { lane, hold = false }: { lane?: number; hold?: boolean } = {},
) => {
    const note = (await notes(page)).find((note) => note.beat === from)!
    const press = lane ?? note.shown + 1
    const start = await at(page, press, from)
    const end = await at(page, press + dx, to)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 })
    await page.mouse.move(end.x, end.y, { steps: 4 })
    if (!hold) await page.mouse.up()
}

const tools: Tool[] = ['select', 'note', 'slide']

for (const tool of tools) {
    test(`${tool}: half a lane of stage movement with a parity flip snaps an on-grid note back onto the grid`, async ({
        page,
    }) => {
        // The drawn lines stay where they were; a waiting note would sit half a lane off them.
        const pivots: PivotSpec[] = [
            { beat: 1, pivotLane: 0, divisionSize: 11 },
            { beat: 9, pivotLane: 0.5, divisionSize: 11, divisionParity: 'odd' },
        ]
        for (const [laneDivision, from, left] of [
            [1, 1, 0.5],
            // Half a lane is a whole step of two divisions: the note waits under the pointer, keeping its fraction.
            [2, 1, 0.5],
            [2, 1.2, 0.7],
        ] as const) {
            await load(page, {
                tool,
                pivots,
                slides: [[{ beat: 1, left: from }]],
                laneDivision,
                select: 'notes',
                time: 3.25,
            })
            const [before] = await notes(page)
            await drag(page, 1, 12, 0)
            const [moved] = await notes(page)
            expect(moved).toMatchObject({ beat: 12, left })
            expect(moved!.shown).toBeCloseTo(before!.shown)
        }
    })

    test(`${tool}: a forced snap's tie lands half a lane right, through float noise`, async ({
        page,
    }) => {
        // Half a lane exactly, and half a lane plus float noise.
        for (const [last, lane, from, to] of [
            [8, 2.2, 4, 6],
            [12, 2, 3.25, 6.25],
        ] as const) {
            const pivots: PivotSpec[] = [
                { beat: 0, pivotLane: last === 8 ? 0.2 : 0 },
                { beat: last, pivotLane: lane },
            ]
            await load(page, { tool, pivots, slides: [[{ beat: from, left: 1 }]] })
            const shift = (await lattice(page, to)).offset - (await lattice(page, from)).offset
            if (last === 8) expect(shift).toBe(0.5)
            else expect(shift).toBeGreaterThan(0.5)
            // Where the pointer grabs the note changes the noise; every press lands the same.
            const lefts = await page.evaluate(
                async ({ tool, from, to }) => {
                    const { history, point, appImport } = window.editorTest
                    const { tools } = await appImport<typeof import('../../src/editor/tools')>(
                        '/src/editor/tools/index.ts',
                    )
                    const { createComposedLayout } =
                        await appImport<typeof import('../../src/editor/composed')>(
                            '/src/editor/composed.ts',
                        )
                    const source = history.state.value
                    const note = [...source.store.slides.note.values()].flat()[0]!
                    const shown = createComposedLayout(source).notePosition(note).left
                    const modifiers = { ctrl: false, shift: false }
                    const lefts = new Set<number>()
                    for (let i = 0; i <= 40; i++) {
                        history.replaceState({
                            ...source,
                            selectedEntities: tool === 'select' ? [note] : [],
                        })
                        const start = point(shown + 0.3 + i * 0.035, from)
                        const end = point(shown + 0.3 + i * 0.035, to)
                        tools[tool].dragStart!(start.x, start.y, modifiers)
                        tools[tool].dragUpdate!(end.x, end.y, modifiers)
                        await tools[tool].dragEnd!(end.x, end.y, modifiers)
                        lefts.add(
                            [...history.state.value.store.slides.note.values()].flat()[0]!.left,
                        )
                        history.replaceState(source)
                    }
                    return [...lefts]
                },
                { tool, from, to },
            )
            expect(lefts).toEqual([1])
        }
    })

    test(`${tool}: the snap is judged anew on each update, and returns to the wait`, async ({
        page,
    }) => {
        await load(page, {
            tool,
            pivots: [
                { beat: 0, pivotLane: 0.2 },
                { beat: 8, pivotLane: 2.2 },
            ],
            slides: [[{ beat: 4, left: 1.37 }]],
            select: 'notes',
        })
        await drag(page, 4, 5, 0, { hold: true })
        const snapped = (await notes(page, true)).find((note) => note.beat === 5)!
        expectOnGrid(snapped.left)
        // Back at the press beat, the fraction is back and nothing is edited.
        const back = await at(page, (await notes(page))[0]!.shown + 1, 4)
        await page.mouse.move(back.x, back.y, { steps: 4 })
        await page.mouse.up()
        expect((await notes(page))[0]).toMatchObject({ beat: 4, left: 1.37 })
        expect(await canUndo(page)).toBe(false)
    })
}

test('Select: every note moves by the grabbed one, also when it lands exactly on a stepped stage event', async ({
    page,
}) => {
    // A third of a beat moved by 1 is the pivot's beat; the other note's own move is a float step off it.
    await load(page, {
        tool: 'select',
        pivots: [
            { beat: 0, pivotLane: 0, eventEase: 'none' },
            { beat: 4 / 3, pivotLane: 0.6 },
        ],
        slides: [[{ beat: 1 / 3, left: 1 }], [{ beat: 5 / 3, left: 3 }]],
        snapping: 'relative',
        select: 'notes',
        time: 0.75,
    })
    expect(
        await page.evaluate(async () => {
            const { toMovedBeat } =
                await window.editorTest.appImport<typeof import('../../src/editor/view')>(
                    '/src/editor/view.ts',
                )
            return toMovedBeat(1 / 3, toMovedBeat(5 / 3, 1) - 5 / 3) === 4 / 3
        }),
    ).toBe(false)
    await drag(page, 1 / 3, 4 / 3, 0)
    const moved = await notes(page)
    // Bit-equal to the event's beat, on its left side: the stage hasn't moved for the grabbed note.
    expect(moved[0]!.beat).toBe(4 / 3)
    expect(moved.map((note) => note.left)).toEqual([1, 3])
})

test('Select: a note moved by another onto an off-grid stage event on a bar line lands on its beat in the Measure display', async ({
    page,
}) => {
    // Bars restart at 2.3; the event is on a third of that bar, off the beat grid.
    const event = 2.3 + 5 / 3
    await load(page, {
        tool: 'select',
        bpms: [
            { beat: 0, bpm: 120 },
            { beat: 2.3, bpm: 120 },
        ],
        beatDisplay: 'measure',
        division: 3,
        pivots: [
            { beat: 0, pivotLane: 0, eventEase: 'none' },
            { beat: event, pivotLane: 0.6 },
        ],
        slides: [[{ beat: 2.3 + 1 / 3, left: 1 }], [{ beat: 2.3 + 2 / 3, left: 3 }]],
        select: 'notes',
        time: 1.3,
    })
    // Placed there through the bar grid.
    const placed = await page.evaluate(async (event) => {
        const { history, view, appImport } = window.editorTest
        const { snapBeat, toBeatGrid } = await appImport<
            typeof import('../../src/state/integrals/grid')
        >('/src/state/integrals/grid.ts')
        return snapBeat(toBeatGrid(history.state.value.bpms), event + 0.1, view.division)
    }, event)
    expect(placed).toBe(event)
    // The second note plus the first's move is a float step off it.
    expect(2.3 + 2 / 3 + (2.3 + 4 / 3 - (2.3 + 1 / 3))).not.toBe(event)
    await drag(page, 2.3 + 1 / 3, 2.3 + 4 / 3, 0)
    const moved = await notes(page)
    expect(moved.map((note) => note.beat)).toEqual([2.3 + 4 / 3, event])
    // On the event's left side, where the stage hasn't moved.
    expect(moved.map((note) => note.left)).toEqual([1, 3])
})

test('Select: with a BPM change in the moved stretch, the lattice is judged at the beat the note drops at', async ({
    page,
}) => {
    // Bars restart at the change; moved with it, the note snaps on the grid from before the move.
    await load(page, {
        tool: 'select',
        pivots: [
            { beat: 0, pivotLane: 0.2 },
            { beat: 8, pivotLane: 2.2 },
        ],
        bpms: [
            { beat: 0, bpm: 120 },
            { beat: 2.3, bpm: 240 },
        ],
        beatDisplay: 'measure',
        slides: [[{ beat: 4, left: 1.37 }]],
        select: 'notes',
        selectBpms: [2.3],
        time: 1.6,
    })
    // The committed grid's line nearest 6: quarters from 2.3, so 6.05.
    const line = await page.evaluate(async () => {
        const { history, view, appImport } = window.editorTest
        const { snapBeat, toBeatGrid } = await appImport<
            typeof import('../../src/state/integrals/grid')
        >('/src/state/integrals/grid.ts')
        return snapBeat(toBeatGrid(history.state.value.bpms), 6, view.division)
    })
    expect(line).toBeCloseTo(6.05, 9)
    await drag(page, 4, 6, 0, { hold: true })
    const held = await page.evaluate(() => {
        const [note] = window.editorTest.view.entities.creating
        return note?.type === 'note' ? note.beat : undefined
    })
    await page.mouse.up()
    const [moved] = await notes(page)
    const result = await page.evaluate(async (beat) => {
        const { history, view, appImport } = window.editorTest
        const { getComposedLattice } = await appImport<
            typeof import('../../src/editor/composedView')
        >('/src/editor/composedView.ts')
        const { isLatticeMoved } =
            await appImport<typeof import('../../src/editor/snapping')>('/src/editor/snapping.ts')
        const { undoState } =
            await appImport<typeof import('../../src/history')>('/src/history/index.ts')
        const dropped = history.state.value
        const to = getComposedLattice(1 as never, beat, dropped)
        undoState()
        const from = getComposedLattice(1 as never, 4, history.state.value)
        return {
            bpms: dropped.bpms.map(({ x }) => x),
            moved: isLatticeMoved(from, to, view.laneDivision),
            grid: to?.grid,
        }
    }, moved!.beat)
    expect(held).toBe(line)
    expect(moved!.beat).toBe(held)
    expect(result.bpms[0]).toBe(0)
    expect(result.bpms[1]).toBeCloseTo(2.3 + held! - 4, 9)
    // The retimed stretch moves the stage lattice there, so the note is on its grid.
    expect(result.moved).toBe(true)
    expectOnGrid(moved!.left - result.grid!)
})

test('Select: a note moved with all its stage events keeps the wait, unless a tempo change retimes the stretch', async ({
    page,
}) => {
    for (const bpms of [
        undefined,
        [
            { beat: 0, bpm: 120 },
            { beat: 1, bpm: 240 },
        ],
    ]) {
        await load(page, {
            tool: 'select',
            pivots: [
                { beat: 0, pivotLane: 0.2 },
                { beat: 8, pivotLane: 2.2 },
            ],
            bpms,
            slides: [[{ beat: 4, left: 1.37 }]],
            select: 'all',
            time: bpms ? 1.6 : 3,
        })
        await drag(page, 4, 6, 0)
        const [moved] = await notes(page)
        expect(moved!.beat).toBe(6)
        if (bpms) {
            const { grid } = await lattice(page, 6)
            expectOnGrid(moved!.left - grid)
        } else expect(moved!.left).toBe(1.37)
    }
})

test('Select: a note and a pivot of another stage snap when the note’s stage lattice moves', async ({
    page,
}) => {
    await load(page, {
        tool: 'select',
        pivots: [
            { beat: 0, pivotLane: 0.2, unselected: true },
            { beat: 8, pivotLane: 2.2, unselected: true },
            { beat: 4, pivotLane: 6, stage: 2 },
        ],
        slides: [[{ beat: 4, left: 1.37 }]],
        select: 'all',
    })
    await drag(page, 4, 5, 0)
    const [moved] = await notes(page)
    expect(moved!.beat).toBe(5)
    expectOnGrid(moved!.left - (await lattice(page, 5)).grid)
})

for (const tool of tools) {
    test(`${tool}: a stage that has ended holds its last place, and the preview is the drop`, async ({
        page,
    }) => {
        await load(page, {
            tool,
            pivots: [
                { beat: 0, pivotLane: 0.2 },
                { beat: 6, pivotLane: 1.7 },
            ],
            masks: [0, 6],
            slides: [[{ beat: 4, left: 1.37 }]],
            select: 'notes',
        })
        await drag(page, 4, 8, 0, { hold: true })
        const preview = await notes(page, true)
        await page.mouse.up()
        const moved = await notes(page)
        expect(moved).toEqual(preview)
        expect(moved[0]).toMatchObject({ beat: 8, left: 1 })
    })
}

test('Select: a lane division change mid-drag judges the lattice again', async ({ page }) => {
    // Stepped from even to odd parity at beat 5, the stage doesn't move otherwise.
    await load(page, {
        tool: 'select',
        pivots: [
            { beat: 0, pivotLane: 0, divisionSize: 1, eventEase: 'none' },
            { beat: 5, pivotLane: 0, divisionSize: 1, divisionParity: 'odd' },
        ],
        slides: [[{ beat: 4, left: 1 }]],
        select: 'notes',
    })
    await drag(page, 4, 6, 0, { hold: true })
    const ghost = () =>
        page.evaluate(() => {
            const [note] = window.editorTest.view.entities.creating
            return note?.type === 'note' ? note.left : undefined
        })
    expect(await ghost()).toBe(1.5)
    await page.evaluate(() => (window.editorTest.view.laneDivision = 2))
    await expect.poll(ghost).toBe(1)
    await page.mouse.up()
    expect((await notes(page))[0]).toMatchObject({ beat: 6, left: 1 })
})

test('Select: a lane division change with the same ghosts rebuilds the preview', async ({
    page,
}) => {
    // At 4 divisions the stage's 1.5 lanes and parity flip are whole steps: the note waits, as a forced snap at 1 would land.
    await load(page, {
        tool: 'select',
        pivots: [
            { beat: 0, pivotLane: 0, divisionSize: 1 },
            { beat: 16, pivotLane: 4, divisionSize: 1, divisionParity: 'odd' },
        ],
        slides: [[{ beat: 3, left: -1 }]],
        laneDivision: 4,
        select: 'notes',
        time: 3,
    })
    const left = await page.evaluate(async () => {
        const { history, view, point, appImport } = window.editorTest
        const { select } = await appImport<typeof import('../../src/editor/tools/select')>(
            '/src/editor/tools/select.ts',
        )
        const { previewEdit } =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const source = history.state.value
        const note = [...source.store.slides.note.values()].flat()[0]!
        const shown = createComposedLayout(source).notePosition(note).left + 1
        const start = point(shown, 3)
        const end = point(shown, 9)
        const modifiers = { ctrl: false, shift: false }
        select.dragStart!(start.x, start.y, modifiers)
        select.dragUpdate!(end.x, end.y, modifiers)
        view.laneDivision = 1
        select.dragUpdate!(end.x, end.y, modifiers)
        const preview = previewEdit.value!.resolve()
        await select.dragEnd!(end.x, end.y, modifiers)
        const left = (state: typeof source) => [...state.store.slides.note.values()].flat()[0]!.left
        return { preview: left(preview), drop: left(history.state.value) }
    })
    expect(left.preview).toBe(left.drop)
})

test('relative lane snapping and the Basic layout keep the wait on a moving stage', async ({
    page,
}) => {
    for (const tool of tools) {
        for (const options of [{ laneSnapping: 'relative' }, { layout: 'basic' }] as const) {
            await load(page, {
                tool,
                pivots: [
                    { beat: 0, pivotLane: 0.2 },
                    { beat: 8, pivotLane: 2.2 },
                ],
                slides: [[{ beat: 4, left: 1.37 }]],
                select: 'notes',
                ...options,
            })
            await drag(page, 4, 6, 0)
            expect((await notes(page))[0], `${tool} ${JSON.stringify(options)}`).toMatchObject({
                beat: 6,
                left: 1.37,
            })
        }
    }
})

// A slide whose middle tick is grabbed: head 0 at beat 4, tick at 5, tail 3 at 6.
const slide = (stages: [1 | 2, 1 | 2, 1 | 2] = [1, 1, 1], left = 0): NoteSpec[][] => [
    [
        { beat: 4, left, stage: stages[0] },
        { beat: 5, left: 0, isAttached: true, stage: stages[1] },
        { beat: 6, left: left + 3, stage: stages[2] },
    ],
]

test('Select: a tick grabbed within its slide snaps the slide by its attach head', async ({
    page,
}) => {
    const tick = async () => (await notes(page)).find((note) => note.beat === 5)!.shown + 1
    const ends = async () =>
        (await notes(page)).filter((note) => !note.isAttached).map((note) => note.left)

    // Basic: past half a lane, the head lands on the grid, and a selected camera moves with it.
    await load(page, {
        tool: 'select',
        layout: 'basic',
        slides: slide(),
        cameras: [{ beat: 4.5, cameraLeft: -3, cameraSize: 6 }],
        select: 'all',
    })
    await drag(page, 5, 5, 0.7, { lane: await tick() })
    expect(await ends()).toEqual([1, 4])
    expect(
        await page.evaluate(() =>
            [...window.editorTest.history.state.value.store.grid.cameraEventJoint.values()]
                .flatMap((bucket) => [...bucket])
                .map((camera) => camera.cameraLeft),
        ),
    ).toEqual([-2])

    // Composed, a stage moving 0.3 lanes: the head and tail stay on the grid.
    const moving: PivotSpec[] = [
        { beat: 0, pivotLane: 0 },
        { beat: 8, pivotLane: 1.2 },
    ]
    await load(page, { tool: 'select', pivots: moving, slides: slide(), select: 'notes' })
    await drag(page, 5, 7, 0, { lane: await tick() })
    expect((await notes(page)).map((note) => note.beat)).toEqual([6, 7, 8])
    expect(await ends()).toEqual([0, 3])

    // A parity flip: the head lands on the new half-lane lattice, to the right.
    const flip: PivotSpec[] = [
        { beat: 0, pivotLane: 0, divisionSize: 1, eventEase: 'none' },
        { beat: 5.5, pivotLane: 0, divisionSize: 1, divisionParity: 'odd' },
    ]
    await load(page, { tool: 'select', pivots: flip, slides: slide(), select: 'notes' })
    await drag(page, 5, 7, 0, { lane: await tick() })
    expect(await ends()).toEqual([0.5, 3.5])

    // Across stages, the head's stage decides: a static tick stage doesn't keep the wait.
    await load(page, {
        tool: 'select',
        pivots: [...moving, { beat: 0, pivotLane: 0, stage: 2 }],
        slides: slide([1, 2, 1]),
        select: 'notes',
    })
    await drag(page, 5, 7, 0, { lane: await tick() })
    const [head, , tail] = await notes(page)
    const { grid } = await lattice(page, 7)
    expectOnGrid(head!.left - grid)
    expect(tail!.left - head!.left).toBe(3)
    // An off-grid head on a static stage keeps its fraction, whatever the tick's stage does.
    await load(page, {
        tool: 'select',
        pivots: [...moving, { beat: 0, pivotLane: 0, stage: 2 }],
        slides: slide([2, 1, 2], 0.37),
        select: 'notes',
    })
    await drag(page, 5, 7, 0, { lane: await tick() })
    expect(await ends()).toEqual([0.37, 3.37])
})

test('Select: a tick taken past an unselected middle note snaps by its attach head at the press', async ({
    page,
}) => {
    // Head 0 at beat 4 and the tick at 5 are selected; the middle note at 5.5 isn't.
    await load(page, {
        tool: 'select',
        layout: 'basic',
        slides: [
            [
                { beat: 4, left: 0 },
                { beat: 5, left: 0, isAttached: true },
                { beat: 5.5, left: 0.37 },
                { beat: 7, left: 3 },
            ],
        ],
        select: [4, 5],
    })
    const tick = (await notes(page)).find((note) => note.beat === 5)!.shown + 1
    await drag(page, 5, 6, 0.7, { lane: tick })
    const moved = await notes(page)
    expect(moved.map((note) => note.beat)).toEqual([5, 5.5, 6, 7])
    expect(moved[0]!.left).toBe(1)
})

test('Select: a tick within its slide whose head stays snaps by its moving tail, or waits', async ({
    page,
}) => {
    const moving: PivotSpec[] = [
        { beat: 0, pivotLane: 0.2 },
        { beat: 8, pivotLane: 2.2 },
    ]
    const tick = async () => (await notes(page)).find((note) => note.beat === 5)!.shown + 1
    for (const head of [0.37, 0.5]) {
        // Composed, straight down a moving stage: the tail stays on the grid.
        await load(page, {
            tool: 'select',
            pivots: moving,
            slides: slide([1, 1, 1], 0).map(([first, ...rest]) => [
                { ...first!, left: head },
                ...rest,
            ]),
            select: [5, 6],
        })
        await drag(page, 5, 6, 0, { lane: await tick() })
        const moved = await notes(page)
        expect(moved.map((note) => note.beat)).toEqual([4, 6, 7])
        expect(moved[0]!.left).toBe(head)
        expectOnGrid(moved[2]!.left - (await lattice(page, 6)).grid)
        // Basic, past half a lane: the tail lands on the grid.
        await load(page, {
            tool: 'select',
            layout: 'basic',
            slides: slide([1, 1, 1], 0).map(([first, ...rest]) => [
                { ...first!, left: head },
                ...rest,
            ]),
            select: [5, 6],
        })
        await drag(page, 5, 5, 0.7, { lane: await tick() })
        expect(
            (await notes(page)).map((note) => note.left).filter((_, index) => index !== 1),
        ).toEqual([head, 4])
    }
    // With neither end moving, a camera moved with the tick snaps from the tick, without forcing.
    await load(page, {
        tool: 'select',
        layout: 'basic',
        slides: slide([1, 1, 1], 0).map(([first, ...rest]) => [{ ...first!, left: 0.37 }, ...rest]),
        cameras: [{ beat: 4.5, cameraLeft: -3, cameraSize: 6 }],
        select: 'all',
    })
    await page.evaluate(() => {
        const { history } = window.editorTest
        const source = history.state.value
        history.replaceState({
            ...source,
            selectedEntities: source.selectedEntities.filter(
                (entity) => entity.type !== 'note' || entity.beat === 5,
            ),
        })
    })
    const derived = (await notes(page)).find((note) => note.beat === 5)!.left
    await drag(page, 5, 5, 0.7, { lane: await tick() })
    const [camera] = await page.evaluate(() =>
        [...window.editorTest.history.state.value.store.grid.cameraEventJoint.values()]
            .flatMap((bucket) => [...bucket])
            .map((camera) => camera.cameraLeft),
    )
    expect(camera).toBeCloseTo(-3 + Math.round(derived + 0.7) - derived, 9)
})

test('Select: an attached slide end and a tick taken past its end snap on their own stage', async ({
    page,
}) => {
    const moving: PivotSpec[] = [
        { beat: 0, pivotLane: 0.2 },
        { beat: 8, pivotLane: 2.2 },
    ]
    // A tick dragged past the tail becomes the end, snapping from its gameplay place.
    await load(page, {
        tool: 'select',
        pivots: moving,
        slides: [
            [
                { beat: 4, left: 0.37 },
                { beat: 5, left: 0, isAttached: true },
                { beat: 6, left: 2.37 },
            ],
        ],
        select: [5],
    })
    const tick = (await notes(page)).find((note) => note.beat === 5)!.shown + 1
    await drag(page, 5, 7, 0, { lane: tick })
    const end = (await notes(page)).find((note) => note.beat === 7)!
    expect((await notes(page)).at(-1)).toEqual(end)
    expectOnGrid(end.left - (await lattice(page, 7)).grid)
    // An attached tail is drawn as a note: it snaps its own authored lane.
    await load(page, {
        tool: 'select',
        pivots: moving,
        slides: [
            [
                { beat: 4, left: 0.37 },
                { beat: 6, left: 2.37, isAttached: true },
            ],
        ],
        select: [6],
    })
    await drag(page, 6, 7, 0)
    const tail = (await notes(page)).at(-1)!
    expect(tail).toMatchObject({ beat: 7, isAttached: true })
    expectOnGrid(tail.left - (await lattice(page, 7)).grid)
})

test('the forced snap and the moved beat it is judged at', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { view, appImport } = window.editorTest
        const { moveLane } = await appImport<typeof import('../../src/editor/tools/utils')>(
            '/src/editor/tools/utils.ts',
        )
        const { toMovedBeat } =
            await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
        view.laneDivision = 1
        view.laneSnapping = 'absolute'
        view.division = 10
        return {
            // An explicit undefined movement is the default: the pointer's, which waits.
            undefined: moveLane(0.37, 0, 0, 0.37, 0, undefined),
            forced: moveLane(0.37, 0, 0, 0.37, 0, Number.POSITIVE_INFINITY),
            // On the beat grid a moved beat is the grid's own value.
            grid: toMovedBeat(0.1, 2.2),
            thirds: [1, 2, 4, 5, 7].map((n) => {
                view.division = 3
                return toMovedBeat(n / 3, 1 / 3 + 0.1 - 0.1) === (n + 1) / 3
            }),
        }
    })
    expect(result).toEqual({
        undefined: 0.37,
        forced: 0,
        grid: 2.3,
        thirds: [true, true, true, true, true],
    })
})

for (const tool of tools) {
    test(`${tool}: Escape during a forced snap cancels the drag cleanly`, async ({ page }) => {
        await load(page, {
            tool,
            pivots: [
                { beat: 0, pivotLane: 0.2 },
                { beat: 8, pivotLane: 2.2 },
            ],
            slides: [[{ beat: 4, left: 1.37 }]],
            select: 'notes',
        })
        const before = await notes(page)
        await drag(page, 4, 5, 0, { hold: true })
        // The preview shows the forced snap.
        expectOnGrid((await notes(page, true)).find((note) => note.beat === 5)!.left)
        await page.keyboard.press('Escape')
        expect(await notes(page, true)).toEqual(before)
        expect(await page.evaluate(() => window.editorTest.view.entities.creating.length)).toBe(0)
        // Moving on and releasing does nothing more.
        const later = await at(page, before[0]!.shown + 1, 6)
        await page.mouse.move(later.x, later.y, { steps: 4 })
        await page.mouse.up()
        expect(await notes(page)).toEqual(before)
        expect(await notes(page, true)).toEqual(before)
        expect(await canUndo(page)).toBe(false)
    })
}
