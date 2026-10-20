import { expect, test, type Browser, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import {
    errorsFail,
    flush,
    load,
    noErrors,
    openHistory,
    sampleClock,
    timeline,
    type SampleClock,
} from './historyJourney'

// How the Timeline tells time (plan 1.4.10.5): day buckets and headers across zones, midnight,
// sleep, a clock change and skewed clocks. Entries are future-extension steps, which are never
// grouped, so each stays a row of its own under its own header.

type Clocked = { page: Page; clock: SampleClock; close: () => Promise<void> }

/** A page in a zone, with the page's clock and the storage worker's Date at `start`. */
const clocked = async (browser: Browser, timezoneId: string, start: string): Promise<Clocked> => {
    const context = await browser.newContext({
        timezoneId,
        viewport: { width: 1600, height: 1000 },
    })
    const clock = await sampleClock(context, Date.parse(start))
    const page = await context.newPage()
    clock.track(page)
    errorsFail(page)
    await load(page)
    return { page, clock, close: () => context.close() }
}

/** Makes a row titled `label`. */
const edit = (page: Page, label: string) =>
    page.evaluate((label) => {
        const { history, historySteps } = window.editorTest
        const life = history.state.value.initialLife
        history.pushState(historySteps.futureInitialLife(life, life + 1, label), {
            ...history.state.value,
            initialLife: life + 1,
        })
    }, label)

type Line = { kind: 'header' | 'row'; text: string }

/** The headers and rows the Timeline shows, top down: a header by its text, a row by its title. */
const lines = (page: Page) =>
    timeline(page)
        .locator('.timeline-header, [data-history-row]')
        .evaluateAll((elements) =>
            elements
                .map((element) => ({
                    element,
                    top: parseFloat((element as HTMLElement).style.top),
                }))
                .sort((a, b) => a.top - b.top)
                .map(({ element }): Line => {
                    const normal = (text: string | null | undefined) =>
                        (text ?? '').replace(/\s+/g, ' ').trim()
                    if (element.matches('.timeline-header'))
                        return { kind: 'header', text: normal(element.textContent) }
                    const title = element.matches('.timeline-now')
                        ? element.querySelector('.timeline-entry-text')
                        : element.querySelector('[data-history-group-action]')
                    return { kind: 'row', text: normal(title?.textContent) }
                }),
        )

const textOf = (list: Line[]) => list.map((line) => line.text)

/** What `Intl` says the zone of a worker is: Playwright may not carry `timezoneId` into workers. */
const workerZone = async (page: Page) => {
    const worker = page.workers()[0]
    if (!worker) return undefined
    return worker.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
}

const openGoTo = async (page: Page) => {
    await page.locator('[data-history-focus="goto"]').click()
    await expect(page.locator('[data-goto-list] [data-goto-item="now"]')).toBeVisible()
}

/** Go To's day rows: the day's name and the count its row ends with. */
const goToDays = (page: Page) =>
    page.locator('[data-goto-list] [data-goto-item="day"]').evaluateAll((items) =>
        items.map((item) => ({
            day: item.querySelector('.font-bold')?.textContent?.trim() ?? '',
            count: Number(
                /\d[\d,]*/.exec(item.lastElementChild?.textContent ?? '')?.[0]?.replace(/,/g, ''),
            ),
        })),
    )

// The first row of a session that began with a level: the fixture shows one.
const IMPORTED = en.history.operation.importedLevel
const MINUTE = 60_000
const HOUR = 60 * MINUTE

test('T1: day buckets follow the zone of the page, far from the host', async ({ browser }) => {
    test.slow()
    // Auckland (+12 in June), ten minutes before midnight.
    const { page, clock, close } = await clocked(
        browser,
        'Pacific/Auckland',
        '2026-06-10T23:50:00+12:00',
    )
    try {
        const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
        expect(zone).toBe('Pacific/Auckland')
        await edit(page, 'Before A')
        await edit(page, 'Before B')
        await clock.pass(20 * MINUTE)
        await edit(page, 'After A')
        await edit(page, 'After B')
        await flush(page)
        await openHistory(page)
        // The new day's rows sit under their minute, and the old day's under its hour with its day.
        await expect
            .poll(async () => textOf(await lines(page)))
            .toEqual([
                expect.stringMatching(/^Now/),
                '12:10 AM',
                'After B',
                'After A',
                'Yesterday · 11 PM',
                'Before B',
                'Before A',
                IMPORTED,
            ])
        // Go To lists the two days, with the rows under each header counted. The storage worker
        // reads the days: its zone must be the page's for the buckets to agree.
        const inWorker = await workerZone(page)
        test.info().annotations.push({
            type: 'worker zone',
            description: String(inWorker),
        })
        if (inWorker === 'Pacific/Auckland') {
            await openGoTo(page)
            await expect
                .poll(() => goToDays(page))
                .toEqual([
                    { day: 'Today', count: 2 },
                    { day: 'Yesterday', count: 3 },
                ])
        }
    } finally {
        await close()
    }
})

test('T2: the headers move on at midnight while History is open', async ({ browser }) => {
    test.slow()
    const { page, clock, close } = await clocked(browser, 'Asia/Tokyo', '2026-06-10T23:58:30+09:00')
    try {
        await edit(page, 'Late')
        await openHistory(page)
        await expect
            .poll(async () => textOf(await lines(page)))
            .toEqual([expect.stringMatching(/^Now/), '11:58 PM', 'Late', IMPORTED])
        // The hourly tick at 00:00:01 rebuilds the headers: no reopen is needed.
        await clock.pass(3 * MINUTE)
        await expect
            .poll(async () => textOf(await lines(page)))
            .toEqual([expect.stringMatching(/^Now/), 'Yesterday · 11 PM', 'Late', IMPORTED])
        // A new edit goes under Today.
        await edit(page, 'Early')
        await expect
            .poll(async () => textOf(await lines(page)))
            .toEqual([
                expect.stringMatching(/^Now/),
                '12:01 AM',
                'Early',
                'Yesterday · 11 PM',
                'Late',
                IMPORTED,
            ])
    } finally {
        await close()
    }
})

test('T3: after a sleep the headers move a tier and no row is lost', async ({ browser }) => {
    test.slow()
    const { page, clock, close } = await clocked(browser, 'Asia/Tokyo', '2026-06-10T12:00:20+09:00')
    try {
        await edit(page, 'One')
        await edit(page, 'Two')
        await openHistory(page)
        const before = [expect.stringMatching(/^Now/), '12:00 PM', 'Two', 'One', IMPORTED]
        await expect.poll(async () => textOf(await lines(page))).toEqual(before)
        // The laptop's lid closes and opens three hours later: due timers fire once.
        await clock.pass(3 * HOUR)
        await expect
            .poll(async () => textOf(await lines(page)))
            .toEqual([expect.stringMatching(/^Now/), '12 PM', 'Two', 'One', IMPORTED])
    } finally {
        await close()
    }
})

test('T4: at a daylight saving fall-back, each row sits under the hour it was made in', async ({
    browser,
}) => {
    test.slow()
    // 2026-11-01 in New York: 01:00 to 01:59 happens twice, EDT then EST.
    const { page, clock, close } = await clocked(
        browser,
        'America/New_York',
        '2026-11-01T04:50:00Z',
    )
    try {
        await edit(page, 'A at 00:50 EDT')
        await clock.pass(20 * MINUTE)
        await edit(page, 'B at 01:10 EDT')
        await clock.pass(HOUR)
        await edit(page, 'C at 01:10 EST')
        await clock.pass(55 * MINUTE)
        await edit(page, 'D at 02:05 EST')
        await openHistory(page)
        // The two 1 AM hours are two headers over their own rows; no key is used twice (a
        // duplicate-key warning fails the test).
        await expect
            .poll(async () => textOf(await lines(page)))
            .toEqual([
                expect.stringMatching(/^Now/),
                '2:05 AM',
                'D at 02:05 EST',
                '1 AM',
                'C at 01:10 EST',
                '1 AM',
                'B at 01:10 EDT',
                '12 AM',
                'A at 00:50 EDT',
                IMPORTED,
            ])
        // Each row's name carries its own time of day.
        const labels = await timeline(page)
            .locator('[data-history-row]')
            .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label') ?? ''))
        expect(labels.filter((label) => /1:10:\d\d AM/.test(label))).toHaveLength(2)
    } finally {
        await close()
    }
})

test('T5: stored rows from a clock two hours ahead list with unique ids and End still works', async ({
    browser,
}) => {
    test.slow()
    // Mid-minute on a fixed clock, so a row from a second ago shares the minute of a local edit.
    const { page, clock, close } = await clocked(browser, 'UTC', '2026-06-10T12:30:10Z')
    try {
        // Stored rows as an imported file from another device leaves them: their times run ahead of
        // this clock, and the chain's order (by seq) is not the order of the times.
        await page.evaluate(async () => {
            const start =
                await window.editorTest.appImport<typeof import('../../src/local/start')>(
                    '/src/local/start.ts',
                )
            const worker = start.storageWorker as unknown as {
                call: (name: string, ...args: unknown[]) => Promise<unknown>
            }
            const call = worker.call.bind(worker)
            const { historySteps } = window.editorTest
            const now = Date.now()
            let seq = 900
            const remote = (time: number, label: string) => ({
                sessionId: 'remote',
                seq: seq--,
                time,
                kind: 'edit',
                step: historySteps.editStep(
                    historySteps.futureFixtureOperation(`remote-${seq}`, {}, label),
                ),
                snapshot: '00',
                noteCount: 1,
                dirty: false,
                kept: true,
            })
            const older = [
                remote(now + 2 * 3_600_000, 'Remote ahead'),
                remote(now + 2 * 3_600_000 - 60_000, 'Remote ahead too'),
                remote(now - 1_000, 'Remote now'),
                remote(now - 8 * 3_600_000, 'Remote behind'),
            ]
            worker.call = async (name, ...args) => {
                const result = await call(name, ...args)
                const before = (args[0] as { before?: number } | undefined)?.before
                if (name !== 'readTimeline' || before !== undefined) return result
                const page = result as { entries: unknown[] }
                return { ...page, entries: [...page.entries, ...older] }
            }
        })
        await edit(page, 'Local')
        await openHistory(page, { focused: false })
        await expect(
            timeline(page)
                .locator('[data-history-group-action]')
                .filter({ hasText: 'Remote behind' }),
        ).toBeVisible()
        // The 12:30 header repeats under the hour header of the rows ahead, as the chain's order
        // (by seq) puts it; each header has an id of its own.
        expect((await lines(page)).filter((line) => line.text === '12:30 PM')).toHaveLength(2)
        const ids = await timeline(page)
            .locator('[id]')
            .evaluateAll((elements) => elements.map((element) => element.id))
        expect(new Set(ids).size).toBe(ids.length)
        // An hour on, every header is rebuilt with the same repeat. Vue checks the keys when rows
        // update (a duplicate fails the test through the error listener).
        await clock.pass(HOUR)
        await expect
            .poll(async () => (await lines(page)).filter((line) => line.text === '12 PM').length)
            .toBe(2)
        await edit(page, 'Local again')
        await expect(
            timeline(page)
                .locator('[data-history-group-action]')
                .filter({ hasText: 'Local again' }),
        ).toBeVisible()
        // The Timeline is not stuck: End goes to the last row.
        await timeline(page).locator('[data-history-row]').first().focus()
        await page.keyboard.press('End')
        await expect(
            timeline(page)
                .locator('[data-history-group-action]')
                .filter({ hasText: 'Remote behind' }),
        ).toBeVisible()
        await noErrors(page)
    } finally {
        await close()
    }
})
