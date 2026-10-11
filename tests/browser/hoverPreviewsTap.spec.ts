import { expect, test, type Page } from '@playwright/test'
import type { Chart } from '../../src/chart'
import { installCanvasCounters, installEditorFixture, useTool } from './editorFixture'

// The hover highlights exactly what a tap there would act on.

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// Three overlapping notes, one beside them in reach, and markers among them; 40 px a lane.
const showStack = (page: Page) =>
    page.evaluate(() => {
        const { show, fixtures, view, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const events = fixtures.events
        const chart: Chart = {
            ...events,
            isDynamicStages: true,
            bpms: [{ beat: 0, bpm: 120 }],
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [{ ...events.stagePivotEvents[0]!, beat: 4, pivotLane: -1 }],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [
                {
                    ...events.timeScales[0]!,
                    groupId: base.groupId,
                    beat: 4,
                    editorLane: 1.5,
                    hideNotes: false,
                },
            ],
            slides: [
                [{ ...base, beat: 4, left: -2, size: 3 }],
                [{ ...base, beat: 4, left: -1, size: 3 }],
                [{ ...base, beat: 4.05, left: 0, size: 2 }],
                [{ ...base, beat: 4, left: 2.3, size: 1 }],
            ],
        }
        show(chart, 2)
        settings.width = view.w / 40
        settings.pps = 160
        view.lane = 0
    })

const keys = (page: Page, of: 'hovered' | 'selected') =>
    page.evaluate((of) => {
        const { view, history } = window.editorTest
        const list = of === 'hovered' ? view.entities.hovered : history.state.value.selectedEntities
        return list
            .map((entity) => `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`)
            .sort()
    }, of)

const points = async (page: Page) => {
    const result = []
    for (let lane = -2.5; lane <= 3.5; lane += 0.35)
        for (const beat of [3.9, 3.97, 4, 4.03, 4.08, 4.12])
            result.push(
                await page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), {
                    lane,
                    beat,
                }),
            )
    return result
}

const select = (page: Page, which: 'none' | 'inStack' | 'outside') =>
    page.evaluate((which) => {
        const { history } = window.editorTest
        const notes = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({
            ...history.state.value,
            selectedEntities:
                which === 'none'
                    ? []
                    : notes.filter((note) => note.left === (which === 'inStack' ? -1 : 2.3)),
        })
    }, which)

const hoverAt = async (page: Page, point: { x: number; y: number }) => {
    await page.mouse.move(point.x - 1, point.y)
    await page.mouse.move(point.x, point.y)
}

test('Select: the hover is what a tap selects, cycling, with or without a selection there', async ({
    page,
}) => {
    await showStack(page)
    await useTool(page, 'select')
    let checked = 0
    for (const point of await points(page)) {
        for (const which of ['none', 'inStack', 'outside'] as const) {
            await select(page, which)
            await hoverAt(page, point)
            const hovered = await keys(page, 'hovered')
            await page.mouse.down()
            await page.mouse.up()
            const selected = await keys(page, 'selected')
            expect(selected, `${which} at ${point.x},${point.y}`).toEqual(hovered)
            if (hovered.length) checked++
        }
    }
    expect(checked).toBeGreaterThan(30)
})

test('Select with Ctrl: the hover is every object a Ctrl-tap adds or removes', async ({ page }) => {
    await showStack(page)
    await useTool(page, 'select')
    for (const point of (await points(page)).filter((_, i) => i % 3 === 0)) {
        await select(page, 'outside')
        await page.keyboard.down('Control')
        await hoverAt(page, point)
        const hovered = await keys(page, 'hovered')
        const before = await keys(page, 'selected')
        await page.mouse.down()
        await page.mouse.up()
        await page.keyboard.up('Control')
        const after = await keys(page, 'selected')
        if (!hovered.length) {
            expect(after).toEqual(before)
            continue
        }
        const all = hovered.every((entity) => before.includes(entity))
        const expected = all
            ? before.filter((entity) => !hovered.includes(entity))
            : [...new Set([...before, ...hovered])].sort()
        expect(after, `at ${point.x},${point.y}`).toEqual(expected)
    }
})

test('Eraser and Note tool: the hover is what a tap removes or selects', async ({ page }) => {
    await showStack(page)
    const notesKeys = () =>
        page.evaluate(() =>
            [...window.editorTest.store.getAllEntities()]
                .filter((entity) => entity.type !== 'bpm')
                .map(
                    (entity) =>
                        `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`,
                )
                .filter((name) => !name.startsWith('connector'))
                .sort(),
        )
    const all = await notesKeys()
    for (const point of (await points(page)).filter((_, i) => i % 2 === 0)) {
        await useTool(page, 'eraser')
        for (const which of ['none', 'inStack'] as const) {
            await select(page, which)
            await hoverAt(page, point)
            const hovered = await keys(page, 'hovered')
            await page.mouse.down()
            await page.mouse.up()
            const left = await notesKeys()
            expect(
                all.filter((name) => !left.includes(name)),
                `eraser ${which} at ${point.x},${point.y}`,
            ).toEqual(hovered)
            if (hovered.length) await page.evaluate(() => window.editorTest.history.undoState())
        }
        await useTool(page, 'note')
        await select(page, 'none')
        await hoverAt(page, point)
        const hovered = await keys(page, 'hovered')
        await page.mouse.down()
        await page.mouse.up()
        if (hovered.length) expect(await keys(page, 'selected')).toEqual(hovered)
        else await page.evaluate(() => window.editorTest.history.undoState())
        await select(page, 'none')
    }
})

test('Elevation Editor: the hover is what a tap selects, cycling', async ({ page }) => {
    await page.evaluate(async () => {
        const { show, fixtures, settings, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 3, left: -2, size: 3, elevation: 2 }],
                    [{ ...base, beat: 3, left: -1, size: 3, elevation: 2.1 }],
                    [{ ...base, beat: 3, left: 0, size: 2, elevation: 2.2 }],
                    [{ ...base, beat: 3, left: 2.3, size: 1, elevation: 2.05 }],
                ],
            },
            3,
        )
        settings.showSidebar = false
        settings.showPreview = false
        settings.elevationEditorSideBySide = 'disallow'
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(3)
        const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
            '/src/editor/tools/index.ts',
        )
        switchToolTo('select')
    })
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    const grid = await page.evaluate(async () => {
        const { appImport, nextTick } = window.editorTest
        await nextTick()
        const { elevationLayout } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const { elevationBounds } = await appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        const layout = elevationLayout.value
        const middle = layout.rows.find((row) => row.note.elevation === 2.1)!
        const result = []
        for (let lane = -2.5; lane <= 3.5; lane += 0.35)
            for (const dy of [-30, -15, -5, 0, 5, 15, 30])
                result.push({
                    x: elevationBounds.x + layout.xAt(lane),
                    y: elevationBounds.y + middle.y + dy,
                })
        return result
    })
    for (const point of grid) {
        for (const which of ['none', 'inStack', 'outside'] as const) {
            await select(page, which)
            await hoverAt(page, point)
            const hovered = await keys(page, 'hovered')
            await page.mouse.down()
            await page.mouse.up()
            expect(await keys(page, 'selected'), `${which} at ${point.x},${point.y}`).toEqual(
                hovered,
            )
        }
    }
})
