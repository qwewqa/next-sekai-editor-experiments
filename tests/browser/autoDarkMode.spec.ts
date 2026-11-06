import { expect, test, type Locator, type Page } from '@playwright/test'
import { themes } from '../../src/themes'

// Chrome on Android can darken pages itself while the system is dark (auto dark mode), and the
// editor's themes opt out of it. Chromium's emulation of that mode stands in for the phone.

// A white raised button in Light, which Chrome turns dark.
const button = (page: Page) => page.locator('[data-editor-toolbar] button[title="Undo"]')

/** The element's picture once two in a row match: after load, a notice slides in just above it. */
const settled = async (locator: Locator) => {
    let previous = await locator.screenshot()
    for (;;) {
        await locator.page().waitForTimeout(100)
        const shot = await locator.screenshot()
        if (shot.equals(previous)) return shot
        previous = shot
    }
}

/** A light-scheme element's `Canvas` background is white unless the browser darkens it. */
const autoDarkActive = (page: Page) =>
    page.evaluate(() => {
        const probe = document.createElement('div')
        probe.style.cssText = 'display: none; color-scheme: light; background-color: Canvas'
        document.body.append(probe)
        const { backgroundColor } = getComputedStyle(probe)
        probe.remove()
        return backgroundColor !== 'rgb(255, 255, 255)'
    })

for (const theme of themes)
    test(`auto dark mode leaves the ${theme} theme as it is`, async ({ page }) => {
        // As in battery saver: the system is dark, whatever theme the editor shows.
        await page.emulateMedia({ colorScheme: 'dark' })
        await page.addInitScript((value) => {
            localStorage.setItem('sonolus-next-sekai-editor.theme', JSON.stringify(value))
        }, theme)
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(button(page)).toBeVisible()
        const before = await settled(button(page))

        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Emulation.setAutoDarkModeOverride', { enabled: true })
        await expect.poll(() => autoDarkActive(page)).toBe(true)
        expect(await button(page).screenshot()).toEqual(before)
    })
