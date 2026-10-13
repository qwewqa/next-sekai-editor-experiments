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
    test(`Select shows pressed for the Elevation tool, which it and Deselect keep (${sideBySide ? 'side by side' : 'full screen'})`, async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1920, height: 1080 })
        await page.evaluate((sideBySide) => {
            window.editorTest.settings.elevationEditorSideBySide = sideBySide ? 'allow' : 'disallow'
        }, sideBySide)
        await open(page)
        expect(await toolName(page)).toBe('elevation')
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
        expect(await toolName(page)).toBe('elevation')

        await page.locator('.elevation-editor').locator(selects).click()
        await expect(page.locator('.notification')).toHaveText('Switched to Select tool')
        expect(await toolName(page)).toBe('elevation')
        for (const select of await selects.all())
            await expect(select).toHaveAttribute('aria-pressed', 'true')
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
