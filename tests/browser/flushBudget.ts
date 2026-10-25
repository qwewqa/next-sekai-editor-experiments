import { expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FlushReport } from '../../src/local/flush'
import { importLevelData, openEditor } from './memoryBaseline'

// The flush budget specs' charts and edits: the generated large chart in CI and
// coconut locally, edits flushed one at a time, and the flusher's reports.

export const charts = [
    { name: 'generated large chart', file: join('tests', 'fixtures', 'generated-large.json') },
    {
        name: 'coconut',
        file: join('test_level_data', 'coconut-next-sekai-24887.json'),
        optional: true,
    },
]

export const median = (values: readonly number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Opens the editor with storing under the test flag, and imports the chart through Open. */
export const open = async (page: Page, file: string, acknowledge: boolean) => {
    await page.addInitScript(() => {
        sessionStorage.setItem('nse.test.storage', '{}')
    })
    await openEditor(page)
    await expect.poll(() => page.evaluate(() => window.nseStartupTest !== undefined)).toBe(true)
    await importLevelData(page, 'level.json', readFileSync(file), acknowledge)
    await flushed(page)
}

/** Flushes everything pending, and returns the reports since `from`. */
export const flushed = async (page: Page, from = 0) => {
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const test = window.nseFlushTest!
                await test.flusher.flush()
                return !test.flusher.hasPending
            }),
        )
        .toBe(true)
    return page.evaluate((from) => window.nseFlushTest!.reports.slice(from), from) as Promise<
        FlushReport[]
    >
}

/** n single-property edits on one note each, each flushed on its own. */
export const singleEdits = async (page: Page, n: number) => {
    const reports: FlushReport[] = []
    for (let i = 0; i < n; i++) {
        const from = await page.evaluate(() => window.nseFlushTest!.reports.length)
        await page.evaluate(async (i) => {
            const { history, appImport } = window.editorTest
            const { editSelectedEditableEntities } = await appImport<
                typeof import('../../src/editor/sidebars/default')
            >('/src/editor/sidebars/default/index.ts')
            const notes = [...history.state.value.store.slides.note.values()]
                .flat()
                .filter((note) => !note.isAttached)
            const before = history.state.value
            for (let tries = 0; ; tries++) {
                if (tries > 20) throw new Error('No note accepted an edit')
                const note = notes[(i * 7919 + tries * 104729) % notes.length]!
                history.replaceState({ ...history.state.value, selectedEntities: [note] })
                editSelectedEditableEntities({ size: note.size + (i % 2 ? -0.25 : 0.25) })
                if (history.state.value !== before) break
            }
            history.replaceState({ ...history.state.value, selectedEntities: [] })
        }, i)
        reports.push(...(await flushed(page, from)))
    }
    return reports
}

/** n whole-chart edits (everything moved a quarter lane), each flushed on its own. */
export const wholeEdits = async (page: Page, n: number) => {
    const reports: FlushReport[] = []
    for (let i = 0; i < n; i++) {
        const from = await page.evaluate(() => window.nseFlushTest!.reports.length)
        await page.evaluate(async (i) => {
            const { history, store, appImport } = window.editorTest
            const { translateSelectionWithReceipt } = await appImport<
                typeof import('../../src/state/operations/translateSelection')
            >('/src/state/operations/translateSelection.ts')
            const { subjectOfCounts } = await appImport<
                typeof import('../../src/history/operations')
            >('/src/history/operations/index.ts')
            const { isEditableEntity } = await appImport<
                typeof import('../../src/state/operations/editable')
            >('/src/state/operations/editable.ts')
            const all = [...store.getAllEntities()].filter(isEditableEntity)
            const before = history.state.value
            const moved = translateSelectionWithReceipt(before, all, 'width', i % 2 ? -0.25 : 0.25)
            history.pushState(
                window.editorTest.historySteps.nativeOperation(
                    {
                        id: 'nse.object.move',
                        data: { subject: subjectOfCounts(moved.counts), changed: moved.counts },
                    },
                    'Move',
                ),
                moved.state,
            )
        }, i)
        reports.push(...(await flushed(page, from)))
    }
    return reports
}
