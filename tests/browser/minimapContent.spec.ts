import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { importLevelData, openEditor } from './memoryBaseline'

// The minimap's content pipeline, driven on detached canvases with the app's real state and
// history (design §13.2). The strip itself is not mounted here.

// Coconut is local-only (never committed); CI runs the committed generated chart instead.
const coconutPath = 'test_level_data/coconut-next-sekai-24887.json'
const hasCoconut = existsSync(coconutPath)
const coconut = readFileSync(hasCoconut ? coconutPath : 'tests/fixtures/generated-large.json')

test.beforeEach(async ({ page }) => {
    await openEditor(page)
})

/** Installs the helpers every case shares on `window`, in the app's own module instances. */
const installHarness = (page: Page) =>
    page.evaluate(async () => {
        const { appImport } = window.editorTest
        const pipelineModule = await appImport<typeof import('../../src/editor/minimap/pipeline')>(
            '/src/editor/minimap/pipeline.ts',
        )
        const history = await appImport<typeof import('../../src/history')>('/src/history/index.ts')
        const { createTransaction } = await appImport<typeof import('../../src/state/transaction')>(
            '/src/state/transaction.ts',
        )
        const slideNotes = await appImport<typeof import('../../src/state/mutations/slides/note')>(
            '/src/state/mutations/slides/note.ts',
        )
        const bpmMutations = await appImport<typeof import('../../src/state/mutations/bpm')>(
            '/src/state/mutations/bpm.ts',
        )
        const { createSlideId } = await appImport<typeof import('../../src/state/entities/slides')>(
            '/src/state/entities/slides/index.ts',
        )
        const { view } = window.editorTest

        const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
        const sources = () => ({
            shown: history.state.value,
            live: history.liveState.value,
            peeking: history.isPeeking.value,
        })
        const idle = async (pipeline: { isIdle: () => boolean }) => {
            for (let i = 0; i < 1200; i++) {
                await frame()
                if (pipeline.isIdle()) return
            }
            throw new Error('The pipeline never went idle')
        }
        const create = async (width = 48, height = 600, ratio = 2) => {
            const canvas = document.createElement('canvas')
            const pipeline = pipelineModule.createMinimapPipeline(canvas)
            pipeline.setGeometry(width, height, ratio)
            pipeline.setSources(sources())
            await idle(pipeline)
            return { canvas, pipeline }
        }
        const pixels = (canvas: HTMLCanvasElement) =>
            canvas
                .getContext('2d', { willReadFrequently: true })
                ?.getImageData(0, 0, canvas.width, canvas.height).data
        /** The pixels that differ between two canvases: how many, and the first few. */
        const compare = (a: HTMLCanvasElement, b: HTMLCanvasElement) => {
            const left = pixels(a)
            const right = pixels(b)
            if (!left || !right || a.width !== b.width || a.height !== b.height)
                return { size: false, differing: -1, drawn: 0, first: [] as string[] }
            let differing = 0
            let drawn = 0
            const first: string[] = []
            for (let i = 0; i < left.length; i += 4) {
                if (left[i + 3]) drawn++
                if (
                    left[i] !== right[i] ||
                    left[i + 1] !== right[i + 1] ||
                    left[i + 2] !== right[i + 2] ||
                    left[i + 3] !== right[i + 3]
                ) {
                    differing++
                    if (first.length < 6) {
                        const p = i / 4
                        first.push(
                            `(${p % a.width},${Math.floor(p / a.width)}) ${[...left.slice(i, i + 4)]} vs ${[...right.slice(i, i + 4)]}`,
                        )
                    }
                }
            }
            return { size: true, differing, drawn, first }
        }
        /** Edits the chart through a real transaction and pushes it as a History step. */
        const edit = (change: (transaction: ReturnType<typeof createTransaction>) => void) => {
            const transaction = createTransaction(history.state.value)
            change(transaction)
            history.pushState(window.editorTest.historySteps.noteAdd(1), transaction.commit([]))
        }
        window.minimapHarness = {
            pipelineModule,
            history,
            slideNotes,
            bpmMutations,
            createSlideId,
            view,
            frame,
            idle,
            create,
            compare,
            edit,
            sources,
        }
    })

declare global {
    interface Window {
        minimapHarness: {
            pipelineModule: typeof import('../../src/editor/minimap/pipeline')
            history: typeof import('../../src/history')
            slideNotes: typeof import('../../src/state/mutations/slides/note')
            bpmMutations: typeof import('../../src/state/mutations/bpm')
            createSlideId: typeof import('../../src/state/entities/slides').createSlideId
            view: (typeof import('../../src/editor/view'))['view']
            frame: () => Promise<number>
            idle: (pipeline: { isIdle: () => boolean }) => Promise<void>
            create: (
                width?: number,
                height?: number,
                ratio?: number,
            ) => Promise<{
                canvas: HTMLCanvasElement
                pipeline: import('../../src/editor/minimap/pipeline').MinimapPipeline
            }>
            compare: (
                a: HTMLCanvasElement,
                b: HTMLCanvasElement,
            ) => { size: boolean; differing: number; drawn: number; first: string[] }
            edit: (
                change: (
                    transaction: ReturnType<
                        typeof import('../../src/state/transaction').createTransaction
                    >,
                ) => void,
            ) => void
            sources: () => import('../../src/editor/minimap/pipeline').MinimapSources
        }
    }
}

test('incremental redraws equal a full redraw after a move, an Undo, a slide edit and a guide', async ({
    page,
}) => {
    await installHarness(page)
    const steps = await page.evaluate(async () => {
        const h = window.minimapHarness
        const { fixtures, show } = window.editorTest
        const { minimapStats } = h.pipelineModule
        // Every connector ease, guides, damage and fake bodies, plus single notes to move.
        const single = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.connectors,
                slides: [
                    ...fixtures.connectors.slides,
                    [{ ...single, beat: 5, left: -2 }],
                    [{ ...single, beat: 5.5, left: 3, isFake: true }],
                    [{ ...single, beat: 9, left: -14 }],
                    [{ ...single, beat: 21, left: 17 }],
                ],
            },
            5,
        )
        const { canvas, pipeline } = await h.create()
        const results: Record<string, unknown> = {}
        const check = async (name: string, change: () => void) => {
            const before = { ...minimapStats }
            change()
            pipeline.setSources(h.sources())
            await h.idle(pipeline)
            const after = { ...minimapStats }
            const full = await h.create()
            results[name] = {
                ...h.compare(canvas, full.canvas),
                bands: after.bandPasses - before.bandPasses,
                fullJobs: after.fullJobs - before.fullJobs,
            }
            full.pipeline.dispose()
        }
        const noteAt = (beat: number) =>
            [...h.history.state.value.store.slides.note.values()]
                .flat()
                .find((note) => note.beat === beat)!

        await check('move', () =>
            h.edit((transaction) => {
                const note = noteAt(5)
                h.slideNotes.replaceNote(transaction, note, { ...note, beat: 12.25, left: 1 })
            }),
        )
        await check('undo', () => {
            h.history.undoState()
        })
        await check('redo', () => {
            h.history.redoState()
        })
        await check('slide', () =>
            h.edit((transaction) => {
                // The middle note of an active slide: its whole body is rebuilt.
                const middle = [...h.history.state.value.store.slides.note.values()].find(
                    (notes) => notes.length === 3 && notes[0]?.beat === 1,
                )![1]!
                h.slideNotes.replaceNote(transaction, middle, { ...middle, left: middle.left + 3 })
            }),
        )
        await check('guide', () =>
            h.edit((transaction) => {
                const slideId = h.createSlideId()
                const guide = {
                    ...fixtures.connectors.slides[0]![0]!,
                    noteType: 'anchor' as const,
                    connectorType: 'guide' as const,
                    connectorGuideAlpha: 1,
                    connectorStyle: 'red' as const,
                    left: -9,
                    size: 3,
                }
                h.slideNotes.addNote(transaction, slideId, { ...guide, beat: 0.5 })
                h.slideNotes.addNote(transaction, slideId, { ...guide, beat: 6.5, left: -7 })
            }),
        )
        await check('remove', () =>
            h.edit((transaction) => h.slideNotes.removeNote(transaction, noteAt(9))),
        )
        pipeline.dispose()
        return results
    })
    for (const [name, step] of Object.entries(steps)) {
        const { differing, drawn, first, size, bands, fullJobs } = step as {
            differing: number
            drawn: number
            first: string[]
            size: boolean
            bands: number
            fullJobs: number
        }
        expect(size, name).toBe(true)
        expect(drawn, `${name} draws something`).toBeGreaterThan(500)
        expect(differing, `${name}: ${first.join('; ')}`).toBe(0)
        // The edit went through bands, not through a full redraw that trivially matches.
        expect(bands, `${name} bands`).toBe(1)
        expect(fullJobs, `${name} full jobs`).toBe(0)
    }
})

for (const layout of ['basic', 'composed'] as const)
    test(`incremental redraws equal a full redraw on an imported chart in ${layout}`, async ({
        page,
    }) => {
        test.setTimeout(120_000)
        await importLevelData(page, 'coconut.json', coconut, hasCoconut)
        await installHarness(page)
        const result = await page.evaluate(async (layout) => {
            const h = window.minimapHarness
            h.view.layout = layout
            const { canvas, pipeline } = await h.create(40, 780, 2)
            const notes = () =>
                [...h.history.state.value.store.slides.note.values()]
                    .flat()
                    .filter((note) => note.noteType === 'default')
            const target = notes()[Math.floor(notes().length / 2)]!
            const { minimapStats } = h.pipelineModule
            const before = { ...minimapStats }
            h.edit((transaction) =>
                h.slideNotes.replaceNote(transaction, target, {
                    ...target,
                    beat: target.beat + 3,
                    left: target.left + 1,
                }),
            )
            pipeline.setSources(h.sources())
            await h.idle(pipeline)
            const bands = minimapStats.bandPasses - before.bandPasses
            const fullJobs = minimapStats.fullJobs - before.fullJobs
            const full = await h.create(40, 780, 2)
            const move = h.compare(canvas, full.canvas)
            full.pipeline.dispose()
            h.history.undoState()
            pipeline.setSources(h.sources())
            await h.idle(pipeline)
            const again = await h.create(40, 780, 2)
            const undo = h.compare(canvas, again.canvas)
            again.pipeline.dispose()
            pipeline.dispose()
            return { move, undo, bands, fullJobs }
        }, layout)
        for (const name of ['move', 'undo'] as const) {
            const { differing, first, drawn } = result[name]
            expect(drawn, name).toBeGreaterThan(1000)
            expect(differing, `${name}: ${first.join('; ')}`).toBe(0)
        }
        // The note's slide may carry a long body; a band redraw or a full one are both right.
        expect(result.bands + result.fullJobs).toBe(1)
    })

test('a BPM halving at beat 0 doubles the end', async ({ page }) => {
    await installHarness(page)
    const result = await page.evaluate(async () => {
        const h = window.minimapHarness
        const { fixtures, show } = window.editorTest
        const single = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                bpms: [{ beat: 0, bpm: 60 }],
                slides: [[{ ...single, beat: 100, left: 0 }]],
            },
            5,
        )
        const { minimapStats } = h.pipelineModule
        const { pipeline } = await h.create()
        const gridBefore = h.history.state.value.store.grid.note
        const endBefore = minimapStats.end
        const fullBefore = minimapStats.fullJobs
        h.edit((transaction) => {
            const bpm = [...(h.history.state.value.store.grid.bpm.get(0) ?? [])][0]!
            h.bpmMutations.replaceBpm(transaction, bpm, { beat: 0, bpm: 30 })
        })
        const gridKept = h.history.state.value.store.grid.note === gridBefore
        pipeline.setSources(h.sources())
        await h.idle(pipeline)
        const result = {
            endBefore,
            endAfter: minimapStats.end,
            gridKept,
            full: minimapStats.fullJobs - fullBefore,
        }
        pipeline.dispose()
        return result
    })
    // The note grid is untouched, yet the last note moved from 100 s to 200 s.
    expect(result.gridKept).toBe(true)
    expect(result.endBefore).toBe(102)
    expect(result.endAfter).toBe(204)
    expect(result.full).toBe(1)
})

test('a resize keeps the old image until the new one is ready, and dispose frees the canvases', async ({
    page,
}) => {
    await installHarness(page)
    const result = await page.evaluate(async () => {
        const h = window.minimapHarness
        const { fixtures, show } = window.editorTest
        show(fixtures.connectors, 5)
        const { canvas, pipeline } = await h.create(48, 600, 2)
        const first = { width: canvas.width, height: canvas.height }
        const jobs = h.pipelineModule.minimapStats.fullJobs
        pipeline.setGeometry(40, 500, 1)
        // The debounce has not run: nothing is redrawn or resized yet.
        const during = { width: canvas.width, height: canvas.height }
        const mappingNow = pipeline.mapping.value?.geometry
        await h.idle(pipeline)
        const after = { width: canvas.width, height: canvas.height }
        const jobsAfter = h.pipelineModule.minimapStats.fullJobs - jobs
        // A device pixel ratio above 2 is capped, and a tall canvas keeps its rows within 4096.
        pipeline.setGeometry(40, 3000, 3)
        await h.idle(pipeline)
        const tall = { width: canvas.width, height: canvas.height }
        pipeline.dispose()
        return {
            first,
            during,
            mappingNow,
            after,
            jobsAfter,
            tall,
            freed: { width: canvas.width, height: canvas.height },
        }
    })
    expect(result.first).toEqual({ width: 96, height: 1200 })
    expect(result.during).toEqual(result.first)
    expect(result.mappingNow).toMatchObject({ width: 40, height: 500 })
    expect(result.after).toEqual({ width: 40, height: 500 })
    expect(result.jobsAfter).toBe(1)
    expect(result.tall.height).toBeLessThanOrEqual(4096)
    expect(result.freed).toEqual({ width: 0, height: 0 })
})

test('the content hook follows edits, ignores selection changes and stops with its scope', async ({
    page,
}) => {
    await installHarness(page)
    const result = await page.evaluate(async () => {
        const h = window.minimapHarness
        const { fixtures, show, appImport } = window.editorTest
        const { mountMinimapContent } = await appImport<typeof import('../helpers/minimapContent')>(
            '/tests/helpers/minimapContent.ts',
        )
        const { minimapStats } = h.pipelineModule
        const single = fixtures.interaction.slides[0]![0]!
        show({ ...fixtures.connectors, slides: [[{ ...single, beat: 5, left: -2 }]] }, 5)
        const canvas = document.createElement('canvas')
        canvas.style.cssText = 'position:fixed;left:0;top:0;width:40px;height:500px;opacity:0'
        document.body.append(canvas)
        const until = async (done: () => boolean) => {
            for (let i = 0; i < 600 && !done(); i++) await h.frame()
            return done()
        }
        const mounted = mountMinimapContent(canvas)
        const first = await until(() => !!mounted.mapping.value)
        const geometry = mounted.mapping.value?.geometry
        const settle = async () => {
            // Two frames: a pass, then anything it schedules.
            await h.frame()
            await h.frame()
        }
        await settle()
        const base = { ...minimapStats }
        // A selection change replaces the state but no watched identity.
        const note = [...h.history.state.value.store.slides.note.values()].flat()[0]!
        h.history.replaceState({ ...h.history.state.value, selectedEntities: [note] })
        await settle()
        const afterSelection = { ...minimapStats }
        h.edit((transaction) => {
            h.slideNotes.replaceNote(transaction, note, { ...note, beat: 8 })
        })
        const painted = await until(() => minimapStats.paints > afterSelection.paints)
        const afterEdit = { ...minimapStats }
        mounted.unmount()
        await settle()
        h.edit((transaction) => {
            const moved = [...h.history.state.value.store.slides.note.values()].flat()[0]!
            h.slideNotes.replaceNote(transaction, moved, { ...moved, beat: 9 })
        })
        await settle()
        const afterUnmount = { ...minimapStats }
        const freed = { width: canvas.width, height: canvas.height }
        canvas.remove()
        return {
            first,
            geometry,
            selectionPasses: afterSelection.passes - base.passes,
            selectionPaints: afterSelection.paints - base.paints,
            painted,
            bands: afterEdit.bandPasses - afterSelection.bandPasses,
            paintsAfterUnmount: afterUnmount.paints - afterEdit.paints,
            passesAfterUnmount: afterUnmount.passes - afterEdit.passes,
            freed,
        }
    })
    expect(result.first).toBe(true)
    expect(result.geometry).toMatchObject({ width: 40, height: 500 })
    // A selection change touches none of the watched identities.
    expect(result.selectionPasses).toBe(0)
    expect(result.selectionPaints).toBe(0)
    expect(result.painted).toBe(true)
    expect(result.bands).toBe(1)
    // Hidden means free: nothing runs after the scope stops.
    expect(result.passesAfterUnmount).toBe(0)
    expect(result.paintsAfterUnmount).toBe(0)
    expect(result.freed).toEqual({ width: 0, height: 0 })
})
