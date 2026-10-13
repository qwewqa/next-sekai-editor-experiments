import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, touchInput } from './editorFixture'

type Scene = typeof import('../../src/editor/elevation/scene')
type ToolState = typeof import('../../src/editor/tools/state')
const scenePath = '/src/editor/elevation/scene.ts'
const toolStatePath = '/src/editor/tools/state.ts'
const errors = new WeakMap<Page, string[]>()
const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })
// The page point of a lane and elevation in the Elevation Editor.
const at = async (page: Page, lane: number, elevation: number) => {
    const local = await page.evaluate(
        async ({ scenePath, lane, elevation }) => {
            const { xAt, yAt } = (await window.editorTest.appImport<Scene>(scenePath))
                .elevationLayout.value
            return { x: xAt(lane), y: yAt(elevation) }
        },
        { scenePath, lane, elevation },
    )
    const box = (await page.locator('.elevation-canvas').boundingBox())!
    return { x: box.x + local.x, y: box.y + local.y }
}
const toolName = (page: Page) =>
    page.evaluate(
        async (path) => (await window.editorTest.appImport<ToolState>(path)).toolName.value,
        toolStatePath,
    )
const open = async (page: Page) => {
    await page.keyboard.press('t')
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    await settle(page)
}

test.beforeEach(async ({ page }) => {
    const pageErrors: string[] = []
    errors.set(page, pageErrors)
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        const { fixtures, show, view, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        // Two notes at beat 6, and one at beat 8.
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 6, left: -4, size: 2, elevation: 1 }],
                    [{ ...base, beat: 6, left: 2, size: 2, elevation: 3 }],
                    [{ ...base, beat: 8, left: 0, size: 2, elevation: 2 }],
                ],
            },
            3,
        )
        view.cursorTime = 3
        settings.elevationEditorSideBySide = 'disallow'
    })
})

test.afterEach(async ({ page }) => {
    expect(errors.get(page)).toEqual([])
})

test('the snap field is titled by what it sets', async ({ page }) => {
    await open(page)
    await expect(page.locator('.elevation-snap select')).toHaveAttribute(
        'title',
        'Elevation Snapping',
    )
})

test('the empty beat note sits under a tall header, and under a tool dialog notice', async ({
    page,
}) => {
    // Narrow, the header wraps its controls onto rows.
    await page.setViewportSize({ width: 280, height: 700 })
    await page.evaluate(() => (window.editorTest.view.cursorTime = 0.5))
    await page.evaluate(() => {
        const texts: { text: string; y: number }[] = []
        ;(window as unknown as { emptyTexts: typeof texts }).emptyTexts = texts
        const fillText = CanvasRenderingContext2D.prototype.fillText
        CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
            if (
                this.canvas instanceof HTMLCanvasElement &&
                this.canvas.matches('.elevation-canvas')
            )
                texts.push({ text, y })
            return fillText.call(this, text, x, y, ...rest)
        }
    })
    await open(page)
    const lastEmptyY = () =>
        page.evaluate(
            () =>
                (window as unknown as { emptyTexts: { text: string; y: number }[] }).emptyTexts
                    .filter(({ text }) => text === 'No notes at this beat')
                    .at(-1)?.y,
        )
    const header = await page
        .locator('.elevation-header')
        .evaluate((element) => element.clientHeight)
    expect(header).toBeGreaterThan(90)
    await expect.poll(lastEmptyY).toBe(header + 24)

    // A tool dialog moves the notice to the top, so the note goes under it.
    await page.keyboard.press('b')
    // Narrow, Brush shows the Properties panel; its dialog opens as without one.
    await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { showToolModal } = await appImport<typeof import('../../src/editor/toolModals')>(
            '/src/editor/toolModals.ts',
        )
        const modal = await appImport<{ default: import('vue').Component }>(
            '/src/editor/commands/brush/BrushPropertiesModal.vue',
        )
        void showToolModal(modal.default, {} as never)
    })
    await expect(page.locator('[data-tool-dialog]')).toBeVisible()
    await expect(page.locator('.notification')).toHaveText('Switched to Brush tool')
    const pill = (await page.locator('.notification').boundingBox())!
    const canvas = (await page.locator('.elevation-canvas').boundingBox())!
    await expect.poll(lastEmptyY).toBe(header + 80)
    expect(header + 80 - 16).toBeGreaterThanOrEqual(pill.y + pill.height - canvas.y)
})

test("the Elevation Editor's own context menu doesn't offer to edit elevations", async ({
    page,
}) => {
    await page.evaluate(() => (window.editorTest.settings.mouseSecondaryTool = 'selectContextMenu'))
    await open(page)
    const note = await at(page, -3, 1)
    await page.mouse.click(note.x, note.y, { button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Edit Elevations', exact: true })).toHaveCount(
        0,
    )
    await page.keyboard.press('Escape')
    // Empty space neither.
    const empty = await at(page, 6, 6)
    await page.mouse.click(empty.x, empty.y, { button: 'right' })
    await page.mouse.click(empty.x, empty.y, { button: 'right' })
    await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Edit Elevations', exact: true })).toHaveCount(
        0,
    )
})

test('Edit Elevations from the chart beside an open Elevation Editor changes its beat and keeps the tool', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.evaluate(() => {
        window.editorTest.settings.mouseSecondaryTool = 'selectContextMenu'
        window.editorTest.settings.elevationEditorSideBySide = 'allow'
    })
    await open(page)
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    const beat = page.getByRole('spinbutton', { name: 'Beat', exact: true })
    await expect(beat).toHaveValue('7')
    await page.keyboard.press('a')
    expect(await toolName(page)).toBe('note')
    const note = await page.evaluate(() => window.editorTest.point(1, 8))
    await page.mouse.click(note.x, note.y, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit Elevations', exact: true }).click()
    await expect(beat).toHaveValue('9')
    expect(await toolName(page)).toBe('note')
})

for (const sideBySide of [false, true])
    test(`the Elevation Editor opens on Select, which shows pressed and which it and Deselect keep (${sideBySide ? 'side by side' : 'full screen'})`, async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1920, height: 1080 })
        await page.evaluate((sideBySide) => {
            window.editorTest.settings.elevationEditorSideBySide = sideBySide ? 'allow' : 'disallow'
        }, sideBySide)
        await page.keyboard.press('a')
        await open(page)
        expect(await toolName(page)).toBe('select')
        const toolbars = page.locator('[data-editor-toolbar]')
        await expect(toolbars).toHaveCount(sideBySide ? 2 : 1)
        const selects = toolbars
            .locator(':scope > div > div > button')
            .and(page.getByTitle('Select', { exact: true }))
        await expect(selects).toHaveCount(sideBySide ? 2 : 1)
        for (const select of await selects.all())
            await expect(select).toHaveAttribute('aria-pressed', 'true')

        // With nothing selected, Deselect neither switches nor says so.
        const noticeId = () =>
            page.evaluate(
                async () =>
                    (
                        await window.editorTest.appImport<
                            typeof import('../../src/editor/notification')
                        >('/src/editor/notification.ts')
                    ).notification.value.id,
            )
        const before = await noticeId()
        await page.evaluate(async () => {
            const { commands } = await window.editorTest.appImport<
                typeof import('../../src/editor/commands')
            >('/src/editor/commands/index.ts')
            await commands.deselect.execute()
        })
        expect(await noticeId()).toBe(before)
        expect(await toolName(page)).toBe('select')

        await page.locator('.elevation-editor').locator(selects).click()
        await expect(page.locator('.notification')).toHaveText('Switched to Select tool')
        expect(await toolName(page)).toBe('select')
        for (const select of await selects.all())
            await expect(select).toHaveAttribute('aria-pressed', 'true')
    })

test('a tool picked in the Elevation Editor stays once it closes', async ({ page }) => {
    await page.keyboard.press('a')
    await open(page)
    expect(await toolName(page)).toBe('select')
    await page.keyboard.press('b')
    expect(await toolName(page)).toBe('brush')
    await page.getByRole('button', { name: 'Close Elevation Editor', exact: true }).click()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    expect(await toolName(page)).toBe('brush')
    const brush = page
        .locator('[data-editor-toolbar] > div > div > button')
        .and(page.getByTitle('Brush', { exact: true }))
    await expect(brush).toHaveAttribute('aria-pressed', 'true')
})

type Clip = { text: string; reads: number; copies: string[] }
const clip = (page: Page) => page.evaluate(() => (window as never as { clip: Clip }).clip)
// A stubbed system clipboard; copies go to it, and a read takes a turn.
const stubClipboard = (page: Page) =>
    page.evaluate(() => {
        const clip: Clip = { text: '', reads: 0, copies: [] }
        Object.assign(window, { clip })
        Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async (value: string) => {
                clip.text = value
                clip.copies.push(value)
            },
        })
        Object.defineProperty(navigator.clipboard, 'readText', {
            configurable: true,
            value: async () => {
                clip.reads++
                const { text } = clip
                await new Promise((resolve) => setTimeout(resolve))
                return text
            },
        })
    })
// Copies the entities of a type through the Copy shortcut.
const copy = async (page: Page, type: 'note' | 'bpm') => {
    await page.evaluate((type) => {
        const { history, store } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...store.getAllEntities()].filter(
                (entity) => entity.type === type && (type !== 'note' || entity.beat === 8),
            ),
        })
    }, type)
    const copies = (await clip(page)).copies.length
    await page.keyboard.press('c')
    await expect.poll(async () => (await clip(page)).copies.length).toBe(copies + 1)
}
const noteCount = (page: Page) => page.evaluate(() => window.editorTest.snapshot().notes.length)
const canvasCursor = (page: Page) =>
    page
        .locator('.elevation-editor .editor')
        .evaluate((element) => getComputedStyle(element).cursor)

for (const held of ['nothing', 'only a BPM'] as const)
    test(`Paste with ${held} on the clipboard shows the default cursor, and a drag pastes nothing`, async ({
        page,
    }) => {
        await stubClipboard(page)
        if (held === 'only a BPM') await copy(page, 'bpm')
        await open(page)
        await page.keyboard.press('v')
        const empty = await at(page, 0, 6)
        await page.mouse.move(empty.x, empty.y)
        await page.mouse.move(empty.x + 5, empty.y)
        await expect.poll(async () => (await clip(page)).reads).toBeGreaterThan(0)
        await settle(page)
        expect(await canvasCursor(page)).toBe('default')
        const bpms = await page.evaluate(() => window.editorTest.history.state.value.bpms.length)
        await page.mouse.down()
        await page.mouse.move(empty.x + 60, empty.y + 30, { steps: 5 })
        expect((await page.evaluate(() => window.editorTest.snapshot())).creating).toEqual([])
        // No drag starts.
        expect(
            await page.evaluate(
                async () =>
                    (
                        await window.editorTest.appImport<
                            typeof import('../../src/editor/controls/gestures/recognizers/drag')
                        >('/src/editor/controls/gestures/recognizers/drag.ts')
                    ).isDragging.value,
            ),
        ).toBe(0)
        await page.mouse.up()
        await settle(page)
        expect(await noteCount(page)).toBe(3)
        expect(await page.evaluate(() => window.editorTest.history.state.value.bpms.length)).toBe(
            bpms,
        )
    })

test('Paste with notes on the clipboard shows the copy cursor, and a hover reads the clipboard', async ({
    page,
}) => {
    await stubClipboard(page)
    await copy(page, 'bpm')
    await copy(page, 'note')
    await open(page)
    await page.keyboard.press('v')
    const empty = await at(page, 0, 6)
    await page.mouse.move(empty.x, empty.y)
    await page.mouse.move(empty.x + 5, empty.y)
    await expect.poll(() => canvasCursor(page)).toBe('copy')
    // Another app copies the BPM; the next hover reads it.
    await page.evaluate(() => {
        const { clip } = window as never as { clip: Clip }
        clip.text = clip.copies[0]!
    })
    await page.mouse.move(empty.x + 10, empty.y)
    await expect.poll(() => canvasCursor(page)).toBe('default')
    // A drag's moves don't read it.
    await page.evaluate(() => {
        const { clip } = window as never as { clip: Clip }
        clip.text = clip.copies[1]!
    })
    await page.mouse.move(empty.x + 15, empty.y)
    await expect.poll(() => canvasCursor(page)).toBe('copy')
    const reads = (await clip(page)).reads
    await page.mouse.down()
    await page.mouse.move(empty.x + 80, empty.y + 40, { steps: 5 })
    await settle(page)
    expect((await clip(page)).reads).toBe(reads)
    await page.mouse.up()
    await expect.poll(() => noteCount(page)).toBe(4)
})

test.describe('with touch', () => {
    test.use({ hasTouch: true })

    test('a Paste touch drag reads the clipboard as it presses and pastes notes copied elsewhere', async ({
        page,
    }) => {
        const touch = await touchInput(page)
        await stubClipboard(page)
        // The note is copied in another app: only the BPM's copy is held here.
        await copy(page, 'note')
        await copy(page, 'bpm')
        await open(page)
        await page.keyboard.press('v')
        await page.evaluate(() => {
            const { clip } = window as never as { clip: Clip }
            clip.text = clip.copies[0]!
        })
        const reads = (await clip(page)).reads
        const empty = await at(page, 0, 6)
        await touch('touchStart', [[empty.x, empty.y]])
        await settle(page)
        for (let step = 1; step <= 4; step++)
            await touch('touchMove', [[empty.x + step * 10, empty.y - step * 10]])
        await touch('touchEnd', [])
        await expect.poll(() => noteCount(page)).toBe(4)
        expect((await clip(page)).reads).toBeGreaterThan(reads)
    })
})

const elevations = (page: Page) =>
    page.evaluate(() => {
        const { snapshot, history } = window.editorTest
        const notes = [...history.state.value.store.slides.note.values()].flat()
        const selected = history.state.value.selectedEntities
        return {
            all: notes
                .filter((note) => note.beat === 6)
                .map((note) => note.elevation)
                .sort((a, b) => a - b),
            selected: notes
                .filter((note) => selected.includes(note))
                .map((note) => note.elevation)
                .sort((a, b) => a - b),
            count: snapshot().notes.length,
        }
    })

for (const tool of ['Note', 'Slide'] as const)
    test(`a ${tool} tool drag edits only the pressed note, selecting it`, async ({ page }) => {
        await open(page)
        await page.evaluate(() => {
            const { history } = window.editorTest
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...history.state.value.store.slides.note.values()]
                    .flat()
                    .filter((note) => note.beat === 6),
            })
        })
        expect((await elevations(page)).selected).toEqual([1, 3])
        await page.keyboard.press(tool === 'Note' ? 'a' : 's')
        const start = await at(page, 3, 3)
        const end = await at(page, 3, 5)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(end.x, end.y, { steps: 5 })
        await page.mouse.up()
        await settle(page)
        expect(await elevations(page)).toEqual({ all: [1, 5], selected: [5], count: 3 })
        // Undo returns it, still alone selected, as on the chart.
        await page.keyboard.press('Control+z')
        await settle(page)
        expect(await elevations(page)).toEqual({ all: [1, 3], selected: [3], count: 3 })
    })

test('names and anchor outlines show while the view is in use or the note is highlighted, as on the chart', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, view } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                slides: [
                    [{ ...base, beat: 6, left: 2, size: 2, elevation: 3, stageId: 2 as never }],
                    [{ ...base, beat: 6, left: -4, size: 2, elevation: 1, noteType: 'anchor' }],
                ],
            },
            3,
        )
        view.cursorTime = 3
    })
    await open(page)
    // Names drawn on the canvas in a redraw.
    const draws = () =>
        page.evaluate(async () => {
            const { history } = window.editorTest
            const names: string[] = []
            let count = 0
            const prototype = CanvasRenderingContext2D.prototype
            const { drawImage } = prototype
            prototype.drawImage = function (...args: unknown[]) {
                if (
                    this.canvas instanceof HTMLCanvasElement &&
                    this.canvas.matches('.elevation-canvas')
                ) {
                    count++
                    const label = window.editorLabels.get(args[0] as HTMLCanvasElement)?.text
                    if (label) names.push(label)
                }
                return (drawImage as (...args: unknown[]) => void).apply(this, args)
            }
            // An equal selection redraws it.
            history.replaceState({
                ...history.state.value,
                selectedEntities: [...history.state.value.selectedEntities],
            })
            await window.editorTest.nextTick()
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            )
            prototype.drawImage = drawImage
            return { names: [...new Set(names)], count }
        })
    // The brightest pixel over the anchor, which only its outline reaches.
    const anchorAlpha = () =>
        page.evaluate(async (scenePath) => {
            const { elevationLayout } = await window.editorTest.appImport<Scene>(scenePath)
            const { rows, laneScale } = elevationLayout.value
            const row = rows.find((row) => row.note.noteType === 'anchor')!
            const canvas = document.querySelector<HTMLCanvasElement>('.elevation-canvas')!
            const ratio = canvas.width / canvas.clientWidth
            const half = laneScale * 0.25
            const data = canvas
                .getContext('2d')!
                .getImageData(
                    Math.round((row.x - row.w / 2 + 4) * ratio),
                    Math.round((row.y - half) * ratio),
                    Math.round((row.w - 8) * ratio),
                    Math.round(2 * half * ratio),
                ).data
            let max = 0
            for (let i = 3; i < data.length; i += 4) max = Math.max(max, data[i]!)
            return max
        }, scenePath)
    const setLastActive = (value: number) =>
        page.evaluate((value) => (window.editorTest.view.lastActive = value), value)

    await setLastActive(Number.POSITIVE_INFINITY)
    await settle(page)
    expect((await draws()).names.sort()).toEqual(['Center', 'Side stage'])
    const active = await anchorAlpha()

    // Idle, they go.
    await setLastActive(Number.NEGATIVE_INFINITY)
    await settle(page)
    expect(await anchorAlpha()).toBeLessThan(active - 60)
    const idle = await draws()
    expect(idle.count).toBeGreaterThan(0)
    expect(idle.names).toEqual([])
    const idleAlpha = await anchorAlpha()

    // A hovered note keeps its name and outline while idle.
    const anchor = await at(page, -3, 1)
    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.move(anchor.x + 2, anchor.y)
    await setLastActive(Number.NEGATIVE_INFINITY)
    await settle(page)
    expect((await draws()).names).toEqual(['Center'])
    expect(await anchorAlpha()).toBeGreaterThan(idleAlpha + 60)
})

test.describe('smooth scrolling', () => {
    type Viewport = typeof import('../../src/editor/elevation/viewport')
    const viewportPath = '/src/editor/elevation/viewport.ts'
    const viewport = (page: Page) =>
        page.evaluate(async (path) => {
            const { elevationViewport } = await window.editorTest.appImport<Viewport>(path)
            const scrolling = window.editorTest.view.scrollingY
            return {
                center: elevationViewport.center,
                scale: elevationViewport.scale,
                type: scrolling?.type,
                target: scrolling?.type === 'paneEase' ? scrolling.to.value : undefined,
            }
        }, viewportPath)
    // The centre each frame until the scroll ends.
    const frames = (page: Page) =>
        page.evaluate(async (path) => {
            const { elevationViewport } = await window.editorTest.appImport<Viewport>(path)
            const centers: number[] = []
            for (let i = 0; i < 120 && window.editorTest.view.scrollingY; i++) {
                await new Promise((resolve) => requestAnimationFrame(resolve))
                centers.push(elevationViewport.center)
            }
            return centers
        }, viewportPath)
    // Strictly between, so it passed through.
    const isBetween = (value: number, a: number, b: number) =>
        value > Math.min(a, b) + 1e-6 && value < Math.max(a, b) - 1e-6

    test.beforeEach(async ({ page }) => {
        await page.evaluate(() => (window.editorTest.settings.mouseSmoothScrolling = true))
        await open(page)
        const empty = await at(page, 6, 6)
        await page.mouse.move(empty.x, empty.y)
    })

    test('the wheel eases the view to where it scrolls', async ({ page }) => {
        const start = await viewport(page)
        await page.mouse.wheel(0, 200)
        const easing = await viewport(page)
        expect(easing.type).toBe('paneEase')
        const target = start.center - 200 / start.scale
        expect(easing.target).toBeCloseTo(target, 9)
        const centers = await frames(page)
        expect(centers.some((center) => isBetween(center, start.center, target))).toBe(true)
        expect(centers.at(-1)).toBeCloseTo(target, 9)
        // A second wheel mid-way adds to where the first was going.
        await page.mouse.wheel(0, 100)
        await page.mouse.wheel(0, 100)
        expect((await viewport(page)).target).toBeCloseTo(target - 200 / start.scale, 9)
    })

    test('Page Down eases', async ({ page }) => {
        const start = await viewport(page)
        await page.keyboard.press('PageDown')
        const easing = await viewport(page)
        expect(easing.type).toBe('paneEase')
        const centers = await frames(page)
        expect(centers.some((center) => isBetween(center, start.center, easing.target!))).toBe(true)
        expect(centers.at(-1)).toBeCloseTo(easing.target!, 9)
        expect(easing.target).toBeLessThan(start.center)
    })

    test('a press stops it where it is', async ({ page }) => {
        const start = await viewport(page)
        const target = start.center - 400 / start.scale
        await page.mouse.wheel(0, 400)
        await page.mouse.down()
        const stopped = await viewport(page)
        expect(stopped.type).toBeUndefined()
        await settle(page)
        expect((await viewport(page)).center).toBe(stopped.center)
        expect(stopped.center).not.toBeCloseTo(target, 3)
        expect(stopped.center).toBeLessThanOrEqual(start.center)
        await page.mouse.up()
    })

    test('a direct scroll during it moves where it ends', async ({ page }) => {
        const start = await viewport(page)
        await page.keyboard.press('PageDown')
        const { target } = await viewport(page)
        await page.evaluate(() => (window.editorTest.settings.mouseSmoothScrolling = false))
        await page.mouse.wheel(0, 100)
        expect((await viewport(page)).target).toBeCloseTo(target! - 100 / start.scale, 9)
        const centers = await frames(page)
        expect(centers.at(-1)).toBeCloseTo(target! - 100 / start.scale, 9)
    })

    test('with reduced motion and smooth scrolling off, Page Down jumps', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.evaluate(() => (window.editorTest.settings.mouseSmoothScrolling = false))
        const start = await viewport(page)
        // The centre over the next frames.
        const recording = page.evaluate(async (path) => {
            const { elevationViewport } = await window.editorTest.appImport<Viewport>(path)
            const centers: number[] = []
            for (let i = 0; i < 30; i++) {
                await new Promise((resolve) => requestAnimationFrame(resolve))
                centers.push(elevationViewport.center)
            }
            return centers
        }, viewportPath)
        await page.keyboard.press('PageDown')
        const centers = await recording
        const height = await page.evaluate(
            async (path) => (await window.editorTest.appImport<Viewport>(path)).elevationBounds.h,
            viewportPath,
        )
        const target = start.center - height / start.scale
        expect(centers.at(-1)).toBeCloseTo(target, 9)
        expect(
            centers.every(
                (center) =>
                    Math.abs(center - start.center) < 1e-9 || Math.abs(center - target) < 1e-9,
            ),
        ).toBe(true)
    })

    test('a chart load fitting the view drops it', async ({ page }) => {
        await page.mouse.wheel(0, 400)
        expect((await viewport(page)).type).toBe('paneEase')
        // As a chart load while it's open asks.
        await page.evaluate(async (path) => {
            const { needsElevationFit } = await window.editorTest.appImport<Viewport>(path)
            needsElevationFit.value = true
            await window.editorTest.nextTick()
        }, viewportPath)
        const fitted = await viewport(page)
        expect(fitted.type).toBeUndefined()
        await settle(page)
        await settle(page)
        expect((await viewport(page)).center).toBe(fitted.center)
    })

    test('switching panes drops it', async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 1080 })
        await page.evaluate(() => {
            window.editorTest.settings.elevationEditorSideBySide = 'allow'
        })
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await settle(page)
        const empty = await at(page, 6, 6)
        await page.mouse.move(empty.x, empty.y)
        const time = await page.evaluate(() => window.editorTest.view.time)
        const chart = (await page.locator('canvas.editor-chart').boundingBox())!
        const start = await viewport(page)
        const target = start.center - 400 / start.scale
        await page.mouse.wheel(0, 400)
        await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height / 2)
        expect((await viewport(page)).type).toBeUndefined()
        await settle(page)
        const { center } = await viewport(page)
        await settle(page)
        expect((await viewport(page)).center).toBe(center)
        expect(center).not.toBeCloseTo(target, 3)
        expect(await page.evaluate(() => window.editorTest.view.time)).toBe(time)
    })
})
