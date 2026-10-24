import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import en from '../../src/i18n/en/index.json' with { type: 'json' }
import {
    closePage,
    errorsFail,
    flush,
    load,
    noErrors,
    notice,
    openHistory,
    peekRow,
    reloadAndWait,
    sampleClock,
    timeline,
    type SampleClock,
} from './historyJourney'
import { pressSave, queuePicks, rows, submitSave } from './saveFlows'

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

/**
 * Moves the clock on once nothing is in flight to the storage worker. A jump fires every timer
 * that is due, including the 10 s watchdog of a call still waiting for its answer: the call has
 * made no progress in the (fake) hour, so the client restarts the worker and the flush logs
 * "A flush failed". A real worker is not hung then, so a test that is not about that waits for
 * its flush before the jump.
 */
const pass = async (page: Page, clock: SampleClock, ms: number) => {
    await flush(page)
    await clock.pass(ms)
}

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

test('day buckets follow the zone of the page, far from the host', async ({ browser }) => {
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
        await pass(page, clock, 20 * MINUTE)
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
        expect(inWorker).toBe('Pacific/Auckland')
        await openGoTo(page)
        await expect
            .poll(() => goToDays(page))
            .toEqual([
                { day: 'Today', count: 2 },
                { day: 'Yesterday', count: 3 },
            ])
    } finally {
        await close()
    }
})

test('the headers move on at midnight while History is open', async ({ browser }) => {
    test.slow()
    const { page, clock, close } = await clocked(browser, 'Asia/Tokyo', '2026-06-10T23:58:30+09:00')
    try {
        await edit(page, 'Late')
        await openHistory(page)
        await expect
            .poll(async () => textOf(await lines(page)))
            .toEqual([expect.stringMatching(/^Now/), '11:58 PM', 'Late', IMPORTED])
        // The hourly tick at 00:00:01 rebuilds the headers: no reopen is needed.
        await pass(page, clock, 3 * MINUTE)
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

test('after a sleep the headers move a tier and no row is lost', async ({ browser }) => {
    test.slow()
    const { page, clock, close } = await clocked(browser, 'Asia/Tokyo', '2026-06-10T12:00:20+09:00')
    try {
        await edit(page, 'One')
        await edit(page, 'Two')
        await openHistory(page)
        const before = [expect.stringMatching(/^Now/), '12:00 PM', 'Two', 'One', IMPORTED]
        await expect.poll(async () => textOf(await lines(page))).toEqual(before)
        // The laptop's lid closes and opens three hours later: due timers fire once.
        await pass(page, clock, 3 * HOUR)
        await expect
            .poll(async () => textOf(await lines(page)))
            .toEqual([expect.stringMatching(/^Now/), '12 PM', 'Two', 'One', IMPORTED])
    } finally {
        await close()
    }
})

test('at a daylight saving fall-back, each row sits under the hour it was made in', async ({
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
        await pass(page, clock, 20 * MINUTE)
        await edit(page, 'B at 01:10 EDT')
        await pass(page, clock, HOUR)
        await edit(page, 'C at 01:10 EST')
        await pass(page, clock, 55 * MINUTE)
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

test('stored rows from a clock two hours ahead list with unique ids and End still works', async ({
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
        await pass(page, clock, HOUR)
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

/** Makes a row that groups with the one before it: Changed Initial Life. */
const groupable = (page: Page) =>
    page.evaluate(() => {
        const { history, historySteps } = window.editorTest
        const life = history.state.value.initialLife
        history.pushState(historySteps.initialLife(life, life + 1), {
            ...history.state.value,
            initialLife: life + 1,
        })
    })

/** The peeked entry's time, or undefined at Now. */
const peekedTime = (page: Page) =>
    page.evaluate(async () => {
        const { peekedInfo } = await window.editorTest.appImport<
            typeof import('../../src/editor/history/selection')
        >('/src/editor/history/selection.ts')
        return peekedInfo.value?.time
    })

test('a group never spans midnight, and Go To’s Yesterday counts and peeks yesterday', async ({
    browser,
}) => {
    test.slow()
    // Kiritimati (+14), 30 s before midnight: one edit before it, one after.
    const { page, clock, close } = await clocked(
        browser,
        'Pacific/Kiritimati',
        '2026-06-10T23:59:30+14:00',
    )
    const midnight = Date.parse('2026-06-11T00:00:00+14:00')
    try {
        await groupable(page)
        await pass(page, clock, MINUTE)
        await groupable(page)
        await flush(page)
        await openHistory(page)
        // Two rows, each under its own day's header.
        await expect
            .poll(async () => textOf(await lines(page)))
            .toEqual([
                expect.stringMatching(/^Now/),
                '12:00 AM',
                expect.stringMatching(/Initial Life/),
                'Yesterday · 11 PM',
                expect.stringMatching(/Initial Life/),
                IMPORTED,
            ])
        const inWorker = await workerZone(page)
        test.info().annotations.push({ type: 'worker zone', description: String(inWorker) })
        expect(inWorker).toBe('Pacific/Kiritimati')
        await openGoTo(page)
        // As the headers count them: one step today, the edit and the import yesterday.
        await expect
            .poll(() => goToDays(page))
            .toEqual([
                { day: 'Today', count: 1 },
                { day: 'Yesterday', count: 2 },
            ])
        await page.locator('[data-goto-list] [data-goto-item="day"]').nth(1).click()
        // Yesterday's newest state, not today's.
        await expect.poll(() => peekedTime(page)).toBeLessThan(midnight)
        expect(await peekedTime(page)).toBeGreaterThan(midnight - MINUTE)
        await noErrors(page)
    } finally {
        await close()
    }
})

/** A page of `context` whose zone the test can change with `Emulation.setTimezoneOverride`. */
const zoned = async (context: BrowserContext, page: Page, timezoneId: string) => {
    const session = await context.newCDPSession(page)
    const set = (zone: string) =>
        session.send('Emulation.setTimezoneOverride', { timezoneId: zone })
    await set(timezoneId)
    return set
}

/** The Timeline's continuation dividers, top down. */
const dividers = (page: Page) =>
    timeline(page)
        .locator('[data-history-continuation]')
        .evaluateAll((elements) =>
            elements.map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()),
        )

test('a zone change while History and Go To are open moves every time to the new zone', async ({
    browser,
}) => {
    test.slow()
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    // 08:30 in Tokyo is 19:30 the day before in New York, and 13:30 in Tokyo is 00:30 there.
    const clock = await sampleClock(context, Date.parse('2026-06-10T08:30:00+09:00'))
    const first = await context.newPage()
    await zoned(context, first, 'Asia/Tokyo')
    clock.track(first)
    errorsFail(first)
    try {
        await load(first)
        expect(await first.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
            'Asia/Tokyo',
        )
        await edit(first, 'A')
        await pass(first, clock, 5 * HOUR)
        await edit(first, 'B')
        await flush(first)
        await closePage(first, { runBeforeUnload: false })

        // A new visit continues the session: its first edit begins with a "Continued from" divider.
        const page = await context.newPage()
        const setZone = await zoned(context, page, 'Asia/Tokyo')
        clock.track(page)
        errorsFail(page)
        await load(page, { chart: 'keep' })
        await edit(page, 'C')
        await flush(page)
        await openHistory(page)
        await openGoTo(page)
        // In Tokyo it is all one day: the import, A, B and C (the divider is not a step).
        await expect.poll(() => goToDays(page)).toEqual([{ day: 'Today', count: 4 }])
        expect(await dividers(page)).toEqual([expect.stringContaining('1:30 PM')])

        await setZone('America/New_York')
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        // Go To reads the new zone's days: B and C are 12:30 AM today, A and the import yesterday.
        await expect
            .poll(() => goToDays(page))
            .toEqual([
                { day: 'Today', count: 2 },
                { day: 'Yesterday', count: 2 },
            ])
        await page.keyboard.press('Escape')
        // The headers, the divider and the peek bar are the new zone's too.
        await expect
            .poll(async () => textOf(await lines(page)))
            .toEqual([
                expect.stringMatching(/^Now/),
                '12:30 AM',
                'C',
                'B',
                'Yesterday · 7 PM',
                'A',
                IMPORTED,
            ])
        await expect.poll(() => dividers(page)).toEqual([expect.stringContaining('12:30 AM')])
        await peekRow(page, 'A')
        await expect(page.locator('[data-peek-bar]')).toContainText('7:30')
        // Step Details names the time in the new zone.
        await page.locator('[data-peek-details]').click()
        const details = page.getByRole('dialog', { name: 'Step Details', exact: true })
        await expect(details).toBeVisible()
        await expect(details).toContainText('7:30')
        await noErrors(page)
    } finally {
        await context.close()
    }
})

const OPFS = { fileSystemAccess: 'opfs' } as const

/** The OPFS file `name` as base64, to carry it to another context. */
const encoded = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const file = await (await root.getFileHandle(name)).getFile()
        const bytes = new Uint8Array(await file.arrayBuffer())
        let text = ''
        for (let i = 0; i < bytes.length; i += 0x8000)
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return btoa(text)
    }, name)

const stored = (page: Page, name: string, base64: string) =>
    page.evaluate(
        async ({ name, base64 }) => {
            const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
            const root = await navigator.storage.getDirectory()
            const writable = await (
                await root.getFileHandle(name, { create: true })
            ).createWritable()
            await writable.write(bytes)
            await writable.close()
        },
        { name, base64 },
    )

/**
 * Every header and row of the Timeline, top down: the list is virtual, so it is scrolled from the
 * top to the oldest row and what shows at each step is kept by its place.
 */
const everyLine = async (page: Page) => {
    const seen = new Map<number, Line>()
    const list = timeline(page)
    await list.evaluate((element) => {
        element.scrollTop = 0
    })
    for (let step = 0; step < 100; step++) {
        const shown = await list
            .locator('.timeline-header, [data-history-row]')
            .evaluateAll((elements) =>
                elements.map((element) => {
                    const normal = (text: string | null | undefined) =>
                        (text ?? '').replace(/\s+/g, ' ').trim()
                    const top = parseFloat((element as HTMLElement).style.top)
                    if (element.matches('.timeline-header'))
                        return { top, kind: 'header' as const, text: normal(element.textContent) }
                    const title = element.matches('.timeline-now')
                        ? element.querySelector('.timeline-entry-text')
                        : element.querySelector('[data-history-group-action]')
                    return { top, kind: 'row' as const, text: normal(title?.textContent) }
                }),
            )
        for (const { top, ...line } of shown) seen.set(top, line)
        const atEnd = await list.evaluate((element) => {
            const before = element.scrollTop
            element.scrollTop = before + element.clientHeight / 2
            return element.scrollTop === before
        })
        if (atEnd) break
        await page.waitForTimeout(100)
    }
    return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line)
}

/** The headers and rows of a list, as Go To would count them: steps under each run of a day. */
const headerDays = (list: Line[]) => {
    const days: { day: string; count: number }[] = []
    let day = 'Today'
    for (const line of list) {
        if (line.kind === 'header') {
            const named = /^(.*) · /.exec(line.text)?.[1]
            if (named) day = named
            else if (!/^\d{1,2}(:\d\d)? [AP]M$/.test(line.text)) day = line.text
            // A header without a day continues the day above it.
        } else if (!/^Now/.test(line.text)) {
            if (days.at(-1)?.day === day) days.at(-1)!.count++
            else days.push({ day, count: 1 })
        }
    }
    return days
}

test('an opened file whose times run out of order lists Go To’s days as the headers count them', async ({
    browser,
}) => {
    test.slow()
    const zone = 'Pacific/Kiritimati'
    // A file with a 14-step history.
    const maker = await browser.newContext({ timezoneId: zone })
    const source = await maker.newPage()
    errorsFail(source)
    let base64: string
    try {
        await load(source, { platform: OPFS })
        for (let i = 1; i <= 14; i++) await edit(source, `Step ${i}`)
        await flush(source)
        await pressSave(source)
        await submitSave(source, 't8')
        await expect(notice(source, 'Saved to t8.nxsp')).toBeVisible()
        base64 = await encoded(source, 't8.nxsp')
    } finally {
        await maker.close()
    }
    // Opened in a fresh context.
    const context = await browser.newContext({ timezoneId: zone })
    const page = await context.newPage()
    errorsFail(page)
    try {
        await load(page, { platform: OPFS, chart: 'keep' })
        await stored(page, 't8.nxsp', base64)
        await queuePicks(page, ['t8.nxsp'])
        await page.keyboard.press('o')
        await expect(notice(page, 't8.nxsp').first()).toBeVisible()
        await expect
            .poll(async () => {
                const { sessions } = await rows(page, ['sessions'])
                return sessions!.filter((entry) => entry.value.importPending === true).length
            })
            .toBe(0)
        // The file came from a device with another clock: its rows run out of order across days.
        await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open('nse-local-data')
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error)
            })
            const tx = db.transaction(['sessions', 'entries'], 'readwrite')
            const sessions = await new Promise<{ id: string; origin?: string }[]>((resolve) => {
                const request = tx.objectStore('sessions').getAll()
                request.onsuccess = () => resolve(request.result as never)
            })
            const opened = sessions.find((session) => session.origin === 'nxsp')!
            const store = tx.objectStore('entries')
            const all = await new Promise<{ sessionId: string; seq: number; time: number }[]>(
                (resolve) => {
                    const request = store.getAll()
                    request.onsuccess = () => resolve(request.result as never)
                },
            )
            // Hours back from now, by the file's order: a day, the day before, back again.
            const back = [60, 5, 30, 28, 3, 55, 26, 2, 52, 1, 29, 50, 4, 27, 6, 8]
            const now = Date.now()
            for (const row of all.filter((each) => each.sessionId === opened.id)) {
                const hours = back[row.seq - 1]
                if (hours === undefined) continue
                row.time = now - hours * 3_600_000
                store.put(row)
            }
            await new Promise((resolve) => (tx.oncomplete = resolve))
            db.close()
        })
        await reloadAndWait(page)
        await openHistory(page)
        const all = await everyLine(page)
        expect(all.at(-1)?.text).toBe(IMPORTED)
        await openGoTo(page)
        const goTo = await goToDays(page)
        // As the headers count them: the run of a day that comes back is listed again.
        expect(goTo).toEqual(headerDays(all))
        expect(new Set(goTo.map((each) => each.day)).size).toBeLessThan(goTo.length)
        expect(goTo.reduce((sum, each) => sum + each.count, 0)).toBeGreaterThanOrEqual(16)
        await noErrors(page)
    } finally {
        await context.close()
    }
})
