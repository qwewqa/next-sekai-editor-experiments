import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { charts, median, open, singleEdits, wholeEdits } from './flushBudget'

// The main thread's share of a flush (desktop): a single-note edit under 2 ms, a
// whole-chart edit under 16 ms in slices of 8 ms at most. In the timing project, run alone, since
// other workers' load shows up in a slice. Medians, so one garbage collection doesn't decide it.

for (const chart of charts) {
    test(`main-thread flush timing on the ${chart.name}`, async ({
        page,
        browserName,
    }, testInfo) => {
        test.skip(browserName !== 'chromium', 'Measured in Chromium')
        test.skip(chart.optional === true && !existsSync(chart.file), `${chart.file} is absent`)
        test.setTimeout(240_000)
        await open(page, chart.file, chart.optional === true)
        const singles = await singleEdits(page, 30)
        const wholes = await wholeEdits(page, 6)
        const figures = {
            chart: chart.name,
            singleMainMs: median(singles.map((report) => report.mainMs)),
            wholeMainMs: median(wholes.map((report) => report.mainMs)),
            // Each flush's longest slice; a collection can land in any one of them.
            wholeSliceMs: median(wholes.map((report) => Math.max(...report.slices))),
            wholeMaxSliceMs: Math.max(...wholes.flatMap((report) => report.slices)),
        }
        console.log(JSON.stringify(figures))
        testInfo.annotations.push({ type: 'flush-timing', description: JSON.stringify(figures) })
        expect(figures.singleMainMs).toBeLessThan(2)
        expect(figures.wholeMainMs).toBeLessThan(16)
        expect(figures.wholeSliceMs).toBeLessThanOrEqual(8)
    })
}
