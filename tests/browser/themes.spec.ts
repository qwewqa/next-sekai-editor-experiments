import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const key = 'sonolus-next-sekai-editor.theme'
const light = 'rgb(64, 68, 100)'
const dark = 'rgb(35, 37, 57)'

const open = async (page: Page) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

const look = (page: Page) =>
    page.evaluate(async () => {
        const { chartBackground } = await window.editorTest.appImport<
            typeof import('../../src/editor/canvas/nameColors')
        >('/src/editor/canvas/nameColors.ts')
        const root = getComputedStyle(document.documentElement)
        return {
            theme: document.documentElement.dataset.theme,
            scheme: root.colorScheme,
            chart: getComputedStyle(document.body).backgroundColor,
            names: chartBackground.value,
        }
    })

test('the setting picks the theme, and System follows the device live', async ({ page }) => {
    await open(page)
    expect(await look(page)).toEqual({
        theme: 'light',
        scheme: 'light',
        chart: light,
        names: '#404464',
    })
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull()

    await page.emulateMedia({ colorScheme: 'dark' })
    await expect
        .poll(() => look(page))
        .toEqual({
            theme: 'dark',
            scheme: 'dark',
            chart: dark,
            names: '#232539',
        })

    await page.evaluate(() => (window.editorTest.settings.theme = 'light'))
    expect((await look(page)).theme).toBe('light')
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe('"light"')

    await page.emulateMedia({ colorScheme: 'light' })
    await page.evaluate(() => (window.editorTest.settings.theme = 'dark'))
    expect(await look(page)).toEqual({
        theme: 'dark',
        scheme: 'dark',
        chart: dark,
        names: '#232539',
    })
})

// Stored as written: JSON, or text that is not.
for (const [stored, colorScheme, theme] of [
    ['"dark"', 'light', 'dark'],
    ['"light"', 'dark', 'light'],
    [undefined, 'dark', 'dark'],
    ['"unknown"', 'light', 'light'],
    ['{', 'dark', 'dark'],
] as const)
    test(`the theme applies before the app loads (${stored ?? 'unset'}, ${colorScheme} device)`, async ({
        page,
    }) => {
        await page.emulateMedia({ colorScheme })
        if (stored)
            await page.addInitScript(([key, stored]) => localStorage.setItem(key, stored), [
                key,
                stored,
            ] as const)
        let release!: () => void
        const held = new Promise<void>((resolve) => (release = resolve))
        await page.route(/\/src\/index\.ts$/, async (route) => {
            await held
            await route.continue()
        })
        // The development server loads styles with the app; builds link them in the head.
        await page.goto('/', { waitUntil: 'commit' })
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        release()
        await page.waitForLoadState('load')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(page.locator('body')).toHaveCSS(
            'background-color',
            theme === 'dark' ? dark : light,
        )
    })

test('Settings offers the theme after the language', async ({ page }) => {
    await open(page)
    await page.evaluate(async () => {
        const { settings } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/settings')
        >('/src/editor/commands/settings/index.ts')
        settings.execute()
    })
    const dialog = page.getByRole('dialog')
    const labels = await dialog.locator('.form-field-label').allInnerTexts()
    expect(labels.slice(0, 2)).toEqual(['Language', 'Theme'])
    const select = dialog.getByRole('combobox', { name: 'Theme' })
    await expect(select).toHaveValue('system')
    expect(await select.locator('option').allInnerTexts()).toEqual(['System', 'Light', 'Dark'])
    await select.selectOption('dark')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // Reset Settings returns to System, on this light device.
    await dialog.getByRole('button', { name: 'Reset Settings', exact: true }).click()
    await expect(select).toHaveValue('system')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull()
})

test('dialog backdrops get theme colours without inheriting them, as older browsers need', async ({
    page,
}) => {
    await open(page)
    await page.evaluate(async () => {
        const { settings } = await window.editorTest.appImport<
            typeof import('../../src/editor/commands/settings')
        >('/src/editor/commands/settings/index.ts')
        settings.execute()
    })
    const backdrop = () =>
        page.locator('dialog').evaluate((dialog) => {
            // What a browser that doesn't pass custom properties into ::backdrop would see.
            dialog.style.setProperty('--color-scrim', 'initial')
            return getComputedStyle(dialog, '::backdrop').backgroundColor
        })
    expect(await backdrop()).toBe('rgba(64, 68, 100, 0.75)')
    await page.evaluate(() => (window.editorTest.settings.theme = 'dark'))
    expect(await backdrop()).toBe('rgba(16, 17, 32, 0.75)')
})

for (const forcedColors of ['none', 'active'] as const) {
    test(`chart panes draw no focus frame after a key and a click (forced colors ${forcedColors})`, async ({
        page,
    }) => {
        await page.emulateMedia({ colorScheme: 'dark', forcedColors })
        await open(page)
        const frame = async (selector: string) => {
            const pane = page.locator(selector)
            const box = (await pane.boundingBox())!
            // A key first, so the browser treats the click's focus as from the keyboard.
            await page.keyboard.press('ArrowUp')
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
            return pane.evaluate((element) => ({
                focused: element.matches(':focus-visible'),
                outline: getComputedStyle(element).outlineStyle,
            }))
        }
        expect(await frame('.chart-pane:has(canvas.editor-chart)')).toEqual({
            focused: true,
            outline: 'none',
        })
        await page.keyboard.press('t')
        await expect(page.locator('.elevation-canvas')).toBeVisible()
        expect(await frame('.elevation-editor')).toEqual({ focused: true, outline: 'none' })
    })
}
