import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

type Kind = 'note' | 'bpm' | 'timeScale' | 'stageMaskEventJoint'

const setup = (
    page: Page,
    options: {
        tool: string
        kind?: Kind
        beats?: number[]
        mode?: 'absolute' | 'relative'
        layout?: 'basic' | 'composed'
    },
) =>
    page.evaluate(
        async ({ tool, kind = 'note', beats = [4.375], mode = 'absolute', layout = 'basic' }) => {
            const { show, fixtures, view, history, appImport } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            const chart = {
                ...fixtures.interaction,
                isDynamicStages: layout === 'composed',
                slides:
                    kind === 'note'
                        ? beats.map((beat, index) => [
                              { ...base, beat, left: index * 3 - 2, size: 2 },
                          ])
                        : [],
                bpms:
                    kind === 'bpm'
                        ? [
                              ...fixtures.interaction.bpms,
                              ...beats.map((beat) => ({ beat, bpm: 120 })),
                          ]
                        : fixtures.interaction.bpms,
                timeScales:
                    kind === 'timeScale'
                        ? beats.map((beat) => ({
                              ...fixtures.events.timeScales[0]!,
                              beat,
                              editorLane: -2,
                          }))
                        : [],
                stageMaskEvents:
                    kind === 'stageMaskEventJoint'
                        ? beats.map((beat) => ({
                              ...fixtures.events.stageMaskEvents[0]!,
                              beat,
                              maskLeft: -2,
                              maskSize: 2,
                          }))
                        : [],
            }
            show(chart, 3)
            view.layout = layout
            view.division = 4
            view.snapping = mode
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo(tool as never)
            if (tool === 'select') {
                const source = history.state.value
                history.replaceState({
                    ...source,
                    selectedEntities: [...source.store.grid[kind].values()]
                        .flatMap((bucket) => [...bucket])
                        .filter((entity) => beats.includes(entity.beat)),
                })
            }
        },
        options,
    )

const beatsOf = (page: Page, kind: Kind = 'note') =>
    page.evaluate(
        (kind) =>
            [...window.editorTest.history.state.value.store.grid[kind].values()]
                .flatMap((bucket) => [...bucket])
                .map((entity) => entity.beat)
                .filter((beat) => beat > 0)
                .sort((a, b) => a - b),
        kind,
    )

// Presses the first object at lane, moves a lane sideways and db beats, and releases.
const drag = async (page: Page, lane: number, db: number, from = 4.375) => {
    const { start, end, width } = await page.evaluate(
        ({ lane, db, from }) => {
            const { point, view, settings } = window.editorTest
            return {
                start: point(lane, from),
                end: point(lane, from + db),
                width: view.w / settings.width,
            }
        },
        { lane, db, from },
    )
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + width / 2, start.y, { steps: 3 })
    await page.mouse.move(start.x + width, end.y, { steps: 3 })
    await page.mouse.up()
}

// Division 4: half a step is 1/8 beat.
const cases = [
    [0, 4.375],
    [0.1, 4.375],
    [-0.1, 4.375],
    [0.15, 4.5],
    [-0.15, 4.25],
] as const

for (const tool of ['select', 'note', 'slide'] as const) {
    test(`${tool}: absolute beat snapping waits for half a beat step of pointer movement`, async ({
        page,
    }) => {
        for (const [db, beat] of cases) {
            await setup(page, { tool })
            await drag(page, -1, db)
            expect(await beatsOf(page)).toEqual([beat])
        }
    })
}

test('Composed: an off-grid note keeps its beat in a sideways drag', async ({ page }) => {
    for (const [db, beat] of cases) {
        await setup(page, { tool: 'select', layout: 'composed' })
        await drag(page, -1, db)
        expect(await beatsOf(page)).toEqual([beat])
    }
})

test('event, BPM and time scale tool moves wait the same way', async ({ page }) => {
    for (const [tool, kind, lane] of [
        ['stageMaskEvent', 'stageMaskEventJoint', -1],
        ['bpm', 'bpm', 6.5],
        ['timeScale', 'timeScale', -2],
    ] as const) {
        for (const [db, beat] of cases) {
            await setup(page, { tool, kind })
            await drag(page, lane, db)
            expect(await beatsOf(page, kind), `${tool} ${db}`).toEqual([beat])
        }
    }
})

test('a multi-selection keeps its spacing and moves as one', async ({ page }) => {
    for (const [db, beats] of [
        [0.1, [4.375, 5.125]],
        [0.2, [4.5, 5.25]],
    ] as const) {
        await setup(page, { tool: 'select', beats: [4.375, 5.125] })
        await drag(page, -1, db)
        expect(await beatsOf(page)).toEqual(beats)
    }
})

// Relative beat snapping steps by the pointer's movement from the press, as relative lanes do.
for (const tool of ['select', 'note', 'slide'] as const) {
    test(`${tool}: relative beat snapping steps by the pointer's movement from an off-centre press`, async ({
        page,
    }) => {
        // Division 8 at 400 px per second: half a step is 12.5 px; the press is 18 px off the beat.
        for (const [db, beat] of [
            [0, 4.375],
            [0.04, 4.375],
            [-0.04, 4.375],
            [0.085, 4.5],
            [-0.085, 4.25],
        ] as const) {
            await setup(page, { tool, mode: 'relative' })
            await page.evaluate(() => {
                const { view, settings } = window.editorTest
                view.division = 8
                settings.pps = 400
            })
            await drag(page, -1, db, 4.375 + 0.09)
            expect(await beatsOf(page), `${db}`).toEqual([beat])
        }
    })
}

test('relative beat snapping from a press on the beat', async ({ page }) => {
    for (const [db, beat] of [
        [0.1, 4.375],
        [0.15, 4.625],
        [-0.15, 4.125],
    ] as const) {
        await setup(page, { tool: 'select', mode: 'relative' })
        await drag(page, -1, db)
        expect(await beatsOf(page)).toEqual([beat])
    }
})

// Absolute beat snapping moves the grabbed beat by the pointer's movement, as for lanes.
for (const tool of ['select', 'note', 'slide'] as const) {
    test(`${tool}: a grab away from an off-grid beat never snaps against the pointer`, async ({
        page,
    }) => {
        for (const [press, db, beat] of [
            [5.1, -0.13, 4.75],
            [5.1, 0.13, 5],
            [4.65, 0.13, 5],
            [4.65, -0.13, 4.75],
        ] as const) {
            await setup(page, { tool, beats: [4.875] })
            await page.evaluate(() => {
                window.editorTest.settings.pps = 200
            })
            await drag(page, -1, db, press)
            expect(await beatsOf(page), `${press} ${db}`).toEqual([beat])
        }
    })
}

test('Composed and attached ticks snap from the grabbed beat', async ({ page }) => {
    for (const layout of ['basic', 'composed'] as const) {
        for (const [press, db, beat] of [
            [5.1, -0.13, 4.75],
            [4.65, 0.13, 5],
        ] as const) {
            await page.evaluate(async (layout) => {
                const { show, fixtures, view, settings, history, appImport } = window.editorTest
                const base = fixtures.interaction.slides[0]![0]!
                show(
                    {
                        ...fixtures.interaction,
                        isDynamicStages: layout === 'composed',
                        slides: [
                            [
                                { ...base, beat: 3, left: -2, size: 2 },
                                { ...base, beat: 4.875, left: -2, size: 2, isAttached: true },
                                { ...base, beat: 7, left: -2, size: 2 },
                            ],
                        ],
                    },
                    3,
                )
                view.layout = layout
                view.division = 4
                view.snapping = 'absolute'
                settings.pps = 200
                const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                    '/src/editor/tools/index.ts',
                )
                switchToolTo('select')
                const source = history.state.value
                history.replaceState({
                    ...source,
                    selectedEntities: [...source.store.slides.note.values()]
                        .flat()
                        .filter((note) => note.isAttached),
                })
            }, layout)
            await drag(page, -1, db, press)
            expect(
                await page.evaluate(() =>
                    [...window.editorTest.history.state.value.store.slides.note.values()]
                        .flat()
                        .map((note) => [note.beat, note.isAttached]),
                ),
                `${layout} ${press} ${db}`,
            ).toEqual([
                [3, false],
                [beat, true],
                [7, false],
            ])
        }
    }
})
