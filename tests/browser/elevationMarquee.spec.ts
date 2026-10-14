import { expect, test, type Page } from '@playwright/test'
import type { Entity } from '../../src/state/entities'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

type Viewport = typeof import('../../src/editor/elevation/viewport')
type Scene = typeof import('../../src/editor/elevation/scene')
const viewportPath = '/src/editor/elevation/viewport.ts'
const scenePath = '/src/editor/elevation/scene.ts'

const errors = new WeakMap<Page, string[]>()
const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })
// Notes at beat 6 in lanes 0 to 2, at these elevations, and one at beat 8 at 7.
const elevations = [1, 3, 5]
// The box selection, and the selected and remaining notes' elevations.
const status = (page: Page) =>
    page.evaluate(
        async ({ viewportPath, scenePath }) => {
            const { history, appImport } = window.editorTest
            const viewport = await appImport<Viewport>(viewportPath)
            const scene = await appImport<Scene>(scenePath)
            const elevationsOf = (entities: readonly Entity[]) =>
                entities
                    .flatMap((entity) => (entity.type === 'note' ? [entity.elevation] : []))
                    .sort((a, b) => a - b)
            return {
                selection: viewport.elevationSelection.value,
                selected: elevationsOf(history.state.value.selectedEntities),
                remaining: elevationsOf([...history.state.value.store.slides.note.values()].flat()),
                top: scene.elevationLayout.value.yAt(5),
            }
        },
        { viewportPath, scenePath },
    )
// The whole page pixel nearest a lane and elevation, as the mouse moves to.
const at = (page: Page, lane: number, elevation: number) =>
    page.evaluate(
        async ({ viewportPath, scenePath, lane, elevation }) => {
            const { appImport } = window.editorTest
            const { elevationBounds } = await appImport<Viewport>(viewportPath)
            const { xAt, yAt } = (await appImport<Scene>(scenePath)).elevationLayout.value
            return {
                x: Math.round(elevationBounds.x + xAt(lane)),
                y: Math.round(elevationBounds.y + yAt(elevation)),
            }
        },
        { viewportPath, scenePath, lane, elevation },
    )
// The elevation under a page y.
const elevationAt = (page: Page, y: number) =>
    page.evaluate(
        async ({ viewportPath, y }) => {
            const { elevationViewport, elevationBounds } =
                await window.editorTest.appImport<Viewport>(viewportPath)
            const { center, scale } = elevationViewport
            return center + (elevationBounds.h / 2 - y + elevationBounds.y) / scale
        },
        { viewportPath, y },
    )
// Zooms in so elevation 5 sits above the canvas, and 1 and 3 inside it.
const zoomIn = (page: Page) =>
    page.evaluate(async (viewportPath) => {
        const { elevationViewport } = await window.editorTest.appImport<Viewport>(viewportPath)
        Object.assign(elevationViewport, { center: 1.5, scale: 200 })
    }, viewportPath)
// Wheels the view up until the pointer is over elevation 5.5.
const wheelUp = async (page: Page, y: number) => {
    for (let i = 0; i < 20 && (await elevationAt(page, y)) < 5.5; i++) {
        await page.mouse.wheel(0, -100)
        await settle(page)
    }
    expect(await elevationAt(page, y)).toBeGreaterThanOrEqual(5.5)
}
const selectElevation = (page: Page, elevation: number) =>
    page.evaluate((elevation) => {
        const { history } = window.editorTest
        const notes = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({
            ...history.state.value,
            selectedEntities: notes.filter((note) => note.elevation === elevation),
        })
    }, elevation)

test.beforeEach(async ({ page }) => {
    const pageErrors: string[] = []
    errors.set(page, pageErrors)
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate((elevations) => {
        const { fixtures, show, view, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    ...elevations.map((elevation) => [
                        { ...base, beat: 6, left: 0, size: 2, elevation },
                    ]),
                    [{ ...base, beat: 8, left: 0, size: 2, elevation: 7 }],
                ],
            },
            3,
        )
        view.cursorTime = 3
        settings.elevationEditorSideBySide = 'disallow'
    }, elevations)
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await zoomIn(page)
    await settle(page)
    expect((await status(page)).top).toBeLessThan(0)
})

test.afterEach(async ({ page }) => {
    expect(errors.get(page)).toEqual([])
})

test('a box selection stays on its lanes and elevations as the wheel scrolls', async ({ page }) => {
    const start = await at(page, 4, 0.5)
    const end = await at(page, -2, 3.5)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await settle(page)
    const held = await status(page)
    expect(held.selected).toEqual([1, 3])
    await wheelUp(page, end.y)
    const scrolled = await status(page)
    // The start corner stays put; the pointer's corner moves with the view.
    expect(scrolled.selection!.laneMax).toBe(held.selection!.laneMax)
    expect(scrolled.selection!.elevationMin).toBe(held.selection!.elevationMin)
    expect(scrolled.selection!.laneMin).toBe(held.selection!.laneMin)
    expect(scrolled.selection!.elevationMax).toBeGreaterThanOrEqual(5.5)
    // The row scrolled into it is selected, and the ones it stays on are kept.
    expect(scrolled.selected).toEqual([1, 3, 5])
    await page.mouse.up()
    await settle(page)
    const released = await status(page)
    expect(released.selection).toBeUndefined()
    expect(released.selected).toEqual([1, 3, 5])
})

test('a box selection stays on its elevations as a drag pans the view', async ({ page }) => {
    await page.evaluate(() => (window.editorTest.settings.dragToPanY = true))
    const start = await at(page, 4, 0.5)
    const end = await at(page, -2, 1.5)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await settle(page)
    const held = await status(page)
    expect(held.selected).toEqual([1])
    const box = (await page.locator('.elevation-canvas').boundingBox())!
    // Held in the top edge zone, the view pans up.
    const edge = Math.round(box.y + box.height * 0.1)
    await page.mouse.move(end.x, edge, { steps: 3 })
    await expect.poll(async () => elevationAt(page, edge)).toBeGreaterThan(5.5)
    const panned = await status(page)
    expect(panned.selection!.elevationMin).toBe(held.selection!.elevationMin)
    expect(panned.selected).toEqual([1, 3, 5])
    await page.mouse.up()
    expect((await status(page)).selected).toEqual([1, 3, 5])
})

test('a Ctrl box selection adds to the selection as the wheel scrolls', async ({ page }) => {
    // Elevation 7 is at another beat.
    await selectElevation(page, 7)
    const start = await at(page, 4, 0.5)
    const end = await at(page, -2, 1.5)
    await page.mouse.move(start.x, start.y)
    await page.keyboard.down('Control')
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await settle(page)
    expect((await status(page)).selected).toEqual([1, 7])
    // Ctrl+wheel zooms, so the wheel scrolls without it; the drag keeps its last modifiers.
    await page.keyboard.up('Control')
    await wheelUp(page, end.y)
    expect((await status(page)).selected).toEqual([1, 3, 5, 7])
    await page.keyboard.down('Control')
    await page.mouse.up()
    await page.keyboard.up('Control')
    expect((await status(page)).selected).toEqual([1, 3, 5, 7])
})

test('an Eraser box erases the notes under it after a scroll', async ({ page }) => {
    await page.keyboard.press('g')
    const start = await at(page, 4, 2)
    const end = await at(page, -2, 3.5)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await wheelUp(page, end.y)
    await page.mouse.up()
    await settle(page)
    // From elevation 2 up; held on screen, the box would have left 3 by now.
    expect((await status(page)).remaining).toEqual([1, 7])
})

test('a beat change during a box selection cancels it and restores the selection', async ({
    page,
}) => {
    await selectElevation(page, 5)
    const start = await at(page, 4, 0.5)
    const end = await at(page, -2, 3.5)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await settle(page)
    expect((await status(page)).selected).toEqual([1, 3])
    await page.evaluate(async () => {
        const { elevationBeat } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        elevationBeat.value = 7
    })
    await settle(page)
    const cancelled = await status(page)
    expect(cancelled.selection).toBeUndefined()
    expect(cancelled.selected).toEqual([5])
    await page.mouse.move(start.x, start.y, { steps: 3 })
    await page.mouse.up()
    expect((await status(page)).selected).toEqual([5])
})

test('a box selection follows a 1:1 lock zooming with the lanes', async ({ page }) => {
    await page.evaluate(() => (window.editorTest.settings.elevationSquareGrid = true))
    await settle(page)
    const start = await at(page, 4, 0.5)
    const end = await at(page, -2, 2)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await settle(page)
    const held = await status(page)
    expect(held.selected).toEqual([1])
    // Zooming lanes out zooms elevations with them, under the resting pointer.
    await page.evaluate(() => (window.editorTest.settings.width = 64))
    await settle(page)
    expect(await elevationAt(page, end.y)).toBeGreaterThan(3)
    const zoomed = await status(page)
    expect(zoomed.selection!.laneMax).toBe(held.selection!.laneMax)
    expect(zoomed.selection!.elevationMin).toBe(held.selection!.elevationMin)
    expect(zoomed.selected).toEqual([1, 3])
    await page.mouse.up()
    expect((await status(page)).selected).toEqual([1, 3])
})

test('a box selection takes a note its edge cuts, as far as the note is drawn', async ({
    page,
}) => {
    const layout = () =>
        page.evaluate(async (scenePath) => {
            const { laneScale } = (await window.editorTest.appImport<Scene>(scenePath))
                .elevationLayout.value
            return { laneScale }
        }, scenePath)
    // The chart's closest lane zoom: notes are drawn 0.6 lane tall.
    await page.evaluate(() => (window.editorTest.settings.width = 16))
    await settle(page)
    const { laneScale } = await layout()
    expect(laneScale * 0.3).toBeGreaterThan(24)
    const note = await at(page, 1, 3)
    const box = async (offset: number) => {
        const start = await at(page, 4, 3.6)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(note.x - 200, note.y - offset, { steps: 5 })
        await settle(page)
        const { selected } = await status(page)
        await page.mouse.up()
        return selected
    }
    // An edge 6px into the note's top half takes it; one 6px above it doesn't.
    expect(await box(Math.floor(laneScale * 0.3) - 6)).toEqual([3])
    expect(await box(Math.ceil(laneScale * 0.3) + 6)).toEqual([])
})

test('a box selection is drawn as the chart draws its own', async ({ page }) => {
    await page.evaluate(() => {
        const calls: unknown[] = []
        ;(window as unknown as { boxCalls: unknown[] }).boxCalls = calls
        for (const name of ['fillRect', 'strokeRect'] as const) {
            const method = CanvasRenderingContext2D.prototype[name]
            CanvasRenderingContext2D.prototype[name] = function (x, y, w, h) {
                if (this.canvas.classList.contains('elevation-canvas') && this.getLineDash().length)
                    calls.push({
                        name,
                        w,
                        h,
                        lineWidth: this.lineWidth,
                        dash: this.getLineDash(),
                        alpha: this.globalAlpha,
                        style: name === 'fillRect' ? this.fillStyle : this.strokeStyle,
                    })
                return method.call(this, x, y, w, h)
            }
        }
    })
    const start = await at(page, 4, 0.5)
    const end = await at(page, -2, 2)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 5 })
    await settle(page)
    const calls = await page.evaluate(() => {
        const { boxCalls } = window as unknown as { boxCalls: { w: number }[] }
        return boxCalls.slice(-3)
    })
    const w = end.x - start.x
    const h = end.y - start.y
    // The selected note's outline, then the box.
    expect(calls).toEqual([
        expect.objectContaining({ name: 'strokeRect', lineWidth: 2, dash: [6, 4] }),
        {
            name: 'fillRect',
            w: expect.closeTo(-w, 6),
            h: expect.closeTo(-h, 6),
            lineWidth: 2,
            dash: [6, 4],
            alpha: 0.25,
            style: '#ffffff',
        },
        {
            name: 'strokeRect',
            w: expect.closeTo(-w, 6),
            h: expect.closeTo(-h, 6),
            lineWidth: 2,
            dash: [6, 4],
            alpha: 0.5,
            style: '#ffffff',
        },
    ])
    await page.mouse.up()
})

test('a note outline is the chart hitbox with a 0.1 lane margin', async ({ page }) => {
    await page.evaluate(() => {
        const calls: number[][] = []
        ;(window as unknown as { outlines: number[][] }).outlines = calls
        const method = CanvasRenderingContext2D.prototype.strokeRect
        CanvasRenderingContext2D.prototype.strokeRect = function (x, y, w, h) {
            if (this.canvas.classList.contains('elevation-canvas') && this.getLineDash().length)
                calls.push([x, y, w, h, this.lineWidth])
            return method.call(this, x, y, w, h)
        }
    })
    await selectElevation(page, 3)
    await settle(page)
    const { outline, lane } = await page.evaluate(async (scenePath) => {
        const { outlines } = window as unknown as { outlines: number[][] }
        const layout = (await window.editorTest.appImport<Scene>(scenePath)).elevationLayout.value
        return {
            outline: outlines.at(-1)!,
            lane: { left: layout.xAt(0), top: layout.yAt(3), scale: layout.laneScale },
        }
    }, scenePath)
    // Lanes 0 to 2 and 0.3 lane above and below, each 0.1 lane further out.
    expect(outline[0]).toBeCloseTo(lane.left - 0.1 * lane.scale, 6)
    expect(outline[1]).toBeCloseTo(lane.top - 0.4 * lane.scale, 6)
    expect(outline[2]).toBeCloseTo(2.2 * lane.scale, 6)
    expect(outline[3]).toBeCloseTo(0.8 * lane.scale, 6)
    expect(outline[4]).toBe(2)
})

// Records the Elevation Editor's grid strokes and number label fonts, per frame.
const recordGrid = (page: Page) =>
    page.evaluate(() => {
        const lines: { style: string; width: number; vertical: boolean; x: number; y: number }[] =
            []
        const fonts: string[] = []
        Object.assign(window, { gridLines: lines, labelFonts: fonts })
        const prototype = CanvasRenderingContext2D.prototype
        const { moveTo, lineTo, stroke, fillText, clearRect } = prototype
        let start = [0, 0]
        let vertical = false
        prototype.clearRect = function (...args) {
            if (this.canvas.classList.contains('elevation-canvas')) lines.length = fonts.length = 0
            return clearRect.apply(this, args)
        }
        prototype.moveTo = function (x, y) {
            start = [x, y]
            return moveTo.call(this, x, y)
        }
        prototype.lineTo = function (x, y) {
            vertical = x === start[0] && y !== start[1]
            return lineTo.call(this, x, y)
        }
        // The editor strokes its own paths.
        prototype.stroke = function (this: CanvasRenderingContext2D) {
            if (this.canvas.classList.contains('elevation-canvas') && !this.getLineDash().length)
                lines.push({
                    style: String(this.strokeStyle),
                    width: this.lineWidth,
                    vertical,
                    x: start[0]!,
                    y: start[1]!,
                })
            return (stroke as () => void).call(this)
        }
        prototype.fillText = function (text, x, y, maxWidth) {
            if (this.canvas.classList.contains('elevation-canvas') && /^-?\d+$/.test(text))
                fonts.push(this.font)
            return fillText.call(this, text, x, y, maxWidth)
        }
    })
// The drawn grid: each lane and elevation line's style by its lane or elevation, widths and fonts.
const drawnGrid = (page: Page) =>
    page.evaluate(async (scenePath) => {
        const { gridLines, labelFonts } = window as unknown as {
            gridLines: { style: string; width: number; vertical: boolean; x: number; y: number }[]
            labelFonts: string[]
        }
        const { elevationLayout } = await window.editorTest.appImport<Scene>(scenePath)
        const { height, elevationCenter, elevationScale, laneLeft, laneScale } =
            elevationLayout.value
        const probe = document.createElement('canvas').getContext('2d')!
        probe.font = `12px ${getComputedStyle(document.querySelector('.elevation-editor')!).fontFamily}`
        const style = (color: string) => ((probe.strokeStyle = color), String(probe.strokeStyle))
        const lanes: Record<string, string> = {}
        const elevations: Record<string, string> = {}
        for (const line of gridLines) {
            if (line.vertical) {
                const lane = laneLeft + line.x / laneScale
                lanes[`${Math.round(lane * 1000) / 1000}`] = line.style
                continue
            }
            const elevation = elevationCenter + (height / 2 - line.y) / elevationScale
            elevations[`${Math.round(elevation * 1000) / 1000}`] = line.style
        }
        return {
            lanes,
            elevations,
            widths: [...new Set(gridLines.map((line) => line.width))],
            fonts: [...new Set(labelFonts)],
            font: probe.font,
            // Elevation 0 and lane 6, division multiples and even lanes, other whole
            // elevations and odd lanes, and quarters and half lanes.
            styles: ['#ffffff80', '#ffffff40', '#ffffff0d', '#ffffff06'].map(style),
        }
    }, scenePath)
// The styles of these elevations' lines.
const stylesAt = (grid: Awaited<ReturnType<typeof drawnGrid>>, elevations: number[]) =>
    elevations.map((elevation) => grid.elevations[`${elevation}`])
// The styles of these lanes' lines.
const laneStylesAt = (grid: Awaited<ReturnType<typeof drawnGrid>>, lanes: number[]) =>
    lanes.map((lane) => grid.lanes[`${lane}`])
// The grid's view: quarters, half lanes, and elevations -5 to 6.
const gridView = (page: Page) =>
    page.evaluate(async (viewportPath) => {
        const { view, settings, appImport } = window.editorTest
        settings.elevationSnap = 4 as never
        view.laneDivision = 2
        const { elevationViewport } = await appImport<Viewport>(viewportPath)
        Object.assign(elevationViewport, { center: 0.5, scale: 80 })
    }, viewportPath)
// Shows the notes again with these stage pivot events, in the Elevation Editor at beat 6.
const showPivots = async (
    page: Page,
    pivots: {
        stage: number
        beat: number
        size: number
        parity?: 'odd' | 'even'
        lane?: number
    }[],
    dynamic = true,
) => {
    await page.evaluate(
        ({ pivots, dynamic, elevations }) => {
            const { fixtures, show, view } = window.editorTest
            const stages = [...fixtures.interaction.stages.keys()]
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    slides: elevations.map((elevation) => [
                        { ...base, beat: 6, left: 0, size: 2, elevation },
                    ]),
                    isDynamicStages: dynamic,
                    stagePivotEvents: pivots.map(({ stage, beat, size, parity, lane }) => ({
                        stageId: stages[stage]!,
                        beat,
                        pivotLane: lane ?? 0,
                        divisionSize: size,
                        divisionParity: parity ?? 'even',
                        yOffset: 0,
                        yOffsetBeat: 0,
                        eventEase: 'linear' as const,
                    })),
                },
                3,
            )
            view.cursorTime = 3
        },
        { pivots, dynamic, elevations },
    )
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await gridView(page)
    await settle(page)
}
const focusStage = (page: Page, stage: number | undefined) =>
    page.evaluate((stage) => {
        const { fixtures, view } = window.editorTest
        view.stageId =
            stage === undefined ? undefined : [...fixtures.interaction.stages.keys()][stage]
    }, stage)
const useLayout = (page: Page, layout: 'basic' | 'composed') =>
    page.evaluate((layout) => {
        window.editorTest.view.layout = layout
    }, layout)

test.describe('grid lines and axis labels', () => {
    test.beforeEach(async ({ page }) => {
        await recordGrid(page)
        await gridView(page)
        await settle(page)
    })

    test('are drawn in the chart styles and font, as the lanes', async ({ page }) => {
        const grid = await drawnGrid(page)
        const [zero, multiple, whole, sub] = grid.styles
        expect(grid.widths).toEqual([2])
        // Without dynamic stages, every second lane and elevation is a division multiple.
        expect(laneStylesAt(grid, [6, -6, 0, 2, -4, 1, -3, 0.5, -1.5])).toEqual([
            zero,
            zero,
            multiple,
            multiple,
            multiple,
            whole,
            whole,
            sub,
            sub,
        ])
        expect(new Set(Object.values(grid.lanes)).size).toBe(4)
        expect(stylesAt(grid, [0, 2, -2, 4, 1, -1, 3, 0.25, 0.5, -0.75])).toEqual([
            zero,
            multiple,
            multiple,
            multiple,
            whole,
            whole,
            whole,
            sub,
            sub,
            sub,
        ])
        expect(new Set(Object.values(grid.elevations)).size).toBe(4)
        // The editor's font, not the canvas default.
        expect(grid.font).not.toBe('12px sans-serif')
        expect(grid.fonts).toEqual([grid.font])
    })

    test("follow the selected stage's division, its lanes from where its notes snap", async ({
        page,
    }) => {
        const elevations = [0, 3, -3, 1, 2, -2, 4, 0.25]
        // The pivot at lane 0.25; odd dividers start half a division on, and the lanes half a lane.
        const lanes = {
            even: [6, -6, 0.25, 3.25, -2.75, 1.25, 2.25, -0.75, 0.75, 1.75],
            odd: [6, -6, 1.75, 4.75, -1.25, 0.75, 2.75, 3.75, 1.25, 2.25],
        }
        for (const parity of ['even', 'odd'] as const) {
            await showPivots(page, [{ stage: 0, beat: 0, size: 3, parity, lane: 0.25 }])
            await useLayout(page, 'composed')
            await focusStage(page, 0)
            await settle(page)
            const grid = await drawnGrid(page)
            const [zero, multiple, whole, sub] = grid.styles
            // Elevations ignore the parity.
            expect(stylesAt(grid, elevations)).toEqual([
                zero,
                multiple,
                multiple,
                whole,
                whole,
                whole,
                whole,
                sub,
            ])
            expect(laneStylesAt(grid, lanes[parity])).toEqual([
                zero,
                zero,
                multiple,
                multiple,
                multiple,
                whole,
                whole,
                whole,
                sub,
                sub,
            ])
            expect(laneStylesAt(grid, [0, 1, 2])).toEqual([undefined, undefined, undefined])
            // New notes' edges land on the lines, and near a divider on it.
            const edges = await page.evaluate(async () => {
                const { previewElevationNoteRow } = await window.editorTest.appImport<
                    typeof import('../../src/editor/elevation/actions')
                >('/src/editor/elevation/actions.ts')
                return [1.8, -2.6, 4.1, 3.3].map((lane) => {
                    const row = previewElevationNoteRow(lane, 1, 6, false)
                    return [row.lane - row.size / 2, row.lane + row.size / 2].map(
                        (edge) => Math.round(edge * 1000) / 1000,
                    )
                })
            })
            for (const edge of edges.flat()) expect(grid.lanes[`${edge}`]).toBeDefined()
            expect(edges[parity === 'odd' ? 0 : 3]![0]).toBe(parity === 'odd' ? 1.75 : 3.25)
            // The Basic layout's lanes, where notes snap to whole lanes, stay every second one.
            await useLayout(page, 'basic')
            await settle(page)
            const basic = await drawnGrid(page)
            expect(stylesAt(basic, elevations)).toEqual(stylesAt(grid, elevations))
            expect(laneStylesAt(basic, [6, 0, 2, 1, 3, 0.5])).toEqual([
                zero,
                multiple,
                multiple,
                whole,
                whole,
                sub,
            ])
        }
    })

    test('use the selected stage, and every second line for All Stages and without dynamic stages', async ({
        page,
    }) => {
        // Pivots at lane 0.
        const pivots = [
            { stage: 0, beat: 0, size: 3, parity: 'odd' as const },
            { stage: 1, beat: 0, size: 4 },
        ]
        const elevations = [2, 3, 4]
        const lanes = [0, 1, 1.5, 2, 3, 4]
        const expectGrid = async (expected: {
            elevations: (string | undefined)[]
            lanes: (string | undefined)[]
        }) => {
            await settle(page)
            const grid = await drawnGrid(page)
            expect(stylesAt(grid, elevations)).toEqual(expected.elevations)
            expect(laneStylesAt(grid, lanes)).toEqual(expected.lanes)
        }
        await showPivots(page, pivots)
        await useLayout(page, 'composed')
        await focusStage(page, undefined)
        await settle(page)
        const [, multiple, whole, sub] = (await drawnGrid(page)).styles
        const everySecond = {
            elevations: [multiple, whole, multiple],
            lanes: [multiple, whole, sub, multiple, whole, multiple],
        }
        await expectGrid(everySecond)
        await focusStage(page, 1)
        await expectGrid({
            elevations: [whole, whole, multiple],
            lanes: [multiple, whole, sub, whole, whole, multiple],
        })
        // Odd: from lane 1.5, its lanes on the halves.
        await focusStage(page, 0)
        await expectGrid({
            elevations: [whole, multiple, whole],
            lanes: [sub, sub, multiple, sub, sub, sub],
        })
        await focusStage(page, undefined)
        await expectGrid(everySecond)
        // The Basic layout keeps every second lane.
        await focusStage(page, 0)
        await useLayout(page, 'basic')
        await expectGrid({ elevations: [whole, multiple, whole], lanes: everySecond.lanes })
        // Without dynamic stages, the same pivots don't apply, and a stage can't be selected.
        await showPivots(page, pivots, false)
        await focusStage(page, 0)
        await expectGrid(everySecond)
        expect(await page.evaluate(() => window.editorTest.view.stageId)).toBeUndefined()
    })

    test("take a change's dominant size, and 2 for a stage without a pivot", async ({ page }) => {
        // At beat 6, the change to 3 is three quarters done.
        await showPivots(page, [
            { stage: 0, beat: 0, size: 4 },
            { stage: 0, beat: 8, size: 3 },
        ])
        await useLayout(page, 'composed')
        await focusStage(page, 0)
        await settle(page)
        let grid = await drawnGrid(page)
        const [, multiple, whole] = grid.styles
        expect(stylesAt(grid, [2, 3, 4])).toEqual([whole, multiple, whole])
        expect(laneStylesAt(grid, [2, 3, 4])).toEqual([whole, multiple, whole])
        // And here a quarter.
        await showPivots(page, [
            { stage: 0, beat: 4, size: 4 },
            { stage: 0, beat: 12, size: 3 },
        ])
        await useLayout(page, 'composed')
        await focusStage(page, 0)
        await settle(page)
        grid = await drawnGrid(page)
        expect(stylesAt(grid, [2, 3, 4])).toEqual([whole, whole, multiple])
        expect(laneStylesAt(grid, [2, 3, 4])).toEqual([whole, whole, multiple])
        await showPivots(page, [{ stage: 1, beat: 0, size: 3 }])
        await useLayout(page, 'composed')
        await focusStage(page, 0)
        await settle(page)
        grid = await drawnGrid(page)
        expect(stylesAt(grid, [2, 3, 4])).toEqual([multiple, whole, multiple])
        expect(laneStylesAt(grid, [2, 3, 4])).toEqual([multiple, whole, multiple])
    })
})

test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('a touch box selection stays on its elevations as a drag pans the view', async ({
        page,
    }) => {
        await page.evaluate(() => {
            const { settings } = window.editorTest
            settings.dragToPanY = true
            // The drag starts near the right edge, where a quick scroll would take it.
            settings.touchQuickScrollWidth = 0
        })
        const touch = (type: string, x: number, y: number) =>
            page.evaluate(
                ({ type, x, y }) => {
                    const target = document.querySelector('.elevation-editor .editor')!
                    target.dispatchEvent(
                        new TouchEvent(type, {
                            changedTouches: [
                                new Touch({ identifier: 1, target, clientX: x, clientY: y }),
                            ],
                            bubbles: true,
                            cancelable: true,
                        }),
                    )
                },
                { type, x, y },
            )
        const start = await at(page, 5, 0.5)
        const end = await at(page, -1, 1.5)
        await touch('touchstart', start.x, start.y)
        for (let i = 1; i <= 5; i++)
            await touch(
                'touchmove',
                start.x + ((end.x - start.x) * i) / 5,
                start.y + ((end.y - start.y) * i) / 5,
            )
        await settle(page)
        const held = await status(page)
        expect(held.selected).toEqual([1])
        const box = (await page.locator('.elevation-canvas').boundingBox())!
        const edge = box.y + box.height * 0.1
        await touch('touchmove', end.x, edge)
        await expect.poll(async () => elevationAt(page, edge)).toBeGreaterThan(5.5)
        const panned = await status(page)
        expect(panned.selection!.elevationMin).toBe(held.selection!.elevationMin)
        expect(panned.selected).toEqual([1, 3, 5])
        await touch('touchend', end.x, edge)
        await settle(page)
        expect((await status(page)).selected).toEqual([1, 3, 5])
    })
})
