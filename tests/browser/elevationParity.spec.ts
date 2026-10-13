import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const errors = new WeakMap<Page, string[]>()
const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })
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
