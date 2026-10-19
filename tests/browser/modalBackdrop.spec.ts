import { expect, test, type Locator, type Page } from '@playwright/test'
import { installEditorFixture } from './editorFixture'

// A click on the dialog element is a backdrop click only when the press began and ended on the
// backdrop. A press that starts in the content and is released over the backdrop, such as
// selecting text in a field, keeps the dialog and what was typed.

const boot = async (page: Page) => {
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

/** Opens the Custom Division form and keeps its answer in `window.answers`. */
const open = async (page: Page) => {
    await page.evaluate(async () => {
        const { showModal } =
            await window.editorTest.appImport<typeof import('../../src/modals/index')>(
                '/src/modals/index.ts',
            )
        const { default: Modal } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/divisions/CustomDivisionModal.vue')
        >('/src/editor/commands/divisions/CustomDivisionModal.vue')
        const answers: string[] = []
        Reflect.set(window, 'answers', answers)
        void showModal(Modal, {}).then((answer) => answers.push(String(answer)))
    })
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const input = dialog.locator('input').first()
    await input.fill('12345')
    return { dialog, input }
}

const answers = (page: Page) => page.evaluate(() => Reflect.get(window, 'answers') as string[])
const centre = async (locator: Locator) => {
    const box = (await locator.boundingBox())!
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }
}
/** A point on the backdrop above the dialog, which is on screen at phone width. */
const above = async (dialog: Locator) => {
    const { box } = await centre(dialog)
    return { x: box.x + box.width / 2, y: box.y / 2 }
}
/** A point on the backdrop, beside the dialog. */
const beside = async (dialog: Locator) => {
    const { box } = await centre(dialog)
    return { x: box.x + box.width + 40, y: box.y + box.height / 2 }
}

/** Proves the dialog stayed open: a real backdrop click still closes it, and only then. */
const closesOnBackdropClick = async (page: Page, dialog: Locator, at: { x: number; y: number }) => {
    expect(await answers(page)).toEqual([])
    await page.mouse.click(at.x, at.y)
    await expect(dialog).toHaveCount(0)
    expect(await answers(page)).toEqual(['undefined'])
}

type Point = { id: number; x: number; y: number }
/** Raw touch events through CDP, so several fingers and drags are exact. */
const touchPad = async (page: Page) => {
    const cdp = await page.context().newCDPSession(page)
    const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', touchPoints: Point[]) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints })
    return {
        start: (points: Point[]) => send('touchStart', points),
        move: (points: Point[]) => send('touchMove', points),
        /** Lifts every finger, or leaves the listed ones down. */
        end: (remaining: Point[] = []) => send('touchEnd', remaining),
    }
}

test.describe('mouse', () => {
    test('a drag-select from a field released over the backdrop keeps the dialog', async ({
        page,
    }) => {
        await boot(page)
        const { dialog, input } = await open(page)
        const field = (await input.boundingBox())!
        const y = field.y + field.height / 2
        const outside = await beside(dialog)
        await page.mouse.move(field.x + field.width - 4, y)
        await page.mouse.down()
        await page.mouse.move(field.x + 4, y, { steps: 4 })
        await page.mouse.move(outside.x, outside.y, { steps: 6 })
        await page.mouse.up()
        await expect(dialog).toBeVisible()
        await expect(input).toHaveValue('12345')
        await closesOnBackdropClick(page, dialog, outside)
    })

    test('a button press released over the backdrop keeps the dialog', async ({ page }) => {
        await boot(page)
        const { dialog, input } = await open(page)
        const button = await centre(dialog.getByRole('button').last())
        const outside = await beside(dialog)
        await page.mouse.move(button.x, button.y)
        await page.mouse.down()
        await page.mouse.move(outside.x, outside.y, { steps: 6 })
        await page.mouse.up()
        await expect(dialog).toBeVisible()
        await expect(input).toHaveValue('12345')
        await closesOnBackdropClick(page, dialog, outside)
    })

    test('a press on the backdrop released over the content keeps the dialog', async ({ page }) => {
        await boot(page)
        const { dialog, input } = await open(page)
        const outside = await beside(dialog)
        const field = await centre(input)
        await page.mouse.move(outside.x, outside.y)
        await page.mouse.down()
        await page.mouse.move(field.x, field.y, { steps: 6 })
        await page.mouse.up()
        await expect(dialog).toBeVisible()
        await expect(input).toHaveValue('12345')
        await closesOnBackdropClick(page, dialog, outside)
    })

    test('a press and release on the backdrop closes the dialog', async ({ page }) => {
        await boot(page)
        const { dialog } = await open(page)
        const outside = await beside(dialog)
        await page.mouse.click(outside.x, outside.y)
        await expect(dialog).toHaveCount(0)
        expect(await answers(page)).toEqual(['undefined'])
    })

    test('a backdrop click after a kept press still closes', async ({ page }) => {
        await boot(page)
        const { dialog, input } = await open(page)
        const outside = await beside(dialog)
        const field = await centre(input)
        await page.mouse.move(field.x, field.y)
        await page.mouse.down()
        await page.mouse.move(outside.x, outside.y, { steps: 6 })
        await page.mouse.up()
        await expect(dialog).toBeVisible()
        await page.mouse.click(outside.x, outside.y)
        await expect(dialog).toHaveCount(0)
    })

    test('Escape and the close button close as before', async ({ page }) => {
        await boot(page)
        let { dialog } = await open(page)
        // The first Escape reverts the typed number; the second closes.
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        expect(await answers(page)).toEqual(['undefined'])
        ;({ dialog } = await open(page))
        await dialog.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(dialog).toHaveCount(0)
        expect(await answers(page)).toEqual(['undefined'])
    })

    test('a keyboard click on a button after a kept press is not a backdrop click', async ({
        page,
    }) => {
        await boot(page)
        const { dialog, input } = await open(page)
        const outside = await beside(dialog)
        const field = await centre(input)
        await page.mouse.move(field.x, field.y)
        await page.mouse.down()
        await page.mouse.move(outside.x, outside.y, { steps: 4 })
        await page.mouse.up()
        await expect(dialog).toBeVisible()
        // Space on Confirm submits what was typed; it never closes as a backdrop click.
        await dialog.getByRole('button', { name: 'Confirm', exact: true }).focus()
        await page.keyboard.press('Space')
        await expect(dialog).toHaveCount(0)
        expect(await answers(page)).toEqual(['12345'])
    })
})

test.describe('touch', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('a tap on the backdrop closes the dialog', async ({ page }) => {
        await boot(page)
        const { dialog } = await open(page)
        const { box } = await centre(dialog)
        await page.touchscreen.tap(box.x + box.width / 2, box.y / 2)
        await expect(dialog).toHaveCount(0)
        expect(await answers(page)).toEqual(['undefined'])
    })

    test('a tap in the content keeps the dialog', async ({ page }) => {
        await boot(page)
        const { dialog, input } = await open(page)
        const field = await centre(input)
        await page.touchscreen.tap(field.x, field.y)
        await expect(dialog).toBeVisible()
        await input.press('6')
        await expect(input).toHaveValue('123456')
        expect(await answers(page)).toEqual([])
    })

    test('a touch drag from a field released over the backdrop keeps the dialog', async ({
        page,
    }) => {
        await boot(page)
        const { dialog, input } = await open(page)
        const field = await centre(input)
        const outside = await above(dialog)
        const touch = await touchPad(page)
        await touch.start([{ id: 1, x: field.x, y: field.y }])
        await touch.move([{ id: 1, x: field.x + 20, y: field.y }])
        await touch.move([{ id: 1, x: outside.x, y: outside.y }])
        await touch.end()
        await expect(dialog).toBeVisible()
        await expect(input).toHaveValue('12345')
        await closesOnBackdropClick(page, dialog, outside)
    })

    test('a second finger on the backdrop does not make the first finger a backdrop click', async ({
        page,
    }) => {
        await boot(page)
        const { dialog, input } = await open(page)
        const field = await centre(input)
        const outside = await above(dialog)
        const touch = await touchPad(page)
        await touch.start([{ id: 1, x: field.x, y: field.y }])
        await touch.start([
            { id: 1, x: field.x, y: field.y },
            { id: 2, x: outside.x, y: outside.y },
        ])
        await touch.end([{ id: 1, x: field.x, y: field.y }])
        await touch.move([{ id: 1, x: outside.x, y: outside.y }])
        await touch.end()
        await expect(dialog).toBeVisible()
        await expect(input).toHaveValue('12345')
        await closesOnBackdropClick(page, dialog, outside)
    })
})
