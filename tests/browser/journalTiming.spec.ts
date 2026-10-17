import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { charts, median, open } from './flushBudget'

// The journal's main-thread budgets (Part 1 §1.9.3, desktop): the write on hide (the whole
// state, level data gzipped at level 1) under 40 ms, and replay on load under 300 ms. In the
// timing project, run alone. Medians, so one garbage collection doesn't decide it.

for (const chart of charts) {
    test(`journal timing on the ${chart.name}`, async ({
        page,
        context,
        browserName,
    }, testInfo) => {
        test.skip(browserName !== 'chromium', 'Measured in Chromium')
        test.skip(chart.optional === true && !existsSync(chart.file), `${chart.file} is absent`)
        test.setTimeout(240_000)
        await open(page, chart.file, chart.optional === true)
        // Flushes held: each hide finds an entry not committed, so it writes.
        await page.evaluate(() => {
            window.nseFlushTest!.stall = true
        })
        for (let i = 0; i < 12; i++)
            await page.evaluate(async (i) => {
                const { history, appImport } = window.editorTest
                const { editSelectedEditableEntities } = await appImport<
                    typeof import('../../src/editor/sidebars/default')
                >('/src/editor/sidebars/default/index.ts')
                const notes = [...history.state.value.store.slides.note.values()]
                    .flat()
                    .filter((note) => !note.isAttached)
                const note = notes[(i * 7919) % notes.length]!
                history.replaceState({ ...history.state.value, selectedEntities: [note] })
                editSelectedEditableEntities({ size: note.size + (i % 2 ? -0.25 : 0.25) })
                history.replaceState({ ...history.state.value, selectedEntities: [] })
                // The hide's write: the whole state, as a trigger makes it.
                window.nseFlushTest!.journal.writer.write()
            }, i)
        // Today's auto save write of the same state, for comparison (§1.9.3).
        const autoSave = await page.evaluate(async () => {
            const { history, appImport } = window.editorTest
            const { serializeToLevelData } = await appImport<
                typeof import('../../src/levelData/serialize')
            >('/src/levelData/serialize.ts')
            const { serializeAutoSave } = await appImport<
                typeof import('../../src/history/autoSave/serialize')
            >('/src/history/autoSave/serialize.ts')
            const { serializeEditorMetadata } = await appImport<
                typeof import('../../src/levelData/editorMetadata')
            >('/src/levelData/editorMetadata.ts')
            const times: number[] = []
            for (let i = 0; i < 12; i++) {
                const start = performance.now()
                const s = history.liveState.value
                const levelData = serializeToLevelData(
                    s.initialLife,
                    s.isDynamicStages,
                    s.bgm.offset,
                    s.store,
                    s.groups,
                    s.stages,
                    { groups: s.groupFolders, stages: s.stageFolders },
                )
                const text = JSON.stringify(
                    serializeAutoSave(
                        levelData,
                        'level',
                        serializeEditorMetadata(levelData.entities, s.store),
                    ),
                )
                localStorage.setItem('timing.autoSave', text)
                times.push(performance.now() - start)
            }
            localStorage.removeItem('timing.autoSave')
            return times
        })
        const writes = await page.evaluate(() => window.nseFlushTest!.journal.writes)
        expect(writes.every((write) => write.verified)).toBe(true)
        const sessionId = writes[0]!.sessionId
        await page.close()

        const next = await context.newPage()
        await next.addInitScript(() => {
            sessionStorage.setItem('nse.test.storage', '{}')
        })
        await next.goto('/')
        await expect.poll(() => next.evaluate(() => window.nseJournalTest !== undefined)).toBe(true)
        const replay = await next.evaluate(() => window.nseJournalTest!)
        expect(replay.outcomes.map((outcome) => [outcome.sessionId, outcome.kind])).toContainEqual([
            sessionId,
            'applied',
        ])
        const figures = {
            chart: chart.name,
            writeMs: median(writes.map((write) => write.ms)),
            writeMaxMs: Math.max(...writes.map((write) => write.ms)),
            levelDataGzChars: writes[0]!.size,
            replayMs: replay.ms,
            replayParts: replay.outcomes.find((outcome) => outcome.sessionId === sessionId),
            autoSaveMs: median(autoSave),
        }
        console.log(JSON.stringify(figures))
        testInfo.annotations.push({ type: 'journal-timing', description: JSON.stringify(figures) })
        // The budget is coconut's; the generated chart, a little larger, is recorded against it.
        if (chart.optional) expect(figures.writeMs).toBeLessThan(40)
        // No slower than today's auto save write on hide, with a little room for noise.
        expect(figures.writeMs).toBeLessThan(figures.autoSaveMs * 1.25)
        expect(figures.replayMs).toBeLessThan(300)
    })
}
