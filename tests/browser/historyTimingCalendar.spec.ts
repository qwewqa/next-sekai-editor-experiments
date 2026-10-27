import { expect, test, type Page } from '@playwright/test'
import { load } from './historyJourney'

// The calendar's costs on a long history (plan 1.4.10.5): the Timeline's rows for 5,000 entries,
// and Go To's index over an opened file's 10,000 and 50,000 rows, which the worker reads in full
// the first time, from its memo after, and by only the rows added when a flush adds some. In the
// timing project, run alone and on demand; it is not a gate. Medians of a few runs.

test('buildRows of 5,000 entries is warm within 30 ms', async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Measured in Chromium')
    test.setTimeout(120_000)
    await load(page)
    const median = await page.evaluate(async () => {
        const { appImport, historySteps } = window.editorTest
        const [{ buildRows }, { calendarAt }, { resolveZone }] = await Promise.all([
            appImport<typeof import('../../src/editor/history/rows')>(
                '/src/editor/history/rows.ts',
            ),
            appImport<typeof import('../../src/editor/history/calendarClock')>(
                '/src/editor/history/calendarClock.ts',
            ),
            appImport<typeof import('../../src/calendar/calendar')>('/src/calendar/calendar.ts'),
        ])
        const now = Date.now()
        const step = historySteps.editStep(historySteps.futureFixtureOperation('timing'))
        // Newest first, a minute apart, over about three and a half days.
        const entries = Array.from({ length: 5000 }, (_, i) => ({
            kind: 'edit' as const,
            step,
            sessionId: 's',
            seq: 5000 - i,
            time: now - i * 60_000,
            noteCount: 1,
            kept: true,
        }))
        const calendar = calendarAt(now, resolveZone('America/New_York'))
        const options = {
            filter: 'all' as const,
            expanded: new Set<string>(),
            damaged: new Set<string>(),
            calendar,
        }
        buildRows(entries as never, options)
        const runs: number[] = []
        for (let i = 0; i < 7; i++) {
            const start = performance.now()
            buildRows(entries as never, options)
            runs.push(performance.now() - start)
        }
        runs.sort((a, b) => a - b)
        return runs[Math.floor(runs.length / 2)]!
    })
    console.log(JSON.stringify({ buildRows5000Ms: median }))
    testInfo.annotations.push({ type: 'buildRows 5,000', description: `${median.toFixed(1)} ms` })
    expect(median).toBeLessThan(30)
})

/** Seeds an opened file's session of `count` rows two minutes apart, and reads its index. */
const measure = async (page: Page, count: number) =>
    page.evaluate(async (count) => {
        const start =
            await window.editorTest.appImport<typeof import('../../src/local/start')>(
                '/src/local/start.ts',
            )
        const worker = start.storageWorker as unknown as {
            call: (name: string, ...args: unknown[]) => Promise<unknown>
        }
        const id = `timing-${count}`
        const now = Date.now()
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('nse-local-data')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        const write = async (from: number, to: number) => {
            const tx = database.transaction(['sessions', 'entries'], 'readwrite')
            const entries = tx.objectStore('entries')
            for (let seq = from; seq <= to; seq++)
                entries.put({
                    sessionId: id,
                    seq,
                    time: now - (count + 40 - seq) * 120_000,
                    kind: 'edit',
                    snapshot: new Uint8Array(32),
                    kept: true,
                })
            tx.objectStore('sessions').put({
                id,
                chainId: id,
                origin: 'nxsp',
                lastSeq: to,
                entryCount: to,
            })
            await new Promise((resolve) => (tx.oncomplete = resolve))
        }
        const read = async () => {
            const began = performance.now()
            await worker.call('readTimelineIndex', { sessionId: id, zone: 'America/New_York' })
            return performance.now() - began
        }
        await write(1, count)
        const first = await read()
        const hits: number[] = []
        for (let i = 0; i < 5; i++) hits.push(await read())
        // A flush adds 20 rows to the head: the memo extends by those only.
        const extended: number[] = []
        let last = count
        for (let i = 0; i < 5; i++) {
            await write(last + 1, last + 20)
            last += 20
            extended.push(await read())
        }
        database.close()
        const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1]!
        return { first, hit: median(hits), extend: median(extended) }
    }, count)

for (const count of [10_000, 50_000])
    test(`Go To's index over an opened file of ${count.toLocaleString('en')} rows: first read, memo hit, extend`, async ({
        page,
        browserName,
    }, testInfo) => {
        test.skip(browserName !== 'chromium', 'Measured in Chromium')
        test.setTimeout(240_000)
        await load(page)
        const figures = await measure(page, count)
        console.log(JSON.stringify({ rows: count, ...figures }))
        testInfo.annotations.push({
            type: `index ${count}`,
            description: JSON.stringify(figures),
        })
        // A hit reads the session row only; an extension counts and reads the rows added.
        expect(figures.hit).toBeLessThan(15)
        expect(figures.extend).toBeLessThan(15)
    })
