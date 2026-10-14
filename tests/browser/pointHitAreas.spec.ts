import { expect, test, type Page } from '@playwright/test'
import type { Chart } from '../../src/chart'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// A marker's primary area is its whole hit area: it ranks there when selected or raised.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

type Build = 'pivots' | 'cameras' | 'closePivots' | 'cameraRow' | 'bpm' | 'timeScales'

// A note across lane 0 at beat 4, and markers for each build.
const show = (page: Page, build: Build, width = 16) =>
    page.evaluate(
        async ({ build, width }) => {
            const { show, fixtures, settings, view, appImport } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            const events = fixtures.events
            const pivot = { ...events.stagePivotEvents[0]!, pivotLane: 0, stageId: 1 as never }
            const camera = { ...events.cameraEvents[0]!, cameraLeft: -6, cameraSize: 12 }
            const timeScale = {
                ...events.timeScales[0]!,
                groupId: base.groupId,
                editorLane: 0,
                hideNotes: false,
            }
            const chart: Chart = {
                ...events,
                bpms: [{ beat: 0, bpm: 120 }],
                cameraEvents: [],
                stageMaskEvents: [],
                stagePivotEvents: [],
                stageStyleEvents: [],
                stageTransformEvents: [],
                timeScales: [],
                slides: [[{ ...base, beat: 4, left: -2, size: 4 }]],
            }
            switch (build) {
                case 'pivots':
                    chart.stagePivotEvents = [
                        { ...pivot, beat: 4 },
                        { ...pivot, beat: 8 },
                    ]
                    break
                case 'cameras':
                    chart.cameraEvents = [
                        { ...camera, beat: 4 },
                        { ...camera, beat: 8 },
                    ]
                    break
                case 'closePivots':
                    // The note under the later one, within the earlier one's area.
                    chart.stagePivotEvents = [
                        { ...pivot, beat: 4 },
                        { ...pivot, beat: 4.1 },
                    ]
                    chart.slides = [[{ ...base, beat: 4.1, left: -2, size: 4 }]]
                    break
                case 'cameraRow':
                    chart.cameraEvents = [{ ...camera, beat: 4 }]
                    chart.slides = [[{ ...base, beat: 4, left: 2, size: 2 }]]
                    break
                case 'bpm':
                    // Notes and pivots under the BPM label, past lane 6.
                    chart.bpms = [
                        { beat: 0, bpm: 120 },
                        { beat: 4, bpm: 120 },
                    ]
                    chart.slides = [[{ ...base, beat: 4, left: 5.5, size: 2 }]]
                    chart.stagePivotEvents = [
                        { ...pivot, beat: 4, pivotLane: 6.5 },
                        { ...pivot, beat: 8, pivotLane: 6.5 },
                    ]
                    break
                case 'timeScales':
                    chart.timeScales = [
                        { ...timeScale, beat: 4 },
                        { ...timeScale, beat: 8 },
                    ]
                    break
            }
            show(chart, 2)
            settings.pps = 240
            settings.width = width
            view.lane = 0
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo('select')
        },
        { build, width },
    )

const select = (page: Page, keys: string[]) =>
    page.evaluate((keys) => {
        const { history, store } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...store.getAllEntities()].filter((entity) =>
                keys.includes(`${entity.type}:${entity.beat}`),
            ),
        })
    }, keys)

const selected = (page: Page) =>
    page.evaluate(() =>
        window.editorTest.history.state.value.selectedEntities.map(
            (entity) => `${entity.type}:${entity.beat}`,
        ),
    )

const tap = async (page: Page, lane: number, beat: number) => {
    const point = await page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), {
        lane,
        beat,
    })
    await page.mouse.move(point.x - 2, point.y)
    await page.mouse.click(point.x, point.y)
}

const hits = (page: Page, lane: number, beat: number) =>
    page.evaluate(
        async ({ lane, beat }) => {
            const { point, appImport } = window.editorTest
            const { pointHitsAt } = await appImport<typeof import('../../src/editor/tools/utils')>(
                '/src/editor/tools/utils.ts',
            )
            const at = point(lane, beat)
            return pointHitsAt(at.x, at.y).hits.map((entity) => `${entity.type}:${entity.beat}`)
        },
        { lane, beat },
    )

test('off its marker, a raised joint takes a tap over a note; unraised, the note does', async ({
    page,
}) => {
    await show(page, 'pivots')
    await tap(page, 0.25, 4)
    expect(await selected(page)).toEqual(['note:4'])
    await select(page, ['stagePivotEventJoint:8'])
    await tap(page, 0.25, 4)
    expect(await selected(page)).toEqual(['stagePivotEventJoint:4'])
})

test("a raised camera's range line takes a tap over a note", async ({ page }) => {
    await show(page, 'cameras')
    await tap(page, 0.5, 4)
    expect(await selected(page)).toEqual(['note:4'])
    await select(page, ['cameraEventJoint:8'])
    await tap(page, 0.5, 4)
    expect(await selected(page)).toEqual(['cameraEventJoint:4'])
})

test("with a joint selected, a tap on a raised chain-mate's marker in its area takes the mate", async ({
    page,
}) => {
    await show(page, 'closePivots')
    await select(page, ['stagePivotEventJoint:4'])
    expect(await hits(page, 0, 4.1)).toEqual([
        'stagePivotEventJoint:4',
        'stagePivotEventJoint:4.1',
        'note:4.1',
    ])
    await tap(page, 0, 4.1)
    expect(await selected(page)).toEqual(['stagePivotEventJoint:4.1'])
})

test("a tap in a selected camera's row takes the note there", async ({ page }) => {
    await show(page, 'cameraRow')
    await select(page, ['cameraEventJoint:4'])
    expect(await hits(page, 3, 4)).toEqual(['cameraEventJoint:4', 'note:4'])
    await tap(page, 3, 4)
    expect(await selected(page)).toEqual(['note:4'])
})

test('a BPM label ranks over notes, below raised joints and selected objects', async ({ page }) => {
    await show(page, 'bpm')
    expect(await hits(page, 6.5, 4)).toEqual(['bpm:4', 'note:4', 'stagePivotEventJoint:4'])
    await select(page, ['stagePivotEventJoint:8'])
    expect(await hits(page, 6.5, 4)).toEqual(['stagePivotEventJoint:4', 'bpm:4', 'note:4'])
    await select(page, ['note:4'])
    expect(await hits(page, 6.5, 4)).toEqual(['note:4', 'bpm:4', 'stagePivotEventJoint:4'])
})

test("a selected time scale raises its group's markers over notes", async ({ page }) => {
    await show(page, 'timeScales')
    await tap(page, 0.25, 4)
    expect(await selected(page)).toEqual(['note:4'])
    await select(page, ['timeScale:8'])
    await tap(page, 0.25, 4)
    expect(await selected(page)).toEqual(['timeScale:4'])
})

test('a marker area reaches 10 pixels past its hitbox, at any lane width', async ({ page }) => {
    // 0.6 lanes off the marker: past 0.2 lanes and 10 pixels at 16 lanes, within at 100.
    await show(page, 'pivots')
    await select(page, ['stagePivotEventJoint:8'])
    expect((await hits(page, 0.6, 4))[0]).toBe('note:4')
    await show(page, 'pivots', 100)
    await select(page, ['stagePivotEventJoint:8'])
    expect((await hits(page, 0.6, 4))[0]).toBe('stagePivotEventJoint:4')
})

/** Switches to a tool, with a current stage and group, or All for undefined. */
const useTool = (
    page: Page,
    tool: string,
    { stageId, groupId }: { stageId?: number; groupId?: number } = {},
) =>
    page.evaluate(
        async ({ tool, stageId, groupId }) => {
            const { view, appImport, nextTick } = window.editorTest
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo(tool as never)
            view.stageId = stageId as never
            view.groupId = groupId as never
            await nextTick()
        },
        { tool, stageId, groupId },
    )

test('an event tool lifts its type in the current stage, or every stage under All', async ({
    page,
}) => {
    await show(page, 'pivots')
    // Off the pivot's marker, within its area, over the note.
    expect((await hits(page, 0.25, 4))[0]).toBe('note:4')
    await useTool(page, 'stagePivotEvent', { stageId: 1 })
    expect((await hits(page, 0.25, 4))[0]).toBe('stagePivotEventJoint:4')
    // Another stage current: this one dims, so nothing here lifts or takes a press.
    await useTool(page, 'stagePivotEvent', { stageId: 2 })
    expect(await hits(page, 0.25, 4)).toEqual([])
    await useTool(page, 'stagePivotEvent')
    expect((await hits(page, 0.25, 4))[0]).toBe('stagePivotEventJoint:4')
    // Another event type, or a tool that doesn't lift, leaves pivots down.
    await useTool(page, 'stageMaskEvent', { stageId: 1 })
    expect((await hits(page, 0.25, 4))[0]).toBe('note:4')
    for (const tool of ['select', 'note', 'brush']) {
        await useTool(page, tool, { stageId: 1 })
        expect((await hits(page, 0.25, 4))[0]).toBe('note:4')
    }
})

test("a right press keeps the tool's lift while it switches to Select", async ({ page }) => {
    await show(page, 'pivots')
    await useTool(page, 'stagePivotEvent', { stageId: 1 })
    const point = await page.evaluate(() => window.editorTest.point(0.25, 4))
    await page.mouse.move(point.x, point.y)
    await page.mouse.down({ button: 'right' })
    expect(
        await page.evaluate(
            async () =>
                (
                    await window.editorTest.appImport<
                        typeof import('../../src/editor/tools/state')
                    >('/src/editor/tools/state.ts')
                ).toolName.value,
        ),
    ).toBe('select')
    expect((await hits(page, 0.25, 4))[0]).toBe('stagePivotEventJoint:4')
    await page.mouse.up({ button: 'right' })
    await page.keyboard.press('Escape')
})

test("a selection's lifted chain stays up beside the tool's, of the same type or another", async ({
    page,
}) => {
    await show(page, 'pivots')
    // The mask tool lifts masks; a selected pivot lifts its own chain beside them.
    await useTool(page, 'stageMaskEvent')
    await select(page, ['stagePivotEventJoint:8'])
    expect((await hits(page, 0.25, 4))[0]).toBe('stagePivotEventJoint:4')
    // The pivot tool too, and a tool that doesn't lift keeps the selection's.
    for (const tool of ['stagePivotEvent', 'note']) {
        await useTool(page, tool, { stageId: 1 })
        expect((await hits(page, 0.25, 4))[0]).toBe('stagePivotEventJoint:4')
    }
    await select(page, [])
    expect((await hits(page, 0.25, 4))[0]).toBe('note:4')
})

test("the time scale tool lifts the current group's time scales, or every group's under All", async ({
    page,
}) => {
    await show(page, 'timeScales')
    expect((await hits(page, 0.25, 4))[0]).toBe('note:4')
    await useTool(page, 'timeScale', { groupId: 1 })
    expect((await hits(page, 0.25, 4))[0]).toBe('timeScale:4')
    // Another group current: this one dims, so nothing here lifts or takes a press.
    await useTool(page, 'timeScale', { groupId: 2 })
    expect(await hits(page, 0.25, 4)).toEqual([])
    await useTool(page, 'timeScale')
    expect((await hits(page, 0.25, 4))[0]).toBe('timeScale:4')
})
