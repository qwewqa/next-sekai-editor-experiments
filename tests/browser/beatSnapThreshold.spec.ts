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

test('relative beat snapping is unchanged', async ({ page }) => {
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
