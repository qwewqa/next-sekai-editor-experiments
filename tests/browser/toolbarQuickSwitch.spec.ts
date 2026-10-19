import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, touchInput } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        const { settings } = window.editorTest
        settings.showPreview = false
        settings.toolbarQuickSwitch = true
    })
})

const toolbar = (page: Page) => page.locator('[data-editor-toolbar]')
const face = (page: Page, index: number) =>
    toolbar(page).locator(':scope > div > div > button').nth(index)
const row = (page: Page, title: string) =>
    toolbar(page)
        .locator(':scope > div > div > div button')
        .and(page.getByTitle(title, { exact: true }))
const isOpen = (page: Page) => toolbar(page).locator('[aria-expanded="true"]').count()
const toolName = (page: Page) =>
    page.evaluate(
        async () =>
            (
                await window.editorTest.appImport<typeof import('../../src/editor/tools/state')>(
                    '/src/editor/tools/state.ts',
                )
            ).toolName.value,
    )
const centre = async (page: Page, locator: ReturnType<typeof face>) => {
    const box = (await locator.boundingBox())!
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// The default toolbar: Select's group is 3, with Brush and Eraser; Note's group is 5.
const select = 3
const note = 5

test.describe('mouse', () => {
    test('a drag from a face to a row picks the row', async ({ page }) => {
        const from = await centre(page, face(page, select))
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        const to = await centre(page, row(page, 'Brush'))
        await page.mouse.move(to.x, to.y, { steps: 5 })
        await page.mouse.up()
        expect(await toolName(page)).toBe('brush')
        await expect(face(page, select)).toHaveAttribute('title', 'Brush')
    })

    test('a drag back to the face runs the face', async ({ page }) => {
        await page.keyboard.press('g')
        const from = await centre(page, face(page, select))
        await expect(face(page, select)).toHaveAttribute('title', 'Eraser')
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        const over = await centre(page, row(page, 'Brush'))
        await page.mouse.move(over.x, over.y, { steps: 5 })
        await page.mouse.move(from.x, from.y, { steps: 5 })
        await page.mouse.up()
        expect(await toolName(page)).toBe('eraser')
        expect(await isOpen(page)).toBe(0)
    })

    test('a drag released off the face and its flyout cancels', async ({ page }) => {
        const from = await centre(page, face(page, select))
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        const over = await centre(page, row(page, 'Brush'))
        await page.mouse.move(over.x, over.y, { steps: 5 })
        // Onto another group, then the chart.
        const other = await centre(page, face(page, note))
        await page.mouse.move(other.x, other.y, { steps: 5 })
        await page.mouse.move(700, 300, { steps: 5 })
        await page.mouse.up()
        expect(await toolName(page)).toBe('select')
        await expect(face(page, select)).toHaveAttribute('title', 'Select')
        expect(await isOpen(page)).toBe(0)
    })

    test('a click on a face whose flyout is closed runs it', async ({ page }) => {
        const at = await centre(page, face(page, note))
        await page.mouse.move(at.x, at.y)
        await page.keyboard.press('Escape')
        expect(await isOpen(page)).toBe(0)
        await page.mouse.down()
        await page.mouse.up()
        expect(await toolName(page)).toBe('note')
    })
})

test.describe('touch', () => {
    test.use({ hasTouch: true })

    test('a tap runs the face at once, without showing its flyout', async ({ page }) => {
        const touch = await touchInput(page)
        const at = await centre(page, face(page, note))
        await touch('touchStart', [[at.x, at.y]])
        expect(await isOpen(page)).toBe(0)
        await touch('touchEnd', [])
        expect(await toolName(page)).toBe('note')
        expect(await isOpen(page)).toBe(0)
    })

    test('a held press shows the flyout, and a drag to a row picks it', async ({ page }) => {
        const touch = await touchInput(page)
        const at = await centre(page, face(page, select))
        await touch('touchStart', [[at.x, at.y]])
        await expect.poll(() => isOpen(page)).toBe(1)
        const to = await centre(page, row(page, 'Eraser'))
        for (let step = 1; step <= 5; step++)
            await touch('touchMove', [
                [at.x + ((to.x - at.x) * step) / 5, at.y + ((to.y - at.y) * step) / 5],
            ])
        await expect(row(page, 'Eraser')).toHaveClass(/(^|\s)is-pressed(\s|$)/)
        await touch('touchEnd', [])
        expect(await toolName(page)).toBe('eraser')
        await expect(face(page, select)).toHaveAttribute('title', 'Eraser')
    })

    test('moving shows the flyout at once', async ({ page }) => {
        const touch = await touchInput(page)
        const at = await centre(page, face(page, select))
        await touch('touchStart', [[at.x, at.y]])
        await touch('touchMove', [[at.x, at.y - 10]])
        expect(await isOpen(page)).toBe(1)
        await touch('touchMove', [[700, 300]])
        await touch('touchEnd', [])
        expect(await toolName(page)).toBe('select')
        expect(await isOpen(page)).toBe(0)
    })

    test('a tap that opens a dialog leaves it open', async ({ page }) => {
        const touch = await touchInput(page)
        await page.evaluate(() => {
            window.editorTest.settings.toolbar = [['settings'], ['help', 'utilities']]
        })
        for (const index of [0, 1]) {
            const at = await centre(page, face(page, index))
            await touch('touchStart', [[at.x, at.y]])
            await touch('touchEnd', [])
            const dialog = page.locator('dialog[open]')
            await expect(dialog).toHaveCount(1)
            await page.waitForTimeout(300)
            await expect(dialog).toHaveCount(1)
            await page.keyboard.press('Escape')
            await expect(dialog).toHaveCount(0)
        }
    })

    test('off, a tap only opens the flyout', async ({ page }) => {
        await page.evaluate(() => {
            window.editorTest.settings.toolbarQuickSwitch = false
        })
        await face(page, note).tap()
        expect(await isOpen(page)).toBe(1)
        expect(await toolName(page)).toBe('select')
    })
})

test('the keyboard still opens a flyout', async ({ page }) => {
    await face(page, select).focus()
    await page.keyboard.press('Enter')
    expect(await isOpen(page)).toBe(1)
    expect(await toolName(page)).toBe('select')
})

test('a flyout rises over a top dock, within the window and on its tool', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 800 })
    await page.evaluate(() => {
        const { settings } = window.editorTest
        settings.toolbarQuickSwitch = false
        settings.previewPosition = 'top'
        settings.showPreview = true
        settings.topDockHeight = 500
    })
    // The slide group, with seven rows.
    const slide = face(page, 6)
    await slide.hover()
    const flyout = toolbar(page).locator(':scope > div > div > div').first()
    await expect(flyout).toBeVisible()
    await expect
        .poll(() => flyout.evaluate((element) => element.matches(':popover-open')))
        .toBe(true)
    const placed = await flyout.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const tool = element.parentElement!.querySelector(':scope > button')!
        const pane = document.querySelector('.chart-pane')!.getBoundingClientRect()
        const first = element.querySelector('button')!.getBoundingClientRect()
        const hit = document.elementFromPoint(first.left + first.width / 2, first.top + 4)
        return {
            top: box.top,
            bottom: box.bottom,
            toolTop: tool.getBoundingClientRect().top,
            paneTop: pane.top,
            clipped: element.scrollHeight > element.clientHeight,
            onTop: element.contains(hit),
        }
    })
    expect(placed.top).toBeLessThan(placed.paneTop)
    expect(placed.top).toBeGreaterThanOrEqual(8)
    expect(Math.abs(placed.bottom - placed.toolTop)).toBeLessThan(1)
    expect(placed.clipped).toBe(false)
    expect(placed.onTop).toBe(true)
})

test('a dialog or the context menu opening closes a flyout', async ({ page }) => {
    await page.evaluate(() => {
        window.editorTest.settings.toolbarQuickSwitch = false
    })
    await face(page, select).focus()
    await page.keyboard.press('Enter')
    expect(await isOpen(page)).toBe(1)
    await page.evaluate(async () => {
        const { openContextMenu } = await window.editorTest.appImport<
            typeof import('../../src/editor/contextMenu')
        >('/src/editor/contextMenu.ts')
        openContextMenu(700, 300)
    })
    await expect.poll(() => isOpen(page)).toBe(0)
    await page.evaluate(async () => {
        const { closeContextMenu } = await window.editorTest.appImport<
            typeof import('../../src/editor/contextMenu')
        >('/src/editor/contextMenu.ts')
        closeContextMenu()
    })
    await face(page, select).focus()
    await page.keyboard.press('Enter')
    expect(await isOpen(page)).toBe(1)
    await page.evaluate(async () => {
        const { commands } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands')
        >('/src/editor/commands/index.ts')
        void commands.help.execute()
    })
    await expect(page.locator('dialog[open]')).toBeVisible()
    await expect.poll(() => isOpen(page)).toBe(0)
})
