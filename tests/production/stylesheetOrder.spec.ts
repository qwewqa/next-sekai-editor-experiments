import { expect, test, type Page } from '@playwright/test'
import { editorReady } from './fixtures'

// The release build links the editor's own stylesheet before the shared chunks' sheets, as the dev
// server orders them, so a component's rule that ties with index.css wins in both. Each case is a
// tie that went the other way in the release build.

const single = (beat: number, extra: Record<string, unknown> = {}) => ({
    type: 'single',
    beat,
    timeScaleGroup: 0,
    lane: 0,
    size: 1.5,
    critical: false,
    trace: false,
    ...extra,
})
// Taps, a flick and traces: the figures' bubbles have a Tap and Flick line and an All line.
const chart = Buffer.from(
    JSON.stringify({
        version: 2,
        usc: {
            offset: 0,
            objects: [
                { type: 'bpm', beat: 0, bpm: 120 },
                single(0),
                single(0.5, { critical: true }),
                single(1, { direction: 'up' }),
                single(1.5, { trace: true }),
                single(2, { trace: true }),
                single(2.5),
                single(3, { trace: true }),
            ],
        },
    }),
)

const start = async (page: Page) => {
    await page.addInitScript(() => {
        Object.defineProperty(window, 'showOpenFilePicker', {
            configurable: true,
            value: undefined,
        })
        // The fixture hook: a blank start, at once.
        localStorage.setItem('nse.test.startBlank', 'true')
    })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await editorReady(page)
}

const frames = (page: Page) =>
    page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    )

const openStatistics = async (page: Page) => {
    await frames(page)
    const opening = page.waitForEvent('filechooser')
    await page.keyboard.press('o')
    await (
        await opening
    ).setFiles({ name: 'stylesheets.usc', mimeType: 'application/json', buffer: chart })
    await expect(
        page.locator('.notification, .notification-pill').filter({ hasText: 'Imported USC chart' }),
    ).toBeVisible()
    await page.locator('[data-editor-toolbar] button').first().hover()
    await page.locator('[data-editor-toolbar] button[title="Statistics"]').focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Statistics', exact: true })
    await expect(dialog.locator('[data-statistics-figures]')).toBeVisible()
    return dialog
}

for (const width of [1280, 390])
    test(`at ${width} px the figure bubble keeps each label and its value on one line`, async ({
        page,
        browserName,
    }) => {
        test.skip(browserName !== 'chromium', 'The order is the same in every engine.')
        await start(page)
        const dialog = await openStatistics(page)
        await page.setViewportSize({ width, height: 844 })
        const average = dialog.locator('[data-statistics-figure="average"] button')
        // On the phone the figures are below the fold, and a scroll closes the bubble.
        await average.scrollIntoViewIfNeeded()
        await frames(page)
        await average.click()
        const bubble = page.locator('[data-statistics-bubble]')
        await expect(bubble.locator('dt')).toHaveText(['Tap & Flick', 'All'])
        await expect(bubble).not.toHaveClass(/invisible/)
        const lines = await bubble.evaluate((element) => {
            const lineHeight = parseFloat(getComputedStyle(element).lineHeight)
            const boxes = [...element.children].map((child) => child.getBoundingClientRect())
            return boxes
                .filter((_, i) => i % 2 === 0)
                .map((label, i) => {
                    const value = boxes[i * 2 + 1]!
                    return {
                        oneLine: label.height <= lineHeight && value.height <= lineHeight,
                        sameLine: label.top === value.top,
                        valueRight: value.left >= label.right,
                    }
                })
        })
        expect(lines).toEqual(Array(2).fill({ oneLine: true, sameLine: true, valueRight: true }))
    })

test('a dragged row keeps its lifted ring when it becomes current and checked', async ({
    page,
    browserName,
}) => {
    test.skip(browserName !== 'chromium', 'The order is the same in every engine.')
    await start(page)
    // Rows ease their box-shadow; without transitions a read gives the final ring.
    await page.addStyleTag({ content: '*, ::before, ::after { transition: none !important; }' })
    const panel = page.getByRole('region', { name: 'Groups' })
    await panel.getByRole('button', { name: 'Add Group' }).click()
    await panel.locator('.manager-name', { hasText: 'Default' }).click()
    const current = panel.locator('.manager-row-current:not(.manager-row-heading) .manager-name')
    await expect(current).toHaveText('Default')
    const from = (await current.boundingBox())!
    const to = (await panel
        .locator('.manager-row:not(.manager-row-current):not(.manager-row-heading) .manager-name')
        .boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 8 })
    const dragged = panel.locator('.manager-row-dragging')
    await expect(dragged).toHaveCount(1)
    // Select All during the drag checks the dragged row too.
    await page.keyboard.press('Control+a')
    await expect(dragged).toHaveClass(/row-checked/)
    await expect(dragged).toHaveClass(/row-current/)
    // The drag's 1 px ring, not the checked current row's 2 px one.
    const shadow = await dragged.evaluate((row) => getComputedStyle(row).boxShadow)
    expect(shadow).toMatch(/ 0px 0px 0px 1px/)
    expect(shadow).not.toMatch(/ 0px 0px 0px 2px/)
    await page.mouse.up()
})

test('in Firefox a value in Statistics shows its own focus ring, not the native one', async ({
    page,
    browserName,
}) => {
    test.skip(browserName !== 'firefox', 'Only Firefox draws a native ring for :-moz-focusring.')
    await start(page)
    await openStatistics(page)
    let found = false
    for (let i = 0; i < 40 && !found; i++) {
        await page.keyboard.press('Tab')
        found = await page.evaluate(
            () => document.activeElement?.classList.contains('stats-split') ?? false,
        )
    }
    expect(found).toBe(true)
    // The button draws no outline of its own; its ::before draws the 2 px ring.
    const rings = await page.evaluate(() => {
        const button = document.activeElement as Element
        const ring = getComputedStyle(button, '::before')
        return {
            button: getComputedStyle(button).outlineStyle,
            ring: `${ring.outlineStyle} ${ring.outlineWidth}`,
            ringColor: ring.outlineColor,
        }
    })
    expect(rings.button).not.toBe('auto')
    expect(rings.ring).toBe('solid 2px')
    expect(rings.ringColor).toMatch(/^rgb\(/)
})
