import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// The confirm dialog shares the choice dialog's accidental-activation guard (docs/color-system.md,
// 8.2): a press or a held key in its first 300 ms is not a choice. Focus opens on the confirm button, or on
// Cancel when the confirm is destructive.

const boot = async (page: Page) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

/** Opens a destructive confirm and keeps its answer in `window.answers`. */
const open = (page: Page, destructive = true) =>
    page.evaluate(async (destructive) => {
        const { showModal } =
            await window.editorTest.appImport<typeof import('../../src/modals/index')>(
                '/src/modals/index.ts',
            )
        const { default: ConfirmModal } = await window.editorTest.appImport<
            typeof import('../../src/modals/ConfirmModal.vue')
        >('/src/modals/ConfirmModal.vue')
        const answers = (Reflect.get(window, 'answers') ?? []) as unknown[]
        Reflect.set(window, 'answers', answers)
        void showModal(ConfirmModal, {
            title: () => 'Delete Group',
            message: () => 'Delete the group?',
            confirm: () => 'Delete',
            destructive,
        }).then((answer) => answers.push(String(answer)))
    }, destructive)

const dialog = (page: Page) => page.getByRole('dialog').last()
const answers = (page: Page) => page.evaluate(() => Reflect.get(window, 'answers') as string[])

// Past the 300 ms guard.
const settle = (page: Page) => page.waitForTimeout(400)

test('a destructive confirm lists the action first and focuses Cancel, which Enter chooses', async ({
    page,
}) => {
    await boot(page)
    await open(page)
    const confirm = dialog(page).getByRole('button', { name: 'Delete', exact: true })
    const cancel = dialog(page).getByRole('button', { name: 'Cancel', exact: true })
    await expect(cancel).toBeFocused()
    await expect(confirm).not.toBeFocused()
    expect(
        await dialog(page)
            .getByRole('button', { name: /^(Delete|Cancel)$/ })
            .allTextContents(),
    ).toEqual(['Delete', 'Cancel'])
    const look = (button: typeof confirm) =>
        button.evaluate((element) => getComputedStyle(element).backgroundColor)
    // Cancel is the filled primary button; Delete is the quiet red one.
    expect(await look(cancel)).not.toBe(await look(confirm))
    await settle(page)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await answers(page)).toEqual(['false'])
})

test('a confirm that is not destructive focuses its confirm button', async ({ page }) => {
    await boot(page)
    await open(page, false)
    const confirm = dialog(page).getByRole('button', { name: 'Delete', exact: true })
    await expect(confirm).toBeFocused()
    expect(
        await dialog(page)
            .getByRole('button', { name: /^(Delete|Cancel)$/ })
            .allTextContents(),
    ).toEqual(['Cancel', 'Delete'])
})

test('a held Enter and a doubled Enter do not confirm; a later Enter does', async ({ page }) => {
    await boot(page)
    // Enter goes down before the dialog opens, as the press that opened it would.
    await page.keyboard.down('Enter')
    await open(page, false)
    const confirm = dialog(page).getByRole('button', { name: 'Delete', exact: true })
    await expect(confirm).toBeFocused()
    // Repeats of the held key reach the focused button, and are swallowed.
    await page.keyboard.down('Enter')
    await page.keyboard.down('Enter')
    await page.keyboard.up('Enter')
    await expect(dialog(page)).toBeVisible()
    expect(await answers(page)).toEqual([])

    // Past the guard, a fresh press confirms.
    await settle(page)
    await page.keyboard.down('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.keyboard.up('Enter')
    expect(await answers(page)).toEqual(['true'])
})

test('a second Enter within 300 ms does not confirm', async ({ page }) => {
    await page.clock.install()
    await boot(page)
    await page.clock.pauseAt(new Date(Date.now() + 60_000))
    await open(page, false)
    await expect(dialog(page).getByRole('button', { name: 'Delete', exact: true })).toBeFocused()
    // The press that opened the dialog and a second one 80 ms later.
    await page.keyboard.press('Enter')
    await page.clock.runFor(80)
    await page.keyboard.press('Enter')
    expect(await answers(page)).toEqual([])
    await expect(dialog(page)).toBeVisible()
    await page.clock.runFor(300)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await answers(page)).toEqual(['true'])
})

test('Cancel is guarded too, but Escape and × close at once', async ({ page }) => {
    await page.clock.install()
    await boot(page)
    await page.clock.pauseAt(new Date(Date.now() + 60_000))
    await open(page)
    await expect(dialog(page)).toBeVisible()
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await answers(page)).toEqual(['undefined'])

    await page.clock.runFor(1000)
    await open(page)
    await expect(dialog(page)).toBeVisible()
    await dialog(page).getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await answers(page)).toEqual(['undefined', 'false'])
})

test('a deliberate click after the guard confirms', async ({ page }) => {
    await boot(page)
    await open(page, false)
    await settle(page)
    await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await answers(page)).toEqual(['true'])
})
