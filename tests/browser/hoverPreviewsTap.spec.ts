import { expect, test, type Page } from '@playwright/test'
import type { Chart } from '../../src/chart'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// The hover highlights exactly what a tap there would act on. Each test plays hundreds of hover and tap
// rounds, so each round takes few round trips.
test.describe.configure({ timeout: 90_000 })

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

type Which = 'none' | 'inStack' | 'outside'

const keys = (page: Page, of: 'hovered' | 'selected') =>
    page.evaluate((of) => {
        const { view, history } = window.editorTest
        const list = of === 'hovered' ? view.entities.hovered : history.state.value.selectedEntities
        return list
            .map((entity) => `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`)
            .sort()
    }, of)

const points = (page: Page) =>
    page.evaluate(() => {
        const result = []
        for (let lane = -2.5; lane <= 3.5; lane += 0.35)
            for (const beat of [3.9, 3.97, 4, 4.03, 4.08, 4.12])
                result.push(window.editorTest.point(lane, beat))
        return result
    })

/** Switches to a tool if given and sets the selection; returns the selection it replaces, the last tap's. */
const select = (page: Page, which: Which, tool?: string) =>
    page.evaluate(
        async ({ which, tool }) => {
            const { history, appImport } = window.editorTest
            if (tool) {
                const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                    '/src/editor/tools/index.ts',
                )
                switchToolTo(tool as never)
            }
            const before = history.state.value.selectedEntities
                .map(
                    (entity) =>
                        `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`,
                )
                .sort()
            const notes = [...history.state.value.store.slides.note.values()].flat()
            history.replaceState({
                ...history.state.value,
                selectedEntities:
                    which === 'none'
                        ? []
                        : notes.filter((note) => note.left === (which === 'inStack' ? -1 : 2.3)),
            })
            return before
        },
        { which, tool },
    )

const hoverAt = async (page: Page, point: { x: number; y: number }) => {
    await page.mouse.move(point.x - 1, point.y)
    await page.mouse.move(point.x, point.y)
}

test('Select: the hover is what a tap selects, cycling, with or without a selection there', async ({
    page,
}) => {
    await showStack(page)
    await select(page, 'none', 'select')
    let checked = 0
    // Each tap's selection is read as the next round sets its own.
    let check: ((selected: string[]) => void) | undefined
    for (const point of await points(page)) {
        for (const which of ['none', 'inStack', 'outside'] as const) {
            check?.(await select(page, which))
            await hoverAt(page, point)
            const hovered = await keys(page, 'hovered')
            await page.mouse.click(point.x, point.y)
            check = (selected) =>
                expect(selected, `${which} at ${point.x},${point.y}`).toEqual(hovered)
            if (hovered.length) checked++
        }
    }
    check?.(await keys(page, 'selected'))
    expect(checked).toBeGreaterThan(30)
})

test('Select with Ctrl: the hover is every object a Ctrl-tap adds or removes', async ({ page }) => {
    await showStack(page)
    await select(page, 'none', 'select')
    for (const point of (await points(page)).filter((_, i) => i % 3 === 0)) {
        await select(page, 'outside')
        await page.keyboard.down('Control')
        await hoverAt(page, point)
        const hovered = await keys(page, 'hovered')
        const before = await keys(page, 'selected')
        await page.mouse.click(point.x, point.y)
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

/** The objects not in `all`, and those of `all` gone; undoes the tap if it changed any. Without `all`, every object. */
const changed = (page: Page, all?: string[]) =>
    page.evaluate((all) => {
        const { store, history } = window.editorTest
        const now = [...store.getAllEntities()]
            .filter((entity) => entity.type !== 'bpm' && !entity.type.startsWith('connector'))
            .map((entity) => `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`)
        const selected = history.state.value.selectedEntities
            .map((entity) => `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`)
            .sort()
        // As multisets: an add can repeat an object's beat and lane.
        const minus = (a: string[], b: string[]) => {
            const rest = [...b]
            return a.filter((name) => {
                const i = rest.indexOf(name)
                if (i >= 0) rest.splice(i, 1)
                return i < 0
            })
        }
        const added = minus(now, all ?? []).sort()
        const removed = all ? minus(all, now) : []
        if (all && (added.length || removed.length)) history.undoState()
        return { added, removed, selected }
    }, all)

test('Eraser and Note tool: the hover is what a tap removes or selects, and the add ghost what it adds', async ({
    page,
}) => {
    await showStack(page)
    const all = (await changed(page)).added
    let added = 0
    for (const point of (await points(page)).filter((_, i) => i % 2 === 0)) {
        for (const which of ['none', 'inStack'] as const) {
            await select(page, which, 'eraser')
            await hoverAt(page, point)
            const hovered = await keys(page, 'hovered')
            await page.mouse.click(point.x, point.y)
            expect(
                (await changed(page, all)).removed,
                `eraser ${which} at ${point.x},${point.y}`,
            ).toEqual(hovered)
        }
        await select(page, 'none', 'note')
        await hoverAt(page, point)
        const shown = await page.evaluate(() => {
            const { view } = window.editorTest
            const key = (entity: (typeof view.entities.hovered)[number]) =>
                `${entity.type}:${entity.beat}:${'left' in entity ? entity.left : ''}`
            return {
                hovered: view.entities.hovered.map(key).sort(),
                ghost: view.entities.creating.map(key).sort(),
            }
        })
        await page.mouse.click(point.x, point.y)
        const result = await changed(page, all)
        if (shown.hovered.length)
            expect(result, `note at ${point.x},${point.y}`).toEqual({
                added: [],
                removed: [],
                selected: shown.hovered,
            })
        else {
            expect(result.added, `note add at ${point.x},${point.y}`).toEqual(shown.ghost)
            added++
        }
    }
    expect(added).toBeGreaterThan(0)
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
    let check: ((selected: string[]) => void) | undefined
    for (const point of grid) {
        for (const which of ['none', 'inStack', 'outside'] as const) {
            check?.(await select(page, which))
            await hoverAt(page, point)
            const hovered = await keys(page, 'hovered')
            await page.mouse.click(point.x, point.y)
            check = (selected) =>
                expect(selected, `${which} at ${point.x},${point.y}`).toEqual(hovered)
        }
    }
    check?.(await keys(page, 'selected'))
})
