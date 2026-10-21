import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    editCount,
    importLevelData,
    makeEdits,
    measureHeap,
    openEditor,
    wholeChartEditCount,
} from './memoryBaseline'

// Chromium only: the heap comes from CDP. Memory after the edits, with storing on and every entry
// flushed, stays within 12% of Step 0's baseline (§1.9.1, §1.9.3): 133.1 MB on the generated
// chart and 131.8 MB on coconut, measured on `main` before any Step 3 code.
const MB = 1_000_000
const charts = [
    {
        name: 'generated large chart',
        file: join('tests', 'fixtures', 'generated-large.json'),
        baselineMb: 133.1,
    },
    {
        name: 'coconut',
        file: join('test_level_data', 'coconut-next-sekai-24887.json'),
        optional: true,
        baselineMb: 131.8,
    },
]

/** Waits until storing has flushed every entry. */
const flushed = (page: Page) =>
    expect
        .poll(
            () =>
                page.evaluate(async () => {
                    const { flusher } =
                        await window.editorTest.appImport<typeof import('../../src/local/storing')>(
                            '/src/local/storing.ts',
                        )
                    if (!flusher) return false
                    await flusher.flush()
                    return !flusher.hasPending && !flusher.failed
                }),
            { timeout: 120_000 },
        )
        .toBe(true)

for (const chart of charts) {
    test(`memory after ${editCount} edits including ${wholeChartEditCount} whole-chart edits on the ${chart.name}`, async ({
        page,
        browserName,
    }, testInfo) => {
        test.skip(browserName !== 'chromium', 'The heap is measured through CDP')
        test.skip(chart.optional === true && !existsSync(chart.file), `${chart.file} is absent`)
        test.setTimeout(240_000)

        await openEditor(page)
        await importLevelData(page, 'level.json', readFileSync(chart.file), chart.optional)
        const notes = await page.evaluate(
            () =>
                [...window.editorTest.history.state.value.store.slides.note.values()].flat().length,
        )
        expect(notes).toBeGreaterThan(1000)

        await flushed(page)
        const imported = await measureHeap(page)
        const edits = await makeEdits(page)
        expect(edits.whole).toBe(wholeChartEditCount)
        expect(edits.single).toBe(editCount - wholeChartEditCount)
        await flushed(page)
        const heap = await measureHeap(page)

        const figure = { chart: chart.name, importedBytes: imported, afterEditsBytes: heap }
        console.log(
            `${chart.name}: heap ${imported} bytes after import, ${heap} bytes after ${editCount} edits (${(edits.ms / 1000).toFixed(1)} s)`,
        )
        testInfo.annotations.push({ type: 'heap-bytes', description: String(heap) })
        await testInfo.attach('heap.json', {
            body: JSON.stringify({ ...figure, editsMs: edits.ms }),
            contentType: 'application/json',
        })
        // 12% (owner, 2026-10-21): the History and Save work grew the heap by about 11.8%.
        expect(heap / MB).toBeGreaterThanOrEqual(chart.baselineMb * 0.9)
        expect(heap / MB).toBeLessThanOrEqual(chart.baselineMb * 1.12)
    })
}
