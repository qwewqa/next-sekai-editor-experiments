import { expect, test, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// Statistics: opening it from the toolbar, the list and its normal and critical breakdown, the
// chart's modes, legend and readout, and Copy Text.

const dialog = (page: Page) =>
    page.getByRole('dialog', { name: en.commands.statistics.title, exact: true })
const row = (page: Page, name: string) => dialog(page).locator(`[data-statistics-row="${name}"]`)
const bubble = (page: Page) => page.locator('[data-statistics-bubble]')
const chart = (page: Page) => dialog(page).locator('[data-statistics-chart]')
const entry = (page: Page, category: string) =>
    dialog(page).locator(`[data-statistics-entry="${category}"]`)
const zoomIn = (page: Page) => dialog(page).locator('[data-statistics-zoom-in]')
const zoomOut = (page: Page) => dialog(page).locator('[data-statistics-zoom-out]')

// A small known chart at 120 BPM: a critical tap slide to beat 2 (three hidden ticks), a flick at
// 1, a trace at 1.5, a damage note at 3 and a fake tap at 4.
const start = async (page: Page, viewport = { width: 1440, height: 900 }) => {
    await page.setViewportSize(viewport)
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        const { fixtures, show } = window.editorTest
        const chart = structuredClone(fixtures.interaction)
        const [base] = chart.slides[0] ?? []
        if (!base) throw new Error('No note')
        const note = (beat: number, overrides: Partial<typeof base> = {}) => ({
            ...base,
            beat,
            ...overrides,
        })
        chart.slides = [
            [note(0, { isCritical: true }), note(2)],
            [note(1, { flickDirection: 'up' })],
            [note(1.5, { noteType: 'trace' })],
            [note(3, { noteType: 'damage' })],
            [note(4, { isFake: true })],
        ]
        show(chart)
    })
}

const open = async (page: Page) => {
    await page.evaluate(async () => {
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        const { commands } = await import('/src/editor/commands/index.ts')
        void runCommand(commands.statistics, 'button')
    })
    await expect(dialog(page)).toBeVisible()
}

test('opened from the flyout of the first group by keyboard, it lists the counts and gives focus back', async ({
    page,
}) => {
    await start(page)
    const face = page.locator('[data-editor-toolbar] button[title="Open…"]')
    await face.hover()
    await page.locator('[data-editor-toolbar] button[title="Statistics"]').focus()
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).locator('[data-statistics-combo]')).toHaveText('8')
    const values = await dialog(page)
        .locator('[data-statistics-row] dd')
        .evaluateAll((items) => items.map((item) => (item as HTMLElement).innerText.trim()))
    expect(values).toEqual(['1', '1', '1', '1', '0', '0', '3', '1', '0', '1'])
    const times = dialog(page).locator('[data-statistics-times]')
    await expect(times).toContainText('00:00.000')
    await expect(times).toContainText('00:01.500')
    await expect(times).toContainText('00:02.000')
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    // Picked, it became the group's face, which takes the focus back.
    await expect(page.locator('[data-editor-toolbar] button[title="Statistics"]')).toBeFocused()
})

test('the command has no default key and is listed with the shortcuts', async ({ page }) => {
    await start(page)
    expect(
        await page.evaluate(
            () =>
                (window.editorTest.settings.keyboardShortcuts as Record<string, unknown>)
                    .statistics,
        ),
    ).toBeUndefined()
    await page.evaluate(async () => {
        const { openSettings } = await import('/src/editor/settings/openSettings.ts')
        void openSettings()
    })
    const names = page
        .getByRole('dialog')
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Keyboard Shortcuts' }) })
        .locator('.form-field-text')
    await expect(names.getByText(en.commands.statistics.title, { exact: true })).toHaveCount(1)
})

test('the breakdown shows by hover and focus, pins, and closes on Escape with the dialog open', async ({
    page,
}) => {
    await start(page)
    await open(page)
    // Rows without a critical variant, or with no notes, have none.
    for (const name of ['hiddenTick', 'damageNote', 'damageTick', 'fakeNote', 'traceFlick'])
        await expect(row(page, name).locator('button')).toHaveCount(0)
    const tap = row(page, 'tap').locator('button')
    await expect(tap).toHaveAccessibleName('Tap 1')
    await expect(tap).toHaveAccessibleDescription('Normal: 0, Critical: 1')

    await row(page, 'tap').hover()
    await expect(bubble(page)).toContainText('Critical')
    await expect(bubble(page)).toContainText('1')
    await page.mouse.move(5, 5)
    await expect(bubble(page)).toHaveCount(0)

    // Keyboard: focus shows it, Enter pins it, Escape closes it and the dialog stays.
    await tap.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(tap).toBeFocused()
    await expect(bubble(page)).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(tap).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(bubble(page)).toHaveCount(0)
    await expect(dialog(page)).toBeVisible()
    await expect(tap).toBeFocused()

    // A click pins it past the pointer's leaving; a press elsewhere closes it.
    await tap.click()
    await page.mouse.move(5, 5)
    await page.waitForTimeout(300)
    await expect(bubble(page)).toBeVisible()
    await dialog(page).locator('[data-statistics-combo]').click()
    await expect(bubble(page)).toHaveCount(0)
})

/** Records each row whose breakdown opens, in order. */
const recordOpens = (page: Page) =>
    page.evaluate(() => {
        const opened: string[] = []
        ;(window as unknown as { opened: string[] }).opened = opened
        new MutationObserver((records) => {
            for (const record of records) {
                const button = record.target as HTMLElement
                if (button.getAttribute('aria-expanded') === 'true')
                    opened.push(
                        button
                            .closest('[data-statistics-row]')
                            ?.getAttribute('data-statistics-row') ?? '',
                    )
            }
        }).observe(document.body, { subtree: true, attributeFilter: ['aria-expanded'] })
    })
const opened = (page: Page) =>
    page.evaluate(() => (window as unknown as { opened: string[] }).opened)
const expanded = (page: Page) => page.locator('[data-statistics-split][aria-expanded="true"]')

test('rows crossed on the way open nothing, and moving from row to row keeps one bubble', async ({
    page,
}) => {
    // The page's clock stands still while the mouse moves, so no crossed row reaches its delay
    // however slowly the runner goes; time then passes only by the clock's steps.
    await page.clock.install()
    await start(page)
    await open(page)
    await recordOpens(page)
    // One fixed time well ahead, so a stall before it cannot make the pause go backwards.
    const pause = new Date('2100-01-01T00:00:00Z')
    await page.clock.setFixedTime(pause)
    await page.clock.pauseAt(pause)
    // The mouse crosses Tap and Flick to rest on Release.
    for (const name of ['tap', 'flick', 'release']) await row(page, name).hover()
    await page.clock.runFor(450)
    await expect(row(page, 'release').locator('button')).toHaveAttribute('aria-expanded', 'true')
    // Moving on to Trace hands over: one bubble, Trace's.
    await row(page, 'trace').hover()
    await page.clock.runFor(450)
    await expect(row(page, 'trace').locator('button')).toHaveAttribute('aria-expanded', 'true')
    await expect(expanded(page)).toHaveCount(1)
    await expect(bubble(page)).toHaveCount(1)
    expect(await opened(page)).toEqual(['release', 'trace'])
})

test('a hovering pen reveals the breakdown as a mouse does', async ({ page }) => {
    await start(page)
    await open(page)
    await row(page, 'flick').dispatchEvent('pointerenter', { pointerType: 'pen', buttons: 0 })
    await expect(bubble(page)).toBeVisible()
    await expect(row(page, 'flick').locator('button')).toHaveAttribute('aria-expanded', 'true')
    // Its leaving closes it, as a mouse's does.
    await row(page, 'flick').dispatchEvent('pointerleave', { pointerType: 'pen', buttons: 0 })
    await expect(bubble(page)).toHaveCount(0)
})

test('a passing hover over another row leaves the wait of the focused row to finish', async ({
    page,
}) => {
    await start(page)
    await open(page)
    const tap = row(page, 'tap').locator('button')
    await tap.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(tap).toBeFocused()
    // During the wait, the mouse crosses the Flick row and leaves the list.
    await row(page, 'flick').hover()
    await page.waitForTimeout(50)
    await page.mouse.move(5, 5)
    await expect(bubble(page)).toBeVisible()
    await expect(tap).toHaveAttribute('aria-expanded', 'true')
})

test('on a phone a tap pins the breakdown, a tap on it keeps it, and a tap elsewhere closes it', async ({
    browser,
}) => {
    const context = await browser.newContext({ hasTouch: true, isMobile: true })
    const page = await context.newPage()
    await start(page, { width: 375, height: 667 })
    await open(page)
    await row(page, 'tap').locator('button').tap()
    await expect(bubble(page)).toBeVisible()
    const box = await bubble(page).boundingBox()
    expect(box && box.x >= 8 && box.x + box.width <= 367).toBe(true)
    await bubble(page).tap()
    await page.waitForTimeout(100)
    await expect(bubble(page)).toBeVisible()
    await dialog(page).getByText(en.statistics.combo, { exact: true }).tap()
    await expect(bubble(page)).toHaveCount(0)
    await context.close()
})

test('the modes and the legend persist, and Reset Settings restores them', async ({ page }) => {
    await start(page)
    await open(page)
    await expect(entry(page, 'tap').locator('input')).toBeChecked()
    await expect(entry(page, 'damage').locator('input')).not.toBeChecked()
    const plot = await chart(page).boundingBox()
    // A chart under 10 s has nothing to zoom: the buttons keep their place, hidden.
    await expect(zoomIn(page)).toBeHidden()
    await expect(zoomOut(page)).toBeHidden()
    await entry(page, 'damage').click()
    await dialog(page).locator('[data-statistics-mode-option="bars"]').check({ force: true })
    await expect(chart(page).locator('rect[data-statistics-layer="damage"]')).toHaveCount(1)
    expect(await chart(page).boundingBox()).toEqual(plot)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await open(page)
    await expect(entry(page, 'damage').locator('input')).toBeChecked()
    await expect(dialog(page).locator('[data-statistics-mode-option="bars"]')).toBeChecked()
    await page.keyboard.press('Escape')
    await page.evaluate(async () => {
        const { resetSettings } = await import('/src/settings.ts')
        resetSettings()
    })
    expect(
        await page.evaluate(() => [
            window.editorTest.settings.statisticsChartMode,
            window.editorTest.settings.statisticsCategories,
        ]),
    ).toEqual(['smooth', ['tap', 'flick', 'release']])
})

test('every entry off leaves the frame, blank figures and the plot out of the Tab order', async ({
    page,
}) => {
    await start(page)
    await open(page)
    for (const category of ['tap', 'flick', 'release']) await entry(page, category).click()
    await expect(dialog(page).locator('[data-statistics-empty]')).toHaveText(en.statistics.noNotes)
    await expect(chart(page)).toHaveAttribute('tabindex', '-1')
    await expect(dialog(page).locator('[data-statistics-figures] dd').first()).toBeHidden()
    await expect(
        dialog(page).getByRole('status').filter({ hasText: en.statistics.noNotes }),
    ).toHaveCount(1)
    await entry(page, 'trace').click()
    await expect(dialog(page).locator('[data-statistics-figures]')).toContainText('1.0')
})

test('Average shows <primary> (<all>), its bubble is shared with the critical rows, and the status line spells it out', async ({
    page,
}) => {
    await start(page)
    await open(page)
    const figure = (name: string) => dialog(page).locator(`[data-statistics-figure="${name}"]`)
    const average = figure('average').locator('button')
    // Only primary notes: one value, and a one-line bubble.
    await expect(average).toHaveText(/^\d+\.\d$/)
    const primary = (await average.textContent()) ?? ''
    await expect(average).toHaveAccessibleDescription(`Primary: ${primary}`)

    // Trace adds a secondary note: the pair, spelled out on the status line.
    await entry(page, 'trace').click()
    await expect(average).toHaveText(
        new RegExp(`^${primary.replace('.', '\\.')} \\(\\d+\\.\\d\\)$`),
    )
    const all = /\((.*)\)/.exec((await average.textContent()) ?? '')?.[1] ?? ''
    await expect(
        dialog(page)
            .getByRole('status')
            .filter({ hasText: `Average: Primary: ${primary}, All: ${all}` }),
    ).toHaveCount(1)

    // One bubble across the count rows and the figures: hover hands it over, Escape closes it.
    await row(page, 'tap').hover()
    await expect(bubble(page)).toContainText('Critical')
    await figure('average').hover()
    await expect(average).toHaveAttribute('aria-expanded', 'true')
    await expect(row(page, 'tap').locator('button')).toHaveAttribute('aria-expanded', 'false')
    await expect(bubble(page)).toHaveCount(1)
    await expect(bubble(page).locator('dt')).toHaveText(['Primary', 'All'])
    await expect(bubble(page).locator('dd')).toHaveText([primary, all])
    await average.click()
    await page.keyboard.press('Escape')
    await expect(bubble(page)).toHaveCount(0)
    await expect(dialog(page)).toBeVisible()
})

test('the readout follows the mouse on the label line, and the plot stays in place', async ({
    page,
}) => {
    await start(page)
    await open(page)
    const plot = await chart(page).boundingBox()
    if (!plot) throw new Error('No plot')
    const readout = dialog(page).locator('[data-statistics-readout]')
    await expect(readout).toHaveText('')
    for (const mode of ['smooth', 'bars', 'rolling']) {
        await dialog(page).locator(`[data-statistics-mode-option="${mode}"]`).check({ force: true })
        await page.mouse.move(plot.x + plot.width * 0.2, plot.y + plot.height / 2)
        await expect(readout).not.toHaveText('')
        expect(await chart(page).boundingBox()).toEqual(plot)
    }
    await page.mouse.move(5, 5)
    await expect(readout).toHaveText('')
})

test('a click on the plot does not pin the readout: leaving clears it', async ({ page }) => {
    await start(page)
    await open(page)
    const plot = await chart(page).boundingBox()
    if (!plot) throw new Error('No plot')
    await page.mouse.click(plot.x + plot.width / 3, plot.y + plot.height / 2)
    const readout = dialog(page).locator('[data-statistics-readout]')
    await expect(readout).not.toHaveText('')
    await page.mouse.move(5, 5)
    await expect(readout).toHaveText('')
    await expect(dialog(page).locator('.stats-dot, .stats-cross')).toHaveCount(0)
    await expect(entry(page, 'tap').locator('.stats-entry-value')).toHaveText('')
})

test('a key after a click pins the readout to the keyboard: leaving keeps it, the next key moves on', async ({
    page,
}) => {
    await start(page)
    await open(page)
    const plot = await chart(page).boundingBox()
    if (!plot) throw new Error('No plot')
    await page.mouse.click(plot.x + plot.width / 3, plot.y + plot.height / 2)
    await expect(chart(page)).toBeFocused()
    await expect(dialog(page).locator('.stats-plot-focus')).toHaveCount(0)
    const now = async () => Number(await chart(page).getAttribute('aria-valuenow'))
    const clicked = await now()
    await page.keyboard.press('ArrowRight')
    await expect(dialog(page).locator('.stats-plot-focus')).toHaveCount(1)
    await expect.poll(now).toBeCloseTo(clicked + 1, 3)
    await page.mouse.move(5, 5)
    const readout = dialog(page).locator('[data-statistics-readout]')
    await expect(readout).not.toHaveText('')
    await page.keyboard.press('ArrowRight')
    await expect.poll(now).toBeCloseTo(clicked + 2, 3)
    await expect(readout).not.toHaveText('')
})

test('keyboard focus starts the readout at the start, the arrows move it, and Tab reaches the legend', async ({
    page,
}) => {
    await start(page)
    await open(page)
    await dialog(page).locator('[data-statistics-mode-option="smooth"]').focus()
    await page.keyboard.press('Tab')
    await expect(chart(page)).toBeFocused()
    await expect(chart(page)).toHaveAttribute('aria-valuenow', '0')
    await expect(chart(page)).toHaveAttribute('aria-valuetext', /^[\d.]+ at 00:00\.000, Tap: /)
    await page.keyboard.press('ArrowRight')
    await expect(chart(page)).toHaveAttribute('aria-valuenow', '1')
    await page.keyboard.press('Tab')
    // Beside the plot the legend reads from the top of the stack.
    await expect(entry(page, 'damage').locator('input')).toBeFocused()
    await page.keyboard.press('Space')
    await expect(entry(page, 'damage').locator('input')).toBeChecked()
    await expect(entry(page, 'damage').locator('input')).toBeFocused()
})

test('a pen press pins the readout, as a touch does', async ({ page }) => {
    await start(page)
    await open(page)
    const plot = await chart(page).boundingBox()
    if (!plot) throw new Error('No plot')
    await chart(page).dispatchEvent('pointerdown', {
        pointerType: 'pen',
        clientX: plot.x + plot.width / 3,
        clientY: plot.y + plot.height / 2,
        buttons: 1,
    })
    await chart(page).dispatchEvent('pointerleave', { pointerType: 'pen' })
    await expect(dialog(page).locator('[data-statistics-readout]')).not.toHaveText('')
})

// A minute of taps at 120 BPM, one a beat, with a burst of sixteenths at beat 40.
const startLong = async (page: Page, viewport = { width: 1440, height: 600 }) => {
    await page.setViewportSize(viewport)
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        const { fixtures, show } = window.editorTest
        const chart = structuredClone(fixtures.interaction)
        const [base] = chart.slides[0] ?? []
        if (!base) throw new Error('No note')
        const beats = [
            ...Array.from({ length: 120 }, (_, i) => i),
            ...Array.from({ length: 16 }, (_, i) => 40.125 + i / 4),
        ]
        chart.slides = beats.map((beat) => [{ ...base, beat }])
        show(chart)
    })
}
const announced = (page: Page) => dialog(page).locator('span.sr-only[role="status"]')
/** The time the readout shows with the mouse at a fraction of the plot's width. */
const timeAt = async (page: Page, fraction: number) => {
    const plot = await chart(page).boundingBox()
    if (!plot) throw new Error('No plot')
    await page.mouse.move(plot.x + 1 + fraction * (plot.width - 2), plot.y + plot.height / 2)
    return Number(await chart(page).getAttribute('aria-valuenow'))
}
const width = async (page: Page) => (await timeAt(page, 1)) - (await timeAt(page, 0))

test('Ctrl+wheel zooms the plot, the plain wheel scrolls the dialog, a drag pans, and the keys and Zoom Out return to the whole chart', async ({
    page,
}) => {
    await startLong(page)
    await open(page)
    // The page's timers and frames advance only when the test says, so a wheel run ends on cue.
    await page.clock.install()
    const settle = () => page.clock.runFor(250)
    await page.evaluate(() => {
        addEventListener('wheel', (event) => {
            ;(window as unknown as { prevented: boolean }).prevented = event.defaultPrevented
        })
    })
    const prevented = () =>
        page.evaluate(() => (window as unknown as { prevented: boolean }).prevented)
    await expect(zoomOut(page)).toHaveAttribute('aria-disabled', 'true')
    const end = Number(await chart(page).getAttribute('aria-valuemax'))
    expect(await timeAt(page, 1)).toBeCloseTo(end, 0)

    // Ctrl+wheel zooms at the pointer.
    const middle = await timeAt(page, 0.5)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    expect(await prevented()).toBe(true)
    await settle()
    await expect(zoomOut(page)).toHaveAttribute('aria-disabled', 'false')
    expect(await timeAt(page, 0.5)).toBeCloseTo(middle, 1)
    const left = await timeAt(page, 0)
    expect(left).toBeGreaterThan(5)
    await expect(chart(page)).toHaveClass(/zoomed/)

    // The plain wheel scrolls the dialog and leaves the view.
    const body = dialog(page).locator('.stats-body')
    await timeAt(page, 0.5)
    await page.mouse.wheel(0, 60)
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    expect(await prevented()).toBe(false)
    expect(await timeAt(page, 0)).toBeCloseTo(left, 2)

    // A drag pans: the content follows the pointer.
    const plot = await chart(page).boundingBox()
    if (!plot) throw new Error('No plot')
    const y = plot.y + plot.height / 2
    await page.mouse.move(plot.x + plot.width * 0.6, y)
    await page.mouse.down()
    await page.mouse.move(plot.x + plot.width * 0.4, y, { steps: 5 })
    await page.mouse.up()
    const panned = await timeAt(page, 0)
    expect(panned).toBeGreaterThan(left + 1)

    // The keyboard's readout stays where the slider says it is when a pan leaves it behind.
    await chart(page).focus()
    await page.keyboard.press('Home')
    await chart(page).dispatchEvent('wheel', { deltaX: 2000, deltaY: 0, cancelable: true })
    await settle()
    const now = Number(await chart(page).getAttribute('aria-valuenow'))
    expect(now).toBeGreaterThan(10)
    const said = `${String(Math.floor(now / 60)).padStart(2, '0')}:${(now % 60).toFixed(3).padStart(6, '0')}`
    await expect(chart(page)).toHaveAttribute('aria-valuetext', new RegExp(` at ${said}, `))

    // A click chooses where Zoom In zooms: the clicked time keeps its place.
    const span = await width(page)
    await page.mouse.click(plot.x + plot.width * 0.3, y)
    const clicked = Number(await chart(page).getAttribute('aria-valuenow'))
    await zoomIn(page).click()
    await expect.poll(() => width(page)).toBeLessThan(span * 0.6)
    expect(await timeAt(page, 0.3)).toBeCloseTo(clicked, 1)

    // The keys: - zooms out, 0 shows the whole chart and says its span, once.
    await chart(page).focus()
    const before = await width(page)
    await page.keyboard.press('-')
    await expect.poll(() => width(page)).toBeGreaterThan(before * 1.5)
    await page.keyboard.press('0')
    await expect(zoomOut(page)).toHaveAttribute('aria-disabled', 'true')
    await expect(announced(page)).toHaveText(/^00:00\.000–01:0\d\.\d{3}$/)
    await announced(page).evaluate((element) => {
        const target = window as unknown as { changes: number }
        target.changes = 0
        new MutationObserver(() => target.changes++).observe(element, {
            childList: true,
            characterData: true,
            subtree: true,
        })
    })
    await page.keyboard.press('0')
    await settle()
    expect(await page.evaluate(() => (window as unknown as { changes: number }).changes)).toBe(0)

    // A zoom key that arrives before a queued wheel frame wins: the whole chart stays.
    await page.keyboard.press('+')
    await expect(zoomOut(page)).toHaveAttribute('aria-disabled', 'false')
    await chart(page).evaluate((element) => {
        const box = element.getBoundingClientRect()
        element.dispatchEvent(
            new WheelEvent('wheel', {
                ctrlKey: true,
                deltaY: -100,
                clientX: box.left + box.width / 2,
                clientY: box.top + box.height / 2,
                bubbles: true,
                cancelable: true,
            }),
        )
        element.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }))
    })
    await settle()
    await expect(zoomOut(page)).toHaveAttribute('aria-disabled', 'true')
    await expect(announced(page)).toHaveText(/^00:00\.000–01:0\d\.\d{3}$/)
    expect(await timeAt(page, 1)).toBeCloseTo(end, 0)

    // Zoom Out keeps focus at the whole chart, and Enter there does nothing.
    await chart(page).focus()
    await page.keyboard.press('+')
    await zoomOut(page).focus()
    await page.keyboard.press('Enter')
    await expect(zoomOut(page)).toHaveAttribute('aria-disabled', 'true')
    await expect(zoomOut(page)).toBeFocused()
    const last = await announced(page).textContent()
    await page.keyboard.press('Enter')
    await expect(zoomOut(page)).toBeFocused()
    await expect(announced(page)).toHaveText(last ?? '')
})

test('a tap pins the readout, Zoom In zooms on it, and two touches pinch', async ({ page }) => {
    await startLong(page, { width: 390, height: 844 })
    await open(page)
    const plot = await chart(page).boundingBox()
    if (!plot) throw new Error('No plot')
    const y = plot.y + plot.height / 2
    const touch = (type: string, id: number, fraction: number) =>
        chart(page).dispatchEvent(type, {
            pointerType: 'touch',
            pointerId: id,
            isPrimary: id === 1,
            clientX: plot.x + fraction * plot.width,
            clientY: y,
            buttons: type === 'pointerup' ? 0 : 1,
        })
    const now = async () => Number(await chart(page).getAttribute('aria-valuenow'))
    await touch('pointerdown', 1, 0.3)
    await touch('pointerup', 1, 0.3)
    const tapped = await now()
    await zoomIn(page).dispatchEvent('click')
    await expect(zoomOut(page)).toHaveAttribute('aria-disabled', 'false')
    await touch('pointerdown', 1, 0.3)
    await touch('pointerup', 1, 0.3)
    expect(await now()).toBeCloseTo(tapped, 1)

    /** The view's ends, read by pen presses at the plot's edges. */
    const ends = async () => {
        const out: number[] = []
        for (const fraction of [0, 1]) {
            await chart(page).dispatchEvent('pointerdown', {
                pointerType: 'pen',
                clientX: plot.x + fraction * plot.width,
                clientY: y,
                buttons: 1,
            })
            out.push(await now())
            await chart(page).dispatchEvent('pointerup', { pointerType: 'pen' })
        }
        return out
    }
    const [a0 = 0, a1 = 0] = await ends()
    await touch('pointerdown', 1, 0.4)
    await touch('pointerdown', 2, 0.6)
    // The second finger clears the readout.
    await expect(dialog(page).locator('[data-statistics-readout]')).toHaveText('')
    await touch('pointermove', 1, 0.2)
    await touch('pointermove', 2, 0.8)
    await touch('pointerup', 1, 0.2)
    await touch('pointerup', 2, 0.8)
    await expect
        .poll(async () => {
            const [b0 = 0, b1 = 0] = await ends()
            return (b1 - b0) / (a1 - a0)
        })
        .toBeCloseTo(1 / 3, 1)
})

const copyLines = [
    'Combo: 8',
    'Tap: 1 (1 critical)',
    'Flick: 1 (0 critical)',
    'Release: 1 (0 critical)',
    'Trace: 1 (0 critical)',
    'Trace Flick: 0',
    'Tick: 0',
    'Hidden Tick: 3',
    'Damage Note: 1',
    'Damage Tick: 0',
    'Fake Note: 1',
    'Notes per Second: Tap, Flick, Release',
    'Average: 1.5',
    'Median: 1',
    '90th Percentile: 2',
    '99th Percentile: 2',
    'First Combo Note: 00:00.000',
    'Last Combo Note: 00:01.500',
    'Last Note: 00:02.000',
]

test('Copy Text copies the figures and says so', async ({ page }) => {
    await start(page)
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText: (text: string) => {
                    ;(window as unknown as { copied: string }).copied = text
                    return Promise.resolve()
                },
            },
        })
    })
    await open(page)
    await dialog(page).locator('[data-statistics-copy]').click()
    await expect(page.locator('.notification', { hasText: en.statistics.copiedText })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(
        copyLines.join('\n'),
    )
})

test('when copying fails, the line says so and the fallback field was inside the dialog', async ({
    page,
}) => {
    await start(page)
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: () => Promise.reject(new Error('refused')) },
        })
        document.execCommand = () => {
            const field = document.activeElement
            ;(window as unknown as { inDialog: boolean }).inDialog =
                field instanceof HTMLTextAreaElement && !!field.closest('dialog')
            return false
        }
    })
    await open(page)
    await dialog(page).locator('[data-statistics-copy]').click()
    await expect(dialog(page).locator('[data-statistics-copy-failed]')).toHaveText(
        en.statistics.notCopiedText,
    )
    expect(await page.evaluate(() => (window as unknown as { inDialog: boolean }).inDialog)).toBe(
        true,
    )
})

test('the toolbar step adds Statistics to the old first group once, and a removal stays', async ({
    page,
}) => {
    const former = ['utilities', 'properties', 'reset', 'exportLevel', 'saveAs', 'save', 'open']
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript((former) => {
        if (sessionStorage.getItem('seeded')) return
        sessionStorage.setItem('seeded', '1')
        const prefix = 'sonolus-next-sekai-editor.'
        localStorage.setItem(`${prefix}toolbar`, JSON.stringify([former, ['play']]))
        // The earlier steps are done, so only this one is seen.
        for (const flag of [
            'toolbarEditorLayoutMigrated',
            'toolbarExportMigrated',
            'toolbarPreviewAssetsMigrated',
            'toolbarSessionRestoreMigrated',
            'toolbarMinimapMigrated',
        ])
            localStorage.setItem(`${prefix}${flag}`, 'true')
        localStorage.removeItem(`${prefix}toolbarStatisticsMigrated`)
        // The later Export Video step would match the new first group too.
        localStorage.setItem(`${prefix}toolbarExportVideoMigrated`, 'true')
    }, former)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    const toolbar = () => page.evaluate(() => window.editorTest.settings.toolbar)
    const withStatistics = ['utilities', 'statistics', ...former.slice(1)]
    expect(await toolbar()).toEqual([withStatistics, ['play']])
    expect(
        await page.evaluate(() => [
            localStorage.getItem('sonolus-next-sekai-editor.toolbarStatisticsMigrated'),
            JSON.parse(localStorage.getItem('sonolus-next-sekai-editor.toolbar') ?? '[]')[0],
        ]),
    ).toEqual(['true', withStatistics])

    // Removing it afterwards is a customisation, kept across a reload.
    await page.evaluate(() => {
        const { settings } = window.editorTest
        settings.toolbar = settings.toolbar.map((group) =>
            group.filter((name) => name !== 'statistics'),
        )
    })
    await page.reload()
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    expect((await toolbar())[0]).toEqual(former)
})

test('at an absurd BPM the dialog opens with the counts and no chart', async ({ page }) => {
    await start(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.evaluate(() => {
        const { fixtures, show } = window.editorTest
        const chart = structuredClone(fixtures.interaction)
        chart.bpms = [{ beat: 0, bpm: 1e-310 }]
        show(chart)
    })
    await open(page)
    await expect(dialog(page).locator('[data-statistics-combo]')).toHaveText('4')
    await expect(dialog(page).locator('[data-statistics-figures]')).toHaveCount(0)
    await expect(chart(page).locator('svg')).toHaveCount(0)
    await expect(dialog(page).locator('[data-statistics-times]')).toHaveCount(0)
    expect(errors).toEqual([])
})
