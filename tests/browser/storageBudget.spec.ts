import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FlushReport } from '../../src/local/flush'
import { importLevelData, openEditor } from './memoryBaseline'

// The flush's budgets (Part 1 §1.9.3), on the generated large chart in CI and on coconut locally:
// IndexedDB growth per ordinary edit (median under 2 KB, §1.6.8.1), the main thread's share of a
// flush (a single-note edit under 2 ms; a whole-chart edit under 16 ms in slices of 8 ms at most),
// and createState and serializeToLevelData on the full pipeline. Figures go to the console and
// the test's annotations.

const charts = [
    { name: 'generated large chart', file: join('tests', 'fixtures', 'generated-large.json') },
    {
        name: 'coconut',
        file: join('test_level_data', 'coconut-next-sekai-24887.json'),
        optional: true,
    },
]

const median = (values: readonly number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Opens the editor with storing under the test flag, and imports the chart through Open. */
const open = async (page: Page, file: string, acknowledge: boolean) => {
    await page.addInitScript(() => {
        sessionStorage.setItem('nse.test.storage', '{}')
    })
    await openEditor(page)
    await expect.poll(() => page.evaluate(() => window.nseFlushTest !== undefined)).toBe(true)
    await importLevelData(page, 'level.json', readFileSync(file), acknowledge)
    await flushed(page)
}

/** Flushes everything pending, and returns the reports since `from`. */
const flushed = async (page: Page, from = 0) => {
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
const singleEdits = async (page: Page, n: number) => {
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
const wholeEdits = async (page: Page, n: number) => {
    const reports: FlushReport[] = []
    for (let i = 0; i < n; i++) {
        const from = await page.evaluate(() => window.nseFlushTest!.reports.length)
        await page.evaluate(async (i) => {
            const { history, store, appImport } = window.editorTest
            const { translateSelection } = await appImport<
                typeof import('../../src/state/operations/translateSelection')
            >('/src/state/operations/translateSelection.ts')
            const { isEditableEntity } = await appImport<
                typeof import('../../src/state/operations/editable')
            >('/src/state/operations/editable.ts')
            const all = [...store.getAllEntities()].filter(isEditableEntity)
            const before = history.state.value
            history.pushState(
                () => 'Move',
                translateSelection(before, all, 'width', i % 2 ? -0.25 : 0.25),
            )
        }, i)
        reports.push(...(await flushed(page, from)))
    }
    return reports
}

for (const chart of charts) {
    test(`a flush's budgets on the ${chart.name}`, async ({ page, browserName }, testInfo) => {
        test.skip(browserName !== 'chromium', 'Measured in Chromium')
        test.skip(chart.optional === true && !existsSync(chart.file), `${chart.file} is absent`)
        test.setTimeout(240_000)
        await open(page, chart.file, chart.optional === true)

        const singles = await singleEdits(page, 60)
        expect(singles.every((report) => report.entries === 1)).toBe(true)
        const wholes = await wholeEdits(page, 6)
        const errors = await page.evaluate(() => window.nseFlushTest!.errors.map(String))
        expect(errors).toEqual([])

        const perStore = (store: string) =>
            Math.round(median(singles.map((report) => report.stats.growthByStore[store] ?? 0)))
        const figures = {
            chart: chart.name,
            perEditBytes: median(singles.map((report) => report.stats.growth)),
            perEditWrittenBytes: median(singles.map((report) => report.stats.bytes)),
            perEditRows: median(singles.map((report) => report.stats.rows)),
            perEditByStore: Object.fromEntries(
                ['chunks', 'nodes', 'entries'].map((store) => [store, perStore(store)]),
            ),
            singleMainMs: median(singles.map((report) => report.mainMs)),
            wholeBytes: Math.max(...wholes.map((report) => report.stats.growth)),
            wholeMainMs: median(wholes.map((report) => report.mainMs)),
            wholeMaxSliceMs: Math.max(...wholes.flatMap((report) => report.slices)),
        }
        console.log(JSON.stringify(figures))
        testInfo.annotations.push({ type: 'flush-budget', description: JSON.stringify(figures) })

        // IndexedDB growth per ordinary edit (§1.9.3).
        expect(figures.perEditBytes).toBeLessThan(2048)
        // The main thread's share (desktop budgets).
        expect(figures.singleMainMs).toBeLessThan(2)
        expect(figures.wholeMainMs).toBeLessThan(16)
        expect(figures.wholeMaxSliceMs).toBeLessThanOrEqual(8)
    })

    test(`createState and serializeToLevelData on the full pipeline, on the ${chart.name}`, async ({
        page,
        browserName,
    }, testInfo) => {
        test.skip(browserName !== 'chromium', 'Measured in Chromium')
        test.skip(chart.optional === true && !existsSync(chart.file), `${chart.file} is absent`)
        test.setTimeout(120_000)
        await open(page, chart.file, chart.optional === true)
        const figures = await page.evaluate(async () => {
            const { appImport } = window.editorTest
            const { decodeSnapshot } = await appImport<
                typeof import('../../src/local/records/snapshot')
            >('/src/local/records/snapshot.ts')
            const { fromRecords } = await appImport<
                typeof import('../../src/local/records/records')
            >('/src/local/records/records.ts')
            const { createState } =
                await appImport<typeof import('../../src/state')>('/src/state/index.ts')
            const { serializeToLevelData } = await appImport<
                typeof import('../../src/levelData/serialize')
            >('/src/levelData/serialize.ts')
            const worker = window.nseStorageTest!.worker
            const { entries } = (await worker.call('testRows', ['entries'])) as unknown as {
                entries: { value: { sessionId: string; seq: number; snapshot: Uint8Array } }[]
            }
            // The imported chart's session: the blank one before it may be stored too.
            const sessionId = window.nseFlushTest!.flusher.session!.id
            const own = entries
                .filter(({ value }) => value.sessionId === sessionId)
                .sort((a, b) => a.value.seq - b.value.seq)
            const hex = [...own.at(-1)!.value.snapshot]
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('')
            // The stored snapshot, as the worker reads it back.
            const parts = await worker.call('readSnapshot', hex)
            const time = (fn: () => void) => {
                const start = performance.now()
                fn()
                return performance.now() - start
            }
            const decode: number[] = []
            const create: number[] = []
            const serialize: number[] = []
            for (let i = 0; i < 5; i++) {
                let records!: ReturnType<typeof decodeSnapshot>
                decode.push(
                    time(() => {
                        records = decodeSnapshot(parts.root, {
                            node: (h) => parts.nodes[h],
                            chunk: (h) => parts.chunks[h],
                        })
                    }),
                )
                let state!: ReturnType<typeof createState>
                create.push(
                    time(() => {
                        const { chart, offset, levelInfo, bgm } = fromRecords(records)
                        state = createState(chart, offset, { levelInfo, ...(bgm ? { bgm } : {}) })
                    }),
                )
                serialize.push(
                    time(() => {
                        serializeToLevelData(
                            state.initialLife,
                            state.isDynamicStages,
                            state.bgm.offset,
                            state.store,
                            state.groups,
                            state.stages,
                            { groups: state.groupFolders, stages: state.stageFolders },
                        )
                    }),
                )
            }
            // The decoded snapshot's own note count, so a wrong snapshot shows.
            const notes = (parts.root as unknown[])[3] as number
            return { notes, decode, create, serialize }
        })
        const summary = {
            chart: chart.name,
            notes: figures.notes,
            decodeMs: median(figures.decode),
            createStateMs: median(figures.create),
            createStateFirstMs: figures.create[0],
            serializeToLevelDataMs: median(figures.serialize),
        }
        console.log(JSON.stringify(summary))
        testInfo.annotations.push({ type: 'pipeline', description: JSON.stringify(summary) })
        expect(summary.notes).toBeGreaterThan(1000)
        expect(summary.createStateMs).toBeGreaterThan(0)
    })
}
