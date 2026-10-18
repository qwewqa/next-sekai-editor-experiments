import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { charts, flushed, median, open, singleEdits, wholeEdits } from './flushBudget'

// The peek rebuild cost (Part 1 §1.9.2 #5–#6, Step 5): on the generated large chart and on coconut
// when present. A cold peek reads, verifies and builds a dropped state from storage; a warm one
// shows a state the undo stack holds. Each is timed to the peek's state and to the end of the
// next frame, against an idle frame. Recorded, not asserted (a check, not a gate).

for (const chart of charts) {
    test(`peek rebuild on the ${chart.name}`, async ({ page, browserName }, testInfo) => {
        test.skip(browserName !== 'chromium', 'Measured in Chromium')
        test.skip(chart.optional === true && !existsSync(chart.file), `${chart.file} is absent`)
        test.setTimeout(180_000)
        await open(page, chart.file, chart.optional === true)
        // Entry 1 is the import; entry 2 a whole-chart edit, then dropped from redo by entry 4,
        // a one-note edit, so no state in memory has entry 2's snapshot.
        await wholeEdits(page, 1)
        await page.evaluate(() => {
            window.editorTest.history.undoState()
        })
        await singleEdits(page, 1)
        await flushed(page)

        const runs = await page.evaluate(async () => {
            const { appImport } = window.editorTest
            const [peek, { flusher }] = await Promise.all([
                appImport<typeof import('../../src/history/peek')>('/src/history/peek.ts'),
                appImport<typeof import('../../src/local/storing')>('/src/local/storing.ts'),
            ])
            const session = flusher!.session!.id
            const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
            // The end of the next frame: after every animation callback, the canvas's included.
            const frame = () =>
                new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
            const measure = async (run: () => unknown) => {
                await frame()
                // Outside the peek debounce's window.
                await sleep(120)
                await frame()
                const start = performance.now()
                await run()
                const settled = performance.now()
                await frame()
                return { settledMs: settled - start, frameMs: performance.now() - start }
            }
            const results = []
            for (let i = 0; i < 6; i++) {
                peek.resetPeekForTests()
                const idle = await measure(() => undefined)
                const cold = await measure(() => peek.peekEntry(peek.entryKey(session, 2)))
                if (!peek.isPeeking.value) throw new Error('The cold peek failed')
                const leave = await measure(() => {
                    peek.leavePeek()
                })
                const warm = await measure(() => peek.peekEntry(peek.entryKey(session, 1)))
                peek.leavePeek()
                results.push({ idle, cold, leave, warm })
            }
            return results
        })
        // The first run warms caches and code; it's left out.
        const steady = runs.slice(1)
        const of = (pick: (run: (typeof runs)[number]) => number) =>
            Math.round(median(steady.map(pick)) * 10) / 10
        const figures = {
            chart: chart.name,
            idleFrameMs: of((run) => run.idle.frameMs),
            coldPeekStateMs: of((run) => run.cold.settledMs),
            coldPeekFrameMs: of((run) => run.cold.frameMs),
            warmPeekStateMs: of((run) => run.warm.settledMs),
            warmPeekFrameMs: of((run) => run.warm.frameMs),
            leaveFrameMs: of((run) => run.leave.frameMs),
            firstColdPeekFrameMs: Math.round(runs[0]!.cold.frameMs * 10) / 10,
        }
        console.log(JSON.stringify(figures))
        testInfo.annotations.push({ type: 'peek-rebuild', description: JSON.stringify(figures) })
        expect(figures.coldPeekFrameMs).toBeGreaterThan(0)
    })
}
