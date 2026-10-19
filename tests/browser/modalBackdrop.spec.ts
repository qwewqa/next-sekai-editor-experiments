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
/** A point on the backdrop, beside the dialog. */
const beside = async (dialog: Locator) => {
    const { box } = await centre(dialog)
    return { x: box.x + box.width + 40, y: box.y + box.height / 2 }
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
        await page.waitForTimeout(200)
        await expect(dialog).toBeVisible()
        await expect(input).toHaveValue('12345')
        expect(await answers(page)).toEqual([])
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
        await page.waitForTimeout(200)
        await expect(dialog).toBeVisible()
        await expect(input).toHaveValue('12345')
        expect(await answers(page)).toEqual([])
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
        await page.waitForTimeout(200)
        await expect(dialog).toBeVisible()
        await expect(input).toHaveValue('12345')
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
        await page.waitForTimeout(200)
        await expect(dialog).toBeVisible()
        await expect(input).toHaveValue('12345')
    })
})
