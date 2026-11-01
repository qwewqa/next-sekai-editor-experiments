import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, useTool } from './editorFixture'

// Where Help opens and where focus goes: the entry for the tool in use, History while a Timeline
// step is shown, the Elevation Editor when it fills the chart, and the section pills.

const boot = async (page: Page) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Help', exact: true })
const scroller = (page: Page) => dialog(page).locator('.overflow-y-auto')

/** How far an element's top is below the scroller's top. */
const offsetIn = (page: Page, selector: string) =>
    page.evaluate((selector) => {
        const area = document.querySelector('dialog[open] .overflow-y-auto')!
        return (
            document.querySelector(selector)!.getBoundingClientRect().top -
            area.getBoundingClientRect().top
        )
    }, selector)

const family =
    'Event D, Camera Event, Stage Mask Event, Stage Pivot Event, Stage Style Event, Stage Transform Event'

test('H opens Help at the Select entry with its heading focused', async ({ page }) => {
    await boot(page)
    await page.keyboard.press('h')
    await expect(dialog(page)).toBeVisible()
    const heading = dialog(page).getByRole('heading', { level: 3, name: 'Select F', exact: true })
    await expect(heading).toBeFocused()
    expect(await offsetIn(page, '#help-entry-select')).toBeLessThan(40)
})

test('with Camera Event in use, Help opens at the Events section', async ({ page }) => {
    await boot(page)
    await useTool(page, 'cameraEvent')
    for (const open of ['key', 'pointer'] as const) {
        if (open === 'key') await page.keyboard.press('h')
        else await page.getByRole('button', { name: 'Help', exact: true }).click()
        const heading = dialog(page).getByRole('heading', { level: 3, name: family, exact: true })
        await expect(heading).toBeFocused()
        await expect(
            dialog(page).getByRole('heading', { level: 2, name: 'Events' }),
        ).toBeInViewport()
        expect(await offsetIn(page, '#help-events')).toBeLessThan(40)
        await page.keyboard.press('Escape')
        await expect(dialog(page)).toHaveCount(0)
    }
})

test('Page Down scrolls Help after a keyboard open', async ({ page }) => {
    await boot(page)
    await page.keyboard.press('h')
    await expect(
        dialog(page).getByRole('heading', { level: 3, name: 'Select F', exact: true }),
    ).toBeFocused()
    const top = await scroller(page).evaluate((element) => element.scrollTop)
    await page.keyboard.press('PageDown')
    await expect
        .poll(() => scroller(page).evaluate((element) => element.scrollTop))
        .toBeGreaterThan(top)
})

test('while a Timeline step is shown, Help opens at History', async ({ page }) => {
    await boot(page)
    await page.evaluate(async () => {
        const { peek } =
            await window.editorTest.appImport<typeof import('../../src/history/stack')>(
                '/src/history/stack.ts',
            )
        peek.value = { source: 'test', state: window.editorTest.history.state.value }
    })
    await page.keyboard.press('h')
    await expect(
        dialog(page).getByRole('heading', { level: 3, name: /^History( |$)/ }),
    ).toBeFocused()
})

test('with the Elevation Editor filling the chart, Help opens at it', async ({ page }) => {
    await boot(page)
    await page.evaluate(async () => {
        const { settings, history, appImport, nextTick } = window.editorTest
        settings.elevationEditorSideBySide = 'disallow'
        const [note] = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({ ...history.state.value, selectedEntities: [note!] })
        const { openElevationEditor } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(3)
        await nextTick()
    })
    await expect(page.locator('.elevation-editor')).toBeVisible()
    await page.keyboard.press('h')
    await expect(
        dialog(page).getByRole('heading', { level: 3, name: /^Elevation Editor( |$)/ }),
    ).toBeFocused()
})

test('with the Elevation Editor beside the chart, Help opens at the tool in use', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1800, height: 900 })
    await boot(page)
    await page.evaluate(async () => {
        const { settings, history, appImport, nextTick } = window.editorTest
        settings.elevationEditorSideBySide = 'allow'
        const [note] = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({ ...history.state.value, selectedEntities: [note!] })
        const { openElevationEditor, isElevationSideBySide } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        openElevationEditor(3)
        await nextTick()
        if (!isElevationSideBySide.value) throw new Error('not side by side')
    })
    await page.keyboard.press('h')
    await expect(
        dialog(page).getByRole('heading', { level: 3, name: 'Select F', exact: true }),
    ).toBeFocused()
})

test('a family heading is named by its commands in the locale', async ({ page }) => {
    await boot(page)
    await page.evaluate(() => (window.editorTest.settings.locale = 'zhs'))
    await useTool(page, 'cameraEvent')
    await page.keyboard.press('h')
    const heading = page.locator('dialog[open] #help-entry-events h3')
    await expect(heading).toBeFocused()
    await expect(heading).toHaveAccessibleName(/、/)
})

test('a pill moves its section to the top and focuses its heading', async ({ page }) => {
    await boot(page)
    await page.keyboard.press('h')
    await dialog(page).locator('[data-help-pill="transform"]').click()
    await expect(
        dialog(page).getByRole('heading', { level: 2, name: 'Transform', exact: true }),
    ).toBeFocused()
    await expect.poll(() => offsetIn(page, '#help-transform')).toBeLessThan(40)
})

test('Esc closes Help and focus returns to where it was', async ({ page }) => {
    await boot(page)
    // A keyboard pick in a toolbar group's flyout returns focus to the group's button.
    const help = page.getByRole('button', { name: 'Help', exact: true })
    await help.focus()
    await page.keyboard.press('Enter')
    const flyout = page.locator('[data-editor-toolbar] .overflow-y-auto')
    await expect(flyout).toBeVisible()
    const item = flyout.getByRole('button', { name: 'Help', exact: true })
    await item.focus()
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await expect(help).toBeFocused()

    const box = (await page.locator('canvas.editor-chart').boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.press('h')
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.locator('.chart-pane').first()).toBeFocused()
})

test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    test('Help fits the width, its pill row scrolls and its lines say tap', async ({ page }) => {
        await boot(page)
        await page.evaluate(async () => {
            const { appImport } = window.editorTest
            const { commands } = await appImport<typeof import('../../src/editor/commands')>(
                '/src/editor/commands/index.ts',
            )
            const { runCommand } = await appImport<
                typeof import('../../src/editor/commands/runCommand')
            >('/src/editor/commands/runCommand.ts')
            await runCommand(commands.help, 'button')
        })
        await expect(dialog(page)).toBeVisible()
        expect(await scroller(page).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
        expect(
            await dialog(page)
                .locator('[data-help-index]')
                .evaluate((nav) => nav.scrollWidth > nav.clientWidth),
        ).toBe(true)
        await expect(dialog(page).locator('h3 kbd')).toHaveCount(0)
        await expect(dialog(page)).toContainText('Tap a Timeline step')
    })
})
