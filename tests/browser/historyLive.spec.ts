import { expect, test, type Page } from '@playwright/test'
import {
    chartOf,
    errorsFail,
    flush,
    holdWorker,
    liveOf,
    load,
    noErrors,
    notice,
    peekRow,
    release,
    row,
    timeline,
} from './historyJourney'
import { submitSave } from './saveFlows'

// Live entries while the Timeline is scrolled (D2 plan §3.3, F5 and F6): the list stays where the
// reader put it while entries arrive, and a burst of more than one page between two refreshes
// keeps the older pages already loaded (DEF-3).

test.beforeEach(({ page }) => {
    errorsFail(page)
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
    await load(page)
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
            .map((row) =>
                (row.querySelector('[data-history-group-action]')?.textContent ?? '').trim(),
            )
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
        await leaveList(page)
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

const peekedKey = (page: Page) =>
    page.evaluate(async () => {
        const peek =
            await window.editorTest.appImport<typeof import('../../src/history/peek')>(
                '/src/history/peek.ts',
            )
        return peek.isPeeking.value ? (peek.peekedKey.value ?? null) : null
    })

/** Takes the focus off the Timeline, so the editor's keys reach their commands. */
const leaveList = (page: Page) =>
    page.evaluate(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement && active !== document.body) active.blur()
    })

/** Scrolls the panel's Timeline down until the row titled `title` is rendered, then onto the screen. */
const scrollToRow = async (page: Page, title: string) => {
    const list = timeline(page, 'panel')
    const target = row(page, title, 'panel')
    await expect
        .poll(async () => {
            if ((await target.count()) > 0) return true
            await list.evaluate((element) => {
                element.scrollTop += element.clientHeight
            })
            return false
        })
        .toBe(true)
    await target.scrollIntoViewIfNeeded()
}

test('F5: Save and Export while peeking leave the peek and the rows where they are', async ({
    page,
}) => {
    test.slow()
    await load(page, { platform: { fileSystemAccess: 'opfs' } })
    await pushSteps(page, 300)
    await flush(page)
    await openPanel(page)
    await scrollToRow(page, 'Syn 150')
    await peekRow(page, 'Syn 150', 'panel')
    const list = timeline(page, 'panel')
    const peeked = await peekedKey(page)
    expect(peeked).not.toBeNull()
    const shown = await chartOf(page)
    const live = await liveOf(page)
    expect(shown.initialLife).not.toBe(live.initialLife)
    const top = await topOf(page, 'Syn 150')
    expect(top).not.toBeNull()

    // Save with its shortcut, then Export: both write the live chart, and the peek stays.
    await leaveList(page)
    await page.keyboard.press('p')
    await submitSave(page, 'live')
    await expect(notice(page, 'Saved the current version to live.nxsp')).toBeVisible()
    await page.keyboard.press('Shift+P')
    const dialog = page.getByRole('dialog').filter({ hasText: 'Export Level Data' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Exports the current version.')).toBeVisible()
    await dialog.getByRole('textbox', { name: 'File Name' }).fill('live')
    await page.keyboard.press('Enter')
    await expect(notice(page, 'Exported to live.nsld')).toBeVisible()
    await expect(dialog).toHaveCount(0)

    // Both file events reach the Timeline; the peeked row has not moved, and the peek is the same.
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const source = await window.editorTest.appImport<
                    typeof import('../../src/editor/history/source')
                >('/src/editor/history/source.ts')
                return source.entries.value
                    .filter((entry) => entry.kind === 'save' || entry.kind === 'export')
                    .map((entry) => entry.kind)
            }),
        )
        .toEqual(['export', 'save'])
    await expect.poll(() => topOf(page, 'Syn 150')).not.toBeNull()
    expect(Math.abs((await topOf(page, 'Syn 150'))! - top!)).toBeLessThanOrEqual(1)
    expect(await peekedKey(page)).toBe(peeked)
    expect(await chartOf(page)).toEqual(shown)
    expect(await liveOf(page)).toEqual(live)

    // At the top, the two rows sit above everything else.
    await list.evaluate((element) => {
        element.scrollTop = 0
    })
    await expect(row(page, 'Exported live.nsld', 'panel')).toBeVisible()
    await expect(row(page, 'Saved live.nxsp', 'panel')).toBeVisible()
    await scrollToRow(page, 'Syn 150')
    const again = (await topOf(page, 'Syn 150'))!
    const box = (await list.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + again + 10)

    // A command that leaves the peek (Undo) puts its row on top; the row under the pointer stays.
    await leaveList(page)
    await page.keyboard.press('z')
    await expect.poll(() => peekedKey(page)).toBeNull()
    await expect(notice(page, 'Undid')).toBeVisible()
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const source = await window.editorTest.appImport<
                    typeof import('../../src/editor/history/source')
                >('/src/editor/history/source.ts')
                return source.entries.value[0]?.kind
            }),
        )
        .toBe('undo')
    await expect.poll(() => topOf(page, 'Syn 150')).not.toBeNull()
    expect(Math.abs((await topOf(page, 'Syn 150'))! - again)).toBeLessThanOrEqual(1)
})
