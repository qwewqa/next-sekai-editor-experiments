import { expect, test } from '@playwright/test'
import { installCanvasCounters } from './editorFixture'

test('Help marks each command of an entry with its toolbar icon', async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.getByRole('button', { name: 'Help', exact: true }).click()
    const dialog = page.locator('dialog[open]')
    await expect(dialog.getByRole('heading', { level: 3 }).first()).toBeVisible()

    // Each member of a heading is an icon column and its command's name.
    const entries = await dialog.getByRole('heading', { level: 3 }).evaluateAll((headings) =>
        headings.map((heading) => ({
            icons: [...heading.querySelectorAll(':scope > span > [aria-hidden="true"]')].filter(
                (icon) => icon.firstElementChild !== null,
            ).length,
            members: heading.querySelectorAll(':scope > span').length,
        })),
    )
    // Every command has an icon, and an entry with no command has none.
    expect(entries.every((entry) => entry.icons === entry.members)).toBe(true)
    expect(entries.filter((entry) => entry.members === 0)).toHaveLength(6)
    expect(Math.max(...entries.map((entry) => entry.icons))).toBe(6)

    // Wide glyphs such as BPM fit the chip, so every title starts at one edge.
    const starts = await dialog.locator('h3 > span').evaluateAll((members) =>
        members.map((member) => {
            const range = document.createRange()
            // The title is the member's text node; a shortcut follows it in a <kbd>.
            const title = [...member.childNodes].find(
                (node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim(),
            )!
            range.selectNodeContents(title)
            return range.getBoundingClientRect().left - member.getBoundingClientRect().left
        }),
    )
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(0.5)
    // The icon is decorative; the heading keeps its name, followed by the shortcut.
    await expect(dialog.getByRole('heading', { level: 3, name: /^BPM( |$)/ })).toBeVisible()
    // A family reads as a list of its commands.
    await expect(
        dialog.getByRole('heading', { level: 3, name: /^Slide( .)?, Slide #1/ }),
    ).toBeVisible()
})
