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
    openHistory,
    peekRow,
    release,
    row,
    rowTitles,
    timeline,
} from './historyJourney'
import { submitSave } from './saveFlows'

// Live entries while the Timeline is scrolled: the list stays where the
// reader put it while entries arrive, and a burst of more than one page between two refreshes
// keeps the older pages already loaded.

test.beforeEach(({ page }) => {
    errorsFail(page)
})

test.afterEach(({ page }) => {
    noErrors(page)
})

/** Pushes `count` steps with titles "Syn <n>", the way a long session would have made them. */
const pushSteps = (page: Page, count: number, tag = 'Syn') =>
    page.evaluate(
        ({ count, tag }) => {
            const { history, historySteps } = window.editorTest
            for (let i = 1; i <= count; i++) {
                const life = history.state.value.initialLife
                history.pushState(historySteps.futureInitialLife(life, life + 1, `${tag} ${i}`), {
                    ...history.state.value,
                    initialLife: life + 1,
                })
            }
        },
        { count, tag },
    )

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

test('a burst of more than one page between refreshes keeps the older pages and the position', async ({
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

test('an older page that cannot be read ends the list in Try Again, which reads it', async ({
    page,
}) => {
    await load(page)
    await pushSteps(page, 250)
    await flush(page)
    await openPanel(page)
    await expect.poll(async () => (await source(page)).loaded).toBeGreaterThan(50)
    const loadedBefore = (await source(page)).loaded
    const list = timeline(page, 'panel')
    const failed = list.locator('[data-history-more-failed]')

    // The next older page is read at the end of the list, and the read fails.
    const hold = await holdWorker(page, 'readTimeline')
    await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight
    })
    await hold.reached()
    await hold.release(true)
    await expect(failed).toContainText('The Timeline could not be loaded.')
    // Scrolling does not read it again by itself: the line stays until Try Again.
    await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight
    })
    await expect.poll(async () => (await source(page)).loadingMore).toBe(false)
    await expect(failed).toBeVisible()
    expect((await source(page)).loaded).toBe(loadedBefore)

    await failed.getByRole('button', { name: 'Try Again' }).click()
    await expect(failed).toHaveCount(0)
    await expect.poll(async () => (await source(page)).loaded).toBeGreaterThan(loadedBefore)
})

test('a refresh that replaces the loaded run takes the Try Again of a failed older page away', async ({
    page,
}) => {
    await load(page)
    await pushSteps(page, 250)
    await flush(page)
    await openPanel(page)
    await expect.poll(async () => (await source(page)).loaded).toBeGreaterThan(50)
    const list = timeline(page, 'panel')
    const failed = list.locator('[data-history-more-failed]')
    const hold = await holdWorker(page, 'readTimeline')
    await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight
    })
    await hold.reached()
    await hold.release(true)
    await expect(failed).toBeVisible()
    // A different run replaces the list (as a session change without a reset does): its older
    // pages are unread, so the failure of the old run's page does not carry over.
    await page.evaluate(async () => {
        const source = await window.editorTest.appImport<
            typeof import('../../src/editor/history/source')
        >('/src/editor/history/source.ts')
        await source.refresh({ replace: true })
    })
    await expect(failed).toHaveCount(0)
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

/**
 * Scrolls the panel's Timeline down a screen at a time until the row titled `title` is rendered,
 * then onto the screen. Each screen waits for the older page it asked for and its drawing, so
 * slow reads never run out a poll.
 */
const scrollToRow = async (page: Page, title: string) => {
    const list = timeline(page, 'panel')
    const target = row(page, title, 'panel')
    const drawn = () =>
        list.evaluate(
            () =>
                new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                ),
        )
    for (let screens = 0; (await target.count()) === 0; screens++) {
        expect(screens, `"${title}" is listed`).toBeLessThan(100)
        await list.evaluate((element) => {
            element.scrollTop += element.clientHeight
        })
        await drawn()
        await expect.poll(async () => (await source(page)).loadingMore).toBe(false)
        await drawn()
    }
    await target.scrollIntoViewIfNeeded()
}

test('Save and Export while peeking leave the peek and the rows where they are', async ({
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

test('rows that were shown stay in every frame while pending entries are stored and a new one arrives', async ({
    page,
}) => {
    await load(page)
    await pushSteps(page, 3)
    await flush(page)
    await openPanel(page)
    await expect(row(page, 'Syn 3', 'panel')).toBeVisible()

    // One sample per frame of the titles rendered, from here to the end.
    await page.evaluate(() => {
        const frames: string[][] = []
        const sampler = { frames, stop: false }
        ;(window as unknown as { sampler: typeof sampler }).sampler = sampler
        const sample = () => {
            frames.push(
                [
                    ...document.querySelectorAll(
                        '[data-history-surface="panel"] [data-history-row] [data-history-group-action]',
                    ),
                ].map((element) => (element.textContent ?? '').trim()),
            )
            if (!sampler.stop) requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
    })

    // Two steps shown from the pending ones, then stored (the flusher forgets them as pending),
    // then one more: the list is rebuilt before it has read the stored two back. The Timeline's
    // reads wait until the end of that, so the stretch lasts as long as the test needs.
    const hold = await holdWorker(page, 'readTimeline')
    try {
        await pushSteps(page, 2, 'New')
        await expect(row(page, 'New 2', 'panel')).toBeVisible()
        await flush(page)
        await pushSteps(page, 1, 'Later')
        await expect(row(page, 'Later 1', 'panel')).toBeVisible()
        await expect(row(page, 'New 1', 'panel')).toBeVisible()
        await hold.reached()
    } finally {
        await release(page)
    }
    // Everything is back, and the read has landed: the stored entries are all in the run.
    await expect
        .poll(() => rowTitles(page, 'panel'))
        .toEqual(expect.arrayContaining(['Later 1', 'New 2', 'New 1', 'Syn 3']))
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const source = await window.editorTest.appImport<
                    typeof import('../../src/editor/history/source')
                >('/src/editor/history/source.ts')
                return source.entries.value.filter((entry) => entry.pending).length
            }),
        )
        .toBe(0)

    const frames = await page.evaluate(() => {
        const { sampler } = window as unknown as { sampler: { frames: string[][]; stop: boolean } }
        sampler.stop = true
        return sampler.frames
    })
    const seen = new Set<string>()
    const lost: string[] = []
    for (const titles of frames) {
        for (const title of seen)
            if (!titles.includes(title) && !lost.includes(title)) lost.push(title)
        for (const title of titles) seen.add(title)
    }
    expect(lost, 'rows that were shown and then dropped for a while').toEqual([])
    expect(seen).toContain('New 1')
})

/** The Timeline's source, as the app loaded it. */
const withSource = <T, A>(
    page: Page,
    use: (source: typeof import('../../src/editor/history/source'), arg: A) => T | Promise<T>,
    arg?: A,
) =>
    page.evaluate(
        async ([use, arg]) => {
            const source = await window.editorTest.appImport<
                typeof import('../../src/editor/history/source')
            >('/src/editor/history/source.ts')
            return (await (0, eval)(`(${use})`)(source, arg)) as T
        },
        [use.toString(), arg] as const,
    )

test('a refresh that began earlier and lands later does not take back what a newer one showed', async ({
    page,
}) => {
    await load(page)
    await pushSteps(page, 3)
    await flush(page)
    await openPanel(page)
    await expect(row(page, 'Syn 3', 'panel')).toBeVisible()

    // The first read of the earlier refresh returns after a gate: it read the stored entries as
    // they are now, and lands after the next refresh has.
    await page.evaluate(async () => {
        const start =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        const source = await window.editorTest.appImport<
            typeof import('../../src/editor/history/source')
        >('/src/editor/history/source.ts')
        const worker = start.storageWorker as unknown as {
            call: (name: string, ...args: unknown[]) => Promise<unknown>
        }
        const call = worker.call.bind(worker)
        const control = window as unknown as {
            lateRefresh?: Promise<void>
            releaseLate?: () => void
        }
        let delayed = false
        const gate = new Promise<void>((resolve) => (control.releaseLate = resolve))
        worker.call = async (name, ...args) => {
            const result = await call(name, ...args)
            if (name === 'readTimeline' && !delayed) {
                delayed = true
                await gate
            }
            return result
        }
        control.lateRefresh = source.refresh()
    })
    // Its read is made (the request is first in line), then one more entry is stored.
    await pushSteps(page, 1, 'New')
    await flush(page)
    // The newer refresh: its reads pass, and it lands first.
    await withSource(page, (source) => source.refresh())
    await expect(row(page, 'New 1', 'panel')).toBeVisible()
    await expect
        .poll(() =>
            withSource(page, (source) => source.entries.value.filter((e) => e.pending).length),
        )
        .toBe(0)

    // The late one lands now. The entries are read at once, before the debounced refresh that
    // would put a lost row back.
    const stored = await page.evaluate(async () => {
        const source = await window.editorTest.appImport<
            typeof import('../../src/editor/history/source')
        >('/src/editor/history/source.ts')
        const control = window as unknown as { lateRefresh: Promise<void>; releaseLate: () => void }
        control.releaseLate()
        await control.lateRefresh
        return source.entries.value.filter((entry) => !entry.pending).length
    })
    // It was dropped: the initialize entry, three steps and the new one are all still there.
    expect(stored).toBe(5)
    await expect(row(page, 'New 1', 'panel')).toBeVisible()
})

test('Now after a far jump reads the newest page again, and without a jump the loaded pages stay', async ({
    page,
}) => {
    test.slow()
    await load(page)
    await pushSteps(page, 250)
    await flush(page)
    await openHistory(page)
    // The first page has been read before a key goes to the list.
    await expect(row(page, 'Syn 250')).toBeVisible()
    // End jumps to the oldest entry: a window there, with a gap row above it.
    await page.keyboard.press('End')
    await expect(row(page, 'Imported a level')).toBeVisible()
    await expect.poll(() => withSource(page, (source) => source.gap.value)).toBeGreaterThan(0)
    // Home is Now: the window goes, and the run is the newest page.
    await page.keyboard.press('Home')
    await expect.poll(() => withSource(page, (source) => source.gap.value)).toBeUndefined()
    await expect(row(page, 'Syn 250')).toBeVisible()
    const run = () =>
        withSource(page, (source) => ({
            loaded: source.entries.value.length,
            more: source.canLoadMore.value,
        }))
    expect(await run()).toEqual({ loaded: 100, more: true })

    // Every page loaded: Now with no jump keeps them.
    const list = timeline(page)
    await expect
        .poll(async () => {
            await list.evaluate((element) => {
                element.scrollTop = element.scrollHeight
            })
            return (await run()).more
        })
        .toBe(false)
    expect((await run()).loaded).toBe(251)
    await withSource(page, (source) => source.resetToNewest())
    expect(await run()).toEqual({ loaded: 251, more: false })
})

test('entries carried for one session are gone when a new session begins', async ({ page }) => {
    await load(page)
    await pushSteps(page, 2)
    await flush(page)
    await openPanel(page)
    await expect(row(page, 'Syn 2', 'panel')).toBeVisible()
    // No read lands while the list holds what it carried, so nothing else could clear it.
    await holdWorker(page, 'readTimeline')
    try {
        await pushSteps(page, 2, 'Old')
        await expect(row(page, 'Old 2', 'panel')).toBeVisible()
        await flush(page)
        await page.evaluate(() => {
            window.editorTest.history.resetState(false)
        })
        // Only the new session's own first entry: none of the old session's, carried or stored.
        await expect
            .poll(() => rowTitles(page, 'panel'))
            .toEqual([expect.stringMatching(/^Now/), 'Started a new level'])
        expect(await withSource(page, (source) => source.entries.value.length)).toBe(1)
    } finally {
        await release(page)
    }
})

test('a Save and an Export with History open show their rows at the top, without waiting for a read', async ({
    page,
}) => {
    await load(page, { platform: { fileSystemAccess: 'opfs' } })
    await pushSteps(page, 2)
    await flush(page)
    await openPanel(page)
    await expect(row(page, 'Syn 2', 'panel')).toBeVisible()
    // No read lands while the file events are made: only what the list was told can show them.
    await holdWorker(page, 'readTimeline')
    try {
        await page.evaluate(() => {
            const active = document.activeElement
            if (active instanceof HTMLElement && active !== document.body) active.blur()
        })
        await page.keyboard.press('p')
        await submitSave(page, 'live')
        await expect(notice(page, 'Saved to live.nxsp')).toBeVisible()
        await expect
            .poll(() => rowTitles(page, 'panel'))
            .toEqual([
                expect.stringMatching(/^Now/),
                'Saved live.nxsp',
                'Syn 2',
                'Syn 1',
                expect.any(String),
            ])

        await page.keyboard.press('Shift+P')
        const dialog = page.getByRole('dialog').filter({ hasText: 'Export Level Data' })
        await expect(dialog).toBeVisible()
        await dialog.getByRole('textbox', { name: 'File Name' }).fill('live')
        await page.keyboard.press('Enter')
        await expect(notice(page, 'Exported to live.nsld')).toBeVisible()
        await expect
            .poll(() => rowTitles(page, 'panel'))
            .toEqual([
                expect.stringMatching(/^Now/),
                'Exported live.nsld',
                'Saved live.nxsp',
                'Syn 2',
                'Syn 1',
                expect.any(String),
            ])
    } finally {
        await release(page)
    }
    // The read that follows agrees.
    await expect
        .poll(() => rowTitles(page, 'panel'))
        .toEqual([
            expect.stringMatching(/^Now/),
            'Exported live.nsld',
            'Saved live.nxsp',
            'Syn 2',
            'Syn 1',
            expect.any(String),
        ])
})
