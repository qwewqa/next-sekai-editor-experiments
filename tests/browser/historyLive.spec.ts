import { expect, test, type Page } from '@playwright/test'
import { errorsFail, flush, holdWorker, load, noErrors, release, timeline } from './historyJourney'

// Live entries while the Timeline is scrolled (D2 plan §3.3, F5 and F6): the list stays where the
// reader put it while entries arrive, and a burst of more than one page between two refreshes
// keeps the older pages already loaded (DEF-3).

test.beforeEach(async ({ page }) => {
    errorsFail(page)
    await load(page)
})

test.afterEach(({ page }) => {
    noErrors(page)
})

/** Pushes `count` steps with titles "Syn <n>", the way a long session would have made them. */
const pushSteps = (page: Page, count: number) =>
    page.evaluate((count) => {
        const { history, historySteps } = window.editorTest
        for (let i = 1; i <= count; i++) {
            const life = history.state.value.initialLife
            history.pushState(historySteps.futureInitialLife(life, life + 1, `Syn ${i}`), {
                ...history.state.value,
                initialLife: life + 1,
            })
        }
    }, count)

/** Opens the History tab on the right dock: the Timeline beside the chart, so keys still reach it. */
const openPanel = async (page: Page) => {
    await page
        .locator('[data-workspace-dock="right"]')
        .getByRole('tab', { name: 'History', exact: false })
        .click()
    await expect(page.locator('[data-history-surface="panel"]')).toBeVisible()
    await expect(timeline(page, 'panel').getByRole('row', { name: /^Now/ })).toBeVisible()
}

const source = (page: Page) =>
    page.evaluate(async () => {
        const source = await window.editorTest.appImport<
            typeof import('../../src/editor/history/source')
        >('/src/editor/history/source.ts')
        const entries = source.entries.value
        return {
            loaded: entries.length,
            undos: entries.filter((entry) => entry.kind === 'undo').length,
            more: source.canLoadMore.value,
            loadingMore: source.loadingMore.value,
        }
    })

/** Scrolls the panel's Timeline to its end until every page is loaded. */
const loadEverything = async (page: Page) => {
    const list = timeline(page, 'panel')
    await expect
        .poll(async () => {
            await list.evaluate((element) => {
                element.scrollTop = element.scrollHeight
            })
            return (await source(page)).more
        })
        .toBe(false)
    await expect.poll(async () => (await source(page)).loadingMore).toBe(false)
}

const rowCount = (page: Page) =>
    timeline(page, 'panel')
        .getAttribute('aria-rowcount')
        .then((value) => Number(value))

/** The top of the row titled `title` below the list's own top, or undefined when it is not rendered. */
const topOf = (page: Page, title: string) =>
    timeline(page, 'panel').evaluate((list, title) => {
        const match = [...list.querySelectorAll('[data-history-row]')].find(
            (row) =>
                (row.querySelector('[data-history-group-action]')?.textContent ?? '').trim() ===
                title,
        )
        return match ? match.getBoundingClientRect().top - list.getBoundingClientRect().top : null
    }, title)

test('F6: a burst of more than one page between refreshes keeps the older pages and the position', async ({
    page,
}) => {
    await pushSteps(page, 250)
    await flush(page)
    await openPanel(page)
    await loadEverything(page)
    const before = await rowCount(page)
    const loadedBefore = (await source(page)).loaded
    expect(before).toBeGreaterThan(250)

    // A row deep in the older pages, with the pointer on it.
    const list = timeline(page, 'panel')
    const title = await list.evaluate((element) => {
        const rows = [...element.querySelectorAll('[data-history-row]')]
            .map((row) => (row.querySelector('[data-history-group-action]')?.textContent ?? '').trim())
            .filter((text) => /^Syn \d+$/.test(text))
        return rows[Math.floor(rows.length / 2)]!
    })
    expect(Number(title.slice(4))).toBeLessThan(100)
    const top = await topOf(page, title)
    expect(top).not.toBeNull()
    const box = (await list.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + top! + 10)

    // The Timeline's reads wait while 130 Undos run back to back (the chart focused, so the key
    // reaches the command) and are all stored: the next read finds more than a page of new entries.
    const hold = await holdWorker(page, 'readTimeline')
    try {
        await page.locator('canvas.editor-chart').focus()
        for (let i = 0; i < 130; i++) await page.keyboard.press('z')
        await flush(page)
        await hold.reached()
    } finally {
        await release(page)
    }
    await expect.poll(async () => (await source(page)).undos).toBe(130)
    await expect.poll(async () => (await source(page)).loadingMore).toBe(false)
    // Nothing loaded was dropped: the 130 Undos came on top of every entry the list held.
    expect((await source(page)).loaded).toBe(loadedBefore + 130)
    // Every older page is still loaded: the count is known (not -1) and has grown by the group row.
    await expect.poll(() => rowCount(page)).toBeGreaterThanOrEqual(before + 1)
    const after = await topOf(page, title)
    expect(after).not.toBeNull()
    expect(Math.abs(after! - top!)).toBeLessThanOrEqual(1)
})
