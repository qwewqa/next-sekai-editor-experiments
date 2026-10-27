import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type english from '../../src/i18n/en/index.json'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Help: the order of its sections by pointer, and the lines and shortcuts that depend on the
// settings.

const messages = JSON.parse(
    readFileSync(new URL('../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as typeof english
const { modal } = messages.help

const boot = async (page: Page) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

const openHelp = async (page: Page) => {
    await page.evaluate(async () => {
        const { commands } =
            (await import('/src/editor/commands/index.ts')) as typeof import('../../src/editor/commands')
        const { runCommand } =
            (await import('/src/editor/commands/runCommand.ts')) as typeof import('../../src/editor/commands/runCommand')
        await runCommand(commands.help, 'button')
    })
    const dialog = page.getByRole('dialog', { name: modal.title })
    await expect(dialog).toBeVisible()
    return dialog
}

const titles = (dialog: ReturnType<Page['locator']>) =>
    dialog.getByRole('heading', { level: 2 }).evaluateAll((headings) =>
        headings.map((heading) =>
            [...heading.childNodes]
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.textContent)
                .join('')
                .trim(),
        ),
    )

const heading = (dialog: ReturnType<Page['locator']>, title: string) =>
    dialog.getByRole('heading', { level: 2, name: new RegExp(`^${title}( |$)`) })

test.describe('with a fine pointer', () => {
    test('Getting Started, Mouse and Keyboard come first and Touchscreen is last', async ({
        page,
    }) => {
        await boot(page)
        const all = await titles(await openHelp(page))
        expect(all.slice(0, 4)).toEqual([
            modal.gettingStarted.title,
            modal.mouse.title,
            modal.keyboard.title,
            messages.help.fileTitle,
        ])
        expect(all.at(-1)).toBe(modal.touchscreen.title)
    })

    test('the right button line follows the Secondary Tool setting', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        await expect(dialog).toContainText(modal.mouse.contextMenu)
        await expect(dialog).not.toContainText(modal.mouse.secondary.split('{0}')[0])

        await page.evaluate(() => (window.editorTest.settings.mouseSecondaryTool = 'select'))
        await expect(dialog).toContainText(
            modal.mouse.secondary.replace('{0}', messages.commands.select.title),
        )
        await expect(dialog).not.toContainText(modal.mouse.contextMenu)

        await page.evaluate(() => (window.editorTest.settings.mouseSecondaryTool = 'eraser'))
        await expect(dialog).toContainText(
            modal.mouse.secondary.replace('{0}', messages.commands.eraser.title),
        )
    })

    test('the long press and quick scroll lines follow their settings', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        await expect(dialog).toContainText(modal.touchscreen.longPress)
        await expect(dialog).toContainText(modal.touchscreen.quickScroll)

        await page.evaluate(() => {
            window.editorTest.settings.touchLongPressContextMenu = false
            window.editorTest.settings.touchQuickScrollWidth = 0
        })
        await expect(dialog).not.toContainText(modal.touchscreen.longPress)
        await expect(dialog).not.toContainText(modal.touchscreen.quickScroll)
        await expect(dialog).toContainText(modal.touchscreen.scroll)
    })

    test('a tool heading shows its current shortcut, and none when it has no binding', async ({
        page,
    }) => {
        await boot(page)
        const dialog = await openHelp(page)
        const note = heading(dialog, messages.commands.note.title.default)
        await expect(note.locator('kbd')).toHaveText('A')

        await page.evaluate(() => {
            const { settings } = window.editorTest
            settings.keyboardShortcuts = { ...settings.keyboardShortcuts, note: 'q' }
        })
        await expect(note.locator('kbd')).toHaveText('Q')

        const offset = heading(dialog, messages.commands.offset.title)
        await expect(offset).toBeVisible()
        await expect(offset.locator('kbd')).toHaveCount(0)
    })
})

test.describe('with a coarse pointer', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('Touchscreen comes after Getting Started, and Mouse and Keyboard are last', async ({
        page,
    }) => {
        await boot(page)
        const dialog = await openHelp(page)
        const all = await titles(dialog)
        expect(all.slice(0, 3)).toEqual([
            modal.gettingStarted.title,
            modal.touchscreen.title,
            messages.help.fileTitle,
        ])
        expect(all.slice(-2)).toEqual([modal.mouse.title, modal.keyboard.title])
    })

    test('headings show no shortcuts', async ({ page }) => {
        await boot(page)
        const dialog = await openHelp(page)
        await expect(heading(dialog, messages.commands.note.title.default)).toBeVisible()
        await expect(dialog.locator('h2 kbd')).toHaveCount(0)
    })
})
