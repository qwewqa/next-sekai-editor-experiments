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

test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('a touch box selection stays on its elevations as a drag pans the view', async ({
        page,
    }) => {
        await page.evaluate(() => (window.editorTest.settings.dragToPanY = true))
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
