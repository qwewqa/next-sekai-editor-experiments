import { expect, test } from '@playwright/test'
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

// Chromium only: the heap comes from CDP. Step 3a adds the "within 10% of today" assertion.
const charts = [
    { name: 'generated large chart', file: join('tests', 'fixtures', 'generated-large.json') },
    {
        name: 'coconut',
        file: join('test_level_data', 'coconut-next-sekai-24887.json'),
        optional: true,
    },
]

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

        const imported = await measureHeap(page)
        const edits = await makeEdits(page)
        expect(edits.whole).toBe(wholeChartEditCount)
        expect(edits.single).toBe(editCount - wholeChartEditCount)
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
        expect(heap).toBeGreaterThan(0)
    })
}
