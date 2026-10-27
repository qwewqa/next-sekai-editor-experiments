import { expect, test } from '@playwright/test'
import { installCanvasCounters } from './editorFixture'

test('Help marks each tool section with its toolbar icon', async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.getByRole('button', { name: 'Help', exact: true }).click()
    const dialog = page.locator('dialog[open]')
    const headings = dialog.getByRole('heading', { level: 2 })
    await expect(headings.first()).toBeVisible()

    const icons = await headings.evaluateAll((elements) =>
        elements.map((heading) => [
            [...heading.childNodes]
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.textContent)
                .join('')
                .trim(),
            heading.querySelector(':scope > [aria-hidden="true"] > *') !== null,
        ]),
    )
    const iconed = icons.filter(([, icon]) => icon).map(([title]) => title)
    expect(iconed).toEqual([
        'Select',
        'Eraser',
        'Brush',
        'Paste',
        'Generate Slide Notes',
        'Note',
        'Slide',
        'BPM',
        'Time Scale',
        'Event',
        'Offset',
    ])
    // Wide glyphs such as BPM fit the chip, so every iconed title starts at one edge.
    const starts = await headings.evaluateAll((elements) =>
        elements
            .filter((heading) => heading.querySelector(':scope > [aria-hidden="true"]'))
            .map((heading) => {
                const range = document.createRange()
                // The title is the heading's text node; a shortcut follows it in a <kbd>.
                const title = [...heading.childNodes].find(
                    (node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim(),
                )!
                range.selectNodeContents(title)
                return range.getBoundingClientRect().left
            }),
    )
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(0.5)
    // Getting Started, Mouse and Keyboard have no single tool.
    expect(icons.slice(0, 3).every(([, icon]) => !icon)).toBe(true)
    // The icon is decorative; the heading keeps its name, followed by the shortcut.
    await expect(dialog.getByRole('heading', { name: /^BPM( |$)/ })).toBeVisible()
})
