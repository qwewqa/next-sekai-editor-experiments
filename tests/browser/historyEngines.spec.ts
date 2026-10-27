import { expect, test, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import {
    chartOf,
    errorsFail,
    flush,
    holdWorker,
    liveOf,
    load,
    noErrors,
    openHistory,
    rowTitles,
    sampleClock,
    timeline,
    timelineRead,
} from './historyJourney'
import { skipWhereTheEditorCannotStart } from './webkitSupport'

// A WebKit build without OffscreenCanvas (Playwright's on Windows) cannot start the editor.
skipWhereTheEditorCannotStart()

// The History dialog, its focus and its scrolling in each engine. The same
// specs run in Chromium with the rest, and in Firefox and WebKit through the compatibility
// config's `firefox-history` and `webkit-history` projects. They make their entries through the
// undo stack (future-extension steps are never grouped, so each is a row), and drive everything
// else with keys and the pointer.

test.afterEach(({ page }) => noErrors(page))

/** Pushes `count` separate rows, titled "Life 1" and on. */
const synthesise = (page: Page, count: number, from = 1) =>
    page.evaluate(
        ({ count, from }) => {
            const { history, historySteps } = window.editorTest
            for (let i = 0; i < count; i++)
                history.pushState(
                    historySteps.futureInitialLife(
                        history.state.value.initialLife,
                        history.state.value.initialLife + 1,
                        `Life ${from + i}`,
                    ),
                    { ...history.state.value, initialLife: history.state.value.initialLife + 1 },
                )
        },
        { count, from },
    )

const rovingEntries = (page: Page) =>
    timeline(page).locator('[data-history-row][tabindex="0"], [data-history-row] [tabindex="0"]')

const titleOf = (page: Page) =>
    page.evaluate(() => {
        const active = document.activeElement
        const row = active?.closest('[data-history-row]')
        const text = row?.matches('.timeline-now')
            ? row.querySelector('.timeline-entry-text')
            : row?.querySelector('[data-history-group-action]')
        return (text?.textContent ?? '').replace(/\s+/g, ' ').trim()
    })

/** The gap row's text for `count` newer steps, from the catalogue. */
const newerSteps = (count: number) =>
    en.history.newerSteps.split('|')[count === 1 ? 0 : 1]!.replace('{0}', String(count))

const lifeOf = async (page: Page) => (await chartOf(page)).initialLife
const liveLifeOf = async (page: Page) => (await liveOf(page)).initialLife

// E1: closing History gives focus back to its opener (the native dialog's return differs by engine).
test.describe('focus returns to the opener', () => {
    // The sheet is the usual History; a landscape phone has no room for it, so History is the
    // compact dialog there. Both give focus back to the control that opened them, when that is
    // still on screen, and to the chart otherwise.
    const presentations = [
        { name: 'sheet', viewport: { width: 1600, height: 1000 }, presentation: 'sheet' },
        { name: 'compact dialog', viewport: { width: 568, height: 320 }, presentation: 'compact' },
    ] as const

    const isChart = (page: Page) =>
        page.evaluate(() => document.activeElement?.matches('.chart-pane') === true)

    const closedBy = async (page: Page, presentation: string) => {
        await expect(page.locator(`[data-history-presentation="${presentation}"]`)).toBeVisible()
        await expect(timeline(page).getByRole('row', { name: /^Now/ })).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(timeline(page)).toHaveCount(0)
    }

    for (const { name, viewport, presentation } of presentations) {
        test(`a ${name} gives focus back to the status label that opened it`, async ({ page }) => {
            errorsFail(page)
            await load(page, { viewport })
            await synthesise(page, 4)
            const opener = page.locator('[data-status-label]')
            await opener.focus()
            await expect(opener).toBeFocused()
            await page.keyboard.press('Shift+H')
            await closedBy(page, presentation)
            await expect(opener).toBeFocused()
            // Keys still reach the editor from there.
            await page.keyboard.press('Shift+H')
            await expect(timeline(page)).toBeVisible()
        })

        test(`a ${name} opened with nothing focused gives focus to the chart`, async ({ page }) => {
            errorsFail(page)
            await load(page, { viewport })
            await synthesise(page, 4)
            await page.evaluate(() => {
                const active = document.activeElement
                if (active instanceof HTMLElement && active !== document.body) active.blur()
            })
            await page.keyboard.press('Shift+H')
            await closedBy(page, presentation)
            await expect.poll(() => isChart(page)).toBe(true)
        })

        test(`a ${name} opened from a notice gives focus back to its button, while it is shown`, async ({
            page,
        }) => {
            errorsFail(page)
            await load(page, { viewport })
            // With the History tab off, the notice's Open History runs the dialog.
            await page.evaluate(() => {
                window.editorTest.settings.historyPosition = 'disabled'
            })
            // One edit, undone: a second Undo has nothing to undo and offers History.
            await synthesise(page, 1)
            await page.keyboard.press('z')
            await expect.poll(() => liveLifeOf(page)).toBe((await liveOf(page)).initialLife)
            await page.keyboard.press('z')
            const action = page.getByRole('button', { name: en.notice.openHistory, exact: true })
            await expect(action).toBeVisible()
            await action.click()
            await closedBy(page, presentation)
            await expect(action).toBeFocused()
        })

        test(`a ${name} gives focus to the chart when its opener has gone`, async ({ page }) => {
            errorsFail(page)
            await load(page, { viewport })
            await synthesise(page, 4)
            await page.evaluate(() => {
                const opener = document.body.appendChild(document.createElement('button'))
                opener.id = 'opener'
                opener.textContent = 'Opener'
                opener.focus()
            })
            await expect(page.locator('#opener')).toBeFocused()
            await page.keyboard.press('Shift+H')
            await expect(
                page.locator(`[data-history-presentation="${presentation}"]`),
            ).toBeVisible()
            await page.evaluate(() => document.getElementById('opener')?.remove())
            await closedBy(page, presentation)
            await expect.poll(() => isChart(page)).toBe(true)
        })

        test(`a ${name} opened from the toolbar tool with the keyboard gives focus back to its group`, async ({
            page,
        }) => {
            errorsFail(page)
            await load(page, { viewport })
            await synthesise(page, 4)
            // The tool sits in the Undo group's flyout, which opens when the face is hovered.
            const face = page.locator('[data-editor-toolbar] button[title="Undo"]')
            await face.hover()
            await page.locator('[data-editor-toolbar] button[title="History"]').focus()
            await page.keyboard.press('Enter')
            await closedBy(page, presentation)
            // The flyout is closed again, so its tool is not on screen: the group's face is.
            await expect(face).toBeFocused()
        })
    }

    test('Step Details returns it to the row that opened it, and to the strip date', async ({
        page,
    }) => {
        errorsFail(page)
        await load(page, { viewport: { width: 568, height: 320 } })
        await synthesise(page, 4)
        await openHistory(page)
        await page.keyboard.press('ArrowDown')
        const row = timeline(page).locator('[data-history-row]:focus')
        await expect(row).toHaveCount(1)
        const title = (await row.locator('[data-history-group-action]').textContent())?.trim()
        // The row's menu, from the keyboard, then its Details item.
        await page.keyboard.press('ContextMenu')
        await page.getByRole('menuitem', { name: en.history.details.action, exact: true }).click()
        const details = page.getByRole('dialog', { name: en.history.details.title, exact: true })
        await expect(details).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(details).toHaveCount(0)
        await expect(timeline(page).locator('[data-history-row]:focus')).toHaveCount(1)
        await expect
            .poll(() =>
                timeline(page)
                    .locator('[data-history-row]:focus [data-history-group-action]')
                    .textContent(),
            )
            .toContain(title)
    })

    test('Step Details opened from the strip returns focus to the date button', async ({
        page,
    }) => {
        errorsFail(page)
        await load(page)
        await synthesise(page, 4)
        await openHistory(page)
        await page.keyboard.press('ArrowDown')
        await expect(page.locator('[data-peek-bar]')).toBeVisible()
        const date = page.locator('[data-peek-details]')
        // It stays hidden, and takes no focus, until the step's change is read.
        await expect(date).toBeVisible()
        await date.focus()
        await expect(date).toBeFocused()
        await page.keyboard.press('Enter')
        const details = page.getByRole('dialog', { name: en.history.details.title, exact: true })
        await expect(details).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(details).toHaveCount(0)
        await expect(date).toBeFocused()
        // The sheet and the peek are as they were.
        await expect(timeline(page)).toBeVisible()
        await expect(page.locator('[data-peek-bar]')).toBeVisible()
    })
})

test('the Timeline keeps one roving entry through Home, End and Tab', async ({ page }) => {
    errorsFail(page)
    await load(page)
    await synthesise(page, 6)
    await openHistory(page)
    await expect(rovingEntries(page)).toHaveCount(1)
    await page.keyboard.press('End')
    await expect(rovingEntries(page)).toHaveCount(1)
    await expect.poll(() => titleOf(page)).toBe(en.history.operation.importedLevel)
    await page.keyboard.press('Home')
    await expect(rovingEntries(page)).toHaveCount(1)
    await expect.poll(() => titleOf(page)).toMatch(/^Now/)
    // Move to a row in the middle, then out and back with Tab.
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
    await expect.poll(() => titleOf(page)).toBe('Life 4')
    await page.keyboard.press('Shift+Tab')
    await expect(timeline(page).locator(':focus')).toHaveCount(0)
    await expect(rovingEntries(page)).toHaveCount(1)
    await page.keyboard.press('Tab')
    await expect(timeline(page).locator(':focus')).toHaveCount(1)
    await expect.poll(() => titleOf(page)).toBe('Life 4')
    await expect(rovingEntries(page)).toHaveCount(1)
})

test('keys peek, restore and undo with the right chart at each step', async ({ page }) => {
    errorsFail(page)
    await load(page)
    const base = (await liveOf(page)).initialLife
    await synthesise(page, 4)
    expect(await liveLifeOf(page)).toBe(base + 4)
    await openHistory(page)
    // Down twice: the newest row, then the one before. The peek shows its chart.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('[data-peek-bar]')).toBeVisible()
    await expect.poll(() => lifeOf(page)).toBe(base + 3)
    expect(await liveLifeOf(page)).toBe(base + 4)
    // Enter restores it: the chart is that state, live.
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-peek-bar]')).toHaveCount(0)
    await expect.poll(() => liveLifeOf(page)).toBe(base + 3)
    expect(await lifeOf(page)).toBe(base + 3)
    // Undo returns to the state before the Restore, and Redo to the restored one.
    await page.keyboard.press('Escape')
    await expect(timeline(page)).toHaveCount(0)
    await page.keyboard.press('z')
    await expect.poll(() => liveLifeOf(page)).toBe(base + 4)
    await page.keyboard.press('y')
    await expect.poll(() => liveLifeOf(page)).toBe(base + 3)
    expect(await lifeOf(page)).toBe(base + 3)
})

/** A row's top edge, by its title, in the page. */
const topOf = (page: Page, title: string) =>
    timeline(page)
        .locator('[data-history-row]')
        .filter({
            has: page
                .locator('[data-history-group-action]')
                .filter({ hasText: new RegExp(`^\\s*${title}\\s*$`) }),
        })
        .evaluate((row) => row.getBoundingClientRect().top)

/** Waits until a row's top has held still for a few frames (a smooth wheel scroll has ended). */
const stableTop = (page: Page, title: string) =>
    expect
        .poll(async () => {
            const tops: number[] = []
            for (let i = 0; i < 4; i++) {
                tops.push(await topOf(page, title))
                await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
            }
            return Math.max(...tops) - Math.min(...tops)
        })
        .toBeLessThanOrEqual(0.5)

test('a live entry arriving keeps the row under the pointer where it was', async ({ page }) => {
    test.slow()
    errorsFail(page)
    await load(page)
    await synthesise(page, 80)
    await openHistory(page, { focused: false })
    const list = timeline(page)
    // The wheel's distance differs between engines, so the list is put at its place directly.
    await list.evaluate((element) => {
        element.scrollTop = 44 * 40
    })
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(44 * 30)
    // A row on screen once the window has followed the scroll: the first one clear of the top.
    const shown = () =>
        list.evaluate((element) => {
            const area = element.getBoundingClientRect()
            for (const row of element.querySelectorAll<HTMLElement>('[data-history-row]')) {
                const rect = row.getBoundingClientRect()
                if (rect.top >= area.top + 60 && rect.bottom <= area.bottom)
                    return (
                        row.querySelector('[data-history-group-action]')?.textContent?.trim() ?? ''
                    )
            }
            return ''
        })
    await expect.poll(shown).toMatch(/^Life \d+$/)
    const title = await shown()
    await stableTop(page, title)
    const before = await topOf(page, title)
    const height = await list.evaluate((element) => element.scrollHeight)
    // The new entry reaches the list through its follow, a moment later: the list grows above.
    await synthesise(page, 1, 1000)
    await expect
        .poll(() => list.evaluate((element) => element.scrollHeight))
        .toBeGreaterThan(height)
    await stableTop(page, title)
    expect(Math.abs((await topOf(page, title)) - before)).toBeLessThanOrEqual(1)
})

test('an arrow key moves focus on when the focused row has scrolled out of the rendered rows', async ({
    page,
}) => {
    errorsFail(page)
    await load(page)
    await synthesise(page, 80)
    await flush(page)
    await openHistory(page)
    await timelineRead(page)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => titleOf(page)).toBe('Life 79')
    // The list scrolls far from the focused row, which stays rendered as the cursor. The row after
    // it is not rendered.
    const list = timeline(page)
    await list.evaluate((element) => {
        element.scrollTop = 44 * 40
    })
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(44 * 30)
    await expect.poll(async () => (await rowTitles(page)).includes('Life 78')).toBe(false)
    await expect.poll(async () => (await rowTitles(page)).includes('Life 79')).toBe(true)
    // The cursor moves to a row that is not rendered, and the focused row leaves the rendered rows
    // at the same time. Focus follows, and the next key still reaches the list.
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => titleOf(page)).toBe('Life 78')
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => titleOf(page)).toBe('Life 77')
})

test('Go To an older day shows its rows, with a gap row that fills without a jump', async ({
    browser,
}) => {
    test.slow()
    const context = await browser.newContext({
        timezoneId: 'UTC',
        viewport: { width: 1600, height: 1000 },
    })
    const clock = await sampleClock(context, Date.parse('2026-06-08T12:00:00Z'))
    const page = await context.newPage()
    clock.track(page)
    try {
        errorsFail(page)
        await load(page)
        // Three days: ten rows, a hundred and ten, then ten. A jump to the first day reads a page
        // of a hundred entries above its target, so twenty rows lie between that and Now.
        await synthesise(page, 10, 1)
        await clock.pass(24 * 3_600_000)
        await synthesise(page, 110, 11)
        await clock.pass(24 * 3_600_000)
        await synthesise(page, 10, 121)
        await flush(page)
        await openHistory(page, { focused: false })
        await page.locator('[data-history-focus="goto"]').click()
        const days = page.locator('[data-goto-list] [data-goto-item="day"]')
        await expect(days).toHaveCount(3)
        await days.nth(2).click()
        const list = timeline(page)
        // The oldest day's rows show.
        await expect(
            list.locator('[data-history-group-action]').filter({ hasText: /^\s*Life 10\s*$/ }),
        ).toBeVisible()
        // The window holds the hundred rows above the target; the twenty newer than those are one
        // gap row at the very top, under Now.
        const hold = await holdWorker(page, 'readTimeline')
        try {
            await list.evaluate((element) => {
                element.scrollTop = 0
            })
            await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0)
            const gap = list.locator('[data-history-gap]')
            await expect(gap).toHaveText(newerSteps(20))
            // Its load starts as it shows. The row under it is the one to watch.
            await hold.reached()
            await stableTop(page, 'Life 110')
            const before = await topOf(page, 'Life 110')
            await hold.release()
            // The rows load into the gap, and the row being read does not move.
            await expect(gap).toHaveCount(0)
            await stableTop(page, 'Life 110')
            expect(Math.abs((await topOf(page, 'Life 110')) - before)).toBeLessThanOrEqual(1)
            // The twenty rows arrived above the view: the list scrolled to keep it, as a user would.
            expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
        } finally {
            await hold.release().catch(() => undefined)
        }
    } finally {
        await context.close()
    }
})
