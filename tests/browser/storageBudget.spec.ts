import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { charts, median, open, singleEdits, wholeEdits } from './flushBudget'

// The flush's budgets (Part 1 §1.9.3), on the generated large chart in CI and on coconut locally:
// IndexedDB growth per ordinary edit (median under 2 KB, §1.6.8.1), with the main thread's figures
// recorded (flushTiming.spec.ts asserts them, run alone), and createState and serializeToLevelData
// on the full pipeline. Figures go to the console and the test's annotations.

for (const chart of charts) {
    test(`IndexedDB growth per ordinary edit on the ${chart.name}`, async ({
        page,
        browserName,
    }, testInfo) => {
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
