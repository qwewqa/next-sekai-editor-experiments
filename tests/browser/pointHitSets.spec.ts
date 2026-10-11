import { expect, test, type Page } from '@playwright/test'
import type { Chart } from '../../src/chart'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Objects acting together, and a selection in reach, count as before; one pick takes the nearest.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const useTool = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const { switchToolTo } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools')
        >('/src/editor/tools/index.ts')
        switchToolTo(name as never)
    }, name)

type Build = 'touching' | 'overlapping' | 'narrowWide' | 'triple'

// 40 pixels a lane, at 120 BPM.
const show = (page: Page, build: Build) =>
    page.evaluate((build) => {
        const { show, fixtures, view, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const chart: Chart = {
            ...fixtures.events,
            isDynamicStages: true,
            bpms: [{ beat: 0, bpm: 120 }],
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [],
            slides: [],
        }
        switch (build) {
            case 'touching':
                chart.slides = [
                    [{ ...base, beat: 4, left: 0, size: 2 }],
                    [{ ...base, beat: 4, left: 2, size: 2 }],
                ]
                break
            case 'overlapping':
                chart.slides = [
                    [{ ...base, beat: 4, left: 0, size: 2.5 }],
                    [{ ...base, beat: 4, left: 1.5, size: 2.5 }],
                ]
                break
            case 'narrowWide':
                chart.slides = [
                    [{ ...base, beat: 4, left: 0, size: 0.4 }],
                    [{ ...base, beat: 4, left: 1, size: 2 }],
                ]
                break
            case 'triple':
                // Two notes 0.4 lanes apart, and a pivot above their gap, all only in reach there.
                chart.slides = [
                    [{ ...base, beat: 4, left: -2.2, size: 2 }],
                    [{ ...base, beat: 4, left: 0.2, size: 2 }],
                ]
                chart.stagePivotEvents = [
                    { ...fixtures.events.stagePivotEvents[0]!, beat: 4.18, pivotLane: 0 },
                ]
                break
        }
        show(chart, 2)
        settings.width = view.w / 40
        settings.pps = 160
        view.lane = 0
    }, build)

const at = (page: Page, lane: number, beat: number) =>
    page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), { lane, beat })

const select = (page: Page, left?: number) =>
    page.evaluate((left) => {
        const { history } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()]
                .flat()
                .filter((note) => note.left === left),
        })
    }, left)

const selected = (page: Page) =>
    page.evaluate(() =>
        window.editorTest.history.state.value.selectedEntities
            .map((entity) => (entity.type === 'note' ? entity.left : entity.type))
            .sort(),
    )

const notes = (page: Page) =>
    page.evaluate(() => window.editorTest.snapshot().notes.map(({ left, size }) => [left, size]))

test('touching notes: Ctrl, a press, the eraser and the brush act on the note under the pointer', async ({
    page,
}) => {
    await show(page, 'touching')
    await useTool(page, 'select')
    // Inside the left note, 8 pixels from the right one.
    const point = await at(page, 1.8, 4)
    await page.keyboard.down('Control')
    await page.mouse.move(point.x - 1, point.y)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.up('Control')
    expect(await selected(page)).toEqual([0])

    // The selected right note is in reach, but not as the set counts it: the press takes the left one.
    await select(page, 2)
    const lane = await page.evaluate(
        () => window.editorTest.view.w / window.editorTest.settings.width,
    )
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.move(point.x, point.y - lane, { steps: 4 })
    await page.mouse.up()
    expect(await selected(page)).toEqual([0])
    await page.evaluate(() => window.editorTest.history.undoState())

    await select(page, 2)
    await useTool(page, 'eraser')
    await page.mouse.move(point.x - 1, point.y)
    await page.mouse.click(point.x, point.y)
    expect(await notes(page)).toEqual([[2, 2]])
})

test('the single pick is always in the set: Ctrl toggles the narrow note and the nearer wide one', async ({
    page,
}) => {
    await show(page, 'narrowWide')
    await useTool(page, 'select')
    // In the narrow note's minimum width, nearer the wide one.
    const point = await at(page, 0.8, 4)
    await page.mouse.move(point.x - 1, point.y)
    await page.mouse.click(point.x, point.y)
    expect(await selected(page)).toEqual([1])
    await select(page)
    await page.keyboard.down('Control')
    await page.mouse.click(point.x, point.y)
    await page.keyboard.up('Control')
    expect(await selected(page)).toEqual([0, 1])
})

test('a cycle keeps its order while the same objects are hit, so a pixel of jitter skips none', async ({
    page,
}) => {
    await show(page, 'triple')
    await useTool(page, 'select')
    const middle = await at(page, 0, 4)
    const sequence = []
    for (const dx of [-1, 1, -1, 1]) {
        await page.mouse.move(middle.x + dx - 1, middle.y)
        await page.mouse.click(middle.x + dx, middle.y)
        sequence.push(...(await selected(page)))
    }
    expect(sequence).toEqual([-2.2, 0.2, 'stagePivotEventJoint', -2.2])
})

test('the hover follows Ctrl and selection changes without a move', async ({ page }) => {
    await show(page, 'overlapping')
    await useTool(page, 'select')
    const point = await at(page, 2, 4)
    await page.mouse.move(point.x - 1, point.y)
    await page.mouse.move(point.x, point.y)
    const hovered = () =>
        page.evaluate(() =>
            window.editorTest.view.entities.hovered
                .map((entity) => (entity.type === 'note' ? entity.left : entity.type))
                .sort(),
        )
    await expect.poll(hovered).toHaveLength(1)
    const [top] = await hovered()
    await page.keyboard.down('Control')
    await expect.poll(hovered).toEqual([0, 1.5])
    await page.keyboard.up('Control')
    await expect.poll(hovered).toEqual([top])
    // With the top one selected, a tap would select the other.
    await select(page, top as number)
    await expect.poll(hovered).toEqual([top === 0 ? 1.5 : 0])
})

test("a cycle keeps its order when a pixel of jitter crosses one object's reach", async ({
    page,
}) => {
    await show(page, 'triple')
    const sequence = await page.evaluate(async () => {
        const { history, fixtures, appImport } = window.editorTest
        const { createTransaction } = await appImport<typeof import('../../src/state/transaction')>(
            '/src/state/transaction.ts',
        )
        const { addStageStyleEventJoint } = await appImport<
            typeof import('../../src/state/mutations/events/stage/style')
        >('/src/state/mutations/events/stage/style.ts')
        // A style whose reach ends exactly between the two taps.
        const transaction = createTransaction(history.state.value)
        addStageStyleEventJoint(transaction, {
            ...fixtures.events.stageStyleEvents[0]!,
            beat: 4,
            editorLane: -0.45,
        })
        history.replaceState(transaction.commit([]))
        const { select } = await appImport<typeof import('../../src/editor/tools/select')>(
            '/src/editor/tools/select.ts',
        )
        const { view, settings, point } = window.editorTest
        const pixel = settings.width / view.w
        const middle = point(0, 4)
        const names = []
        for (const dx of [-1, 1, -1]) {
            void select.tap?.(middle.x + dx, middle.y, { ctrl: false, shift: false })
            const [entity] = history.state.value.selectedEntities
            names.push(entity?.type === 'note' ? entity.left : entity?.type)
        }
        return { names, pixel }
    })
    // The left note, the right one, then the pivot: none skipped while the style comes and goes.
    expect(sequence.names).toEqual([-2.2, 0.2, 'stagePivotEventJoint'])
})
