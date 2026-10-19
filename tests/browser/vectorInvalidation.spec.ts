import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout} retained ranges match a fresh render after real chart edits`, async ({
        page,
    }, testInfo) => {
        await page.addInitScript(installCanvasCounters)
        await page.goto('/')
        await page.locator('canvas.editor-chart').waitFor()
        await page.evaluate(installEditorFixture)

        const results = await page.evaluate(async (layout) => {
            const { appImport, fixtures, history, settings, show, store, view, nextTick } =
                window.editorTest
            const { VectorRanges } = await appImport<
                typeof import('../../src/editor/canvas/vectorRanges')
            >('/src/editor/canvas/vectorRanges.ts')
            const { createTransaction } = await appImport<
                typeof import('../../src/state/transaction')
            >('/src/state/transaction.ts')
            const { replaceNote } = await appImport<
                typeof import('../../src/state/mutations/slides/note')
            >('/src/state/mutations/slides/note.ts')
            const { replaceBpm } = await appImport<typeof import('../../src/state/mutations/bpm')>(
                '/src/state/mutations/bpm.ts',
            )
            const { replaceStageTransformEventJoint } = await appImport<
                typeof import('../../src/state/mutations/events/stage/transform')
            >('/src/state/mutations/events/stage/transform.ts')
            const ranges = new Set<InstanceType<typeof VectorRanges>>()
            const originalBegin = VectorRanges.prototype.beginFrame
            VectorRanges.prototype.beginFrame = function (...args) {
                ranges.add(this)
                return originalBegin.apply(this, args)
            }
            try {
                settings.width = 30
                settings.pps = 100
                settings.showStageName = true
                settings.showGroupName = true
                settings.nameContrast = true
                show({ ...fixtures.events, slides: fixtures.connectors.slides }, 5)
                view.layout = layout
                // Keep active-name visibility stable throughout the comparisons.
                view.lastActive = performance.now() + 60_000
                view.cursorTime = 1000
                await document.fonts.ready
                const frame = async () => {
                    view.cursorTime++
                    await nextTick()
                    await new Promise<void>((resolve) =>
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                    )
                }
                await frame()
                await frame()
                const canvas = document.querySelector<HTMLCanvasElement>('canvas.editor-chart')!
                const ctx = window.editorRendering.getDrawContext(canvas)
                await ctx.ready
                const read = () => ctx.getImageData(0, 0, canvas.width, canvas.height).data
                const stats = () =>
                    [...ranges].reduce(
                        (total, { stats }) => ({
                            captures: total.captures + stats.captures,
                            replays: total.replays + stats.replays,
                        }),
                        { captures: 0, replays: 0 },
                    )
                const results: {
                    label: string
                    captures: number
                    replays: number
                    changedFromPrevious: number
                    changedChannels: number
                    maximumDelta: number
                }[] = []
                const compare = async (label: string, change: () => void) => {
                    const previous = read()
                    const before = stats()
                    change()
                    await frame()
                    const after = stats()
                    const retained = read()
                    // Rebuild all ranges in the same state, transform and renderer.
                    // This exact oracle isolates stale range reuse; it introduces
                    // no Canvas-vs-GPU or pan/antialiasing tolerance.
                    for (const range of ranges) range.clear()
                    await frame()
                    const fresh = read()
                    let changedChannels = 0
                    let changedFromPrevious = 0
                    let maximumDelta = 0
                    for (let i = 0; i < retained.length; i++) {
                        changedFromPrevious += +(retained[i] !== previous[i])
                        const delta = Math.abs(retained[i]! - fresh[i]!)
                        changedChannels += +(delta !== 0)
                        maximumDelta = Math.max(maximumDelta, delta)
                    }
                    results.push({
                        label,
                        captures: after.captures - before.captures,
                        replays: after.replays - before.replays,
                        changedFromPrevious,
                        changedChannels,
                        maximumDelta,
                    })
                }
                await compare('document metadata', () => {
                    history.replaceState({
                        ...history.state.value,
                        levelInfo: { ...history.state.value.levelInfo, title: 'renamed.json' },
                    })
                })
                const note = [...store.getAllEntities()].find(
                    (entity) =>
                        entity.type === 'note' &&
                        entity.beat >= 3 &&
                        entity.beat <= 12 &&
                        (history.state.value.store.slides.note.get(entity.slideId)?.length ?? 0) >
                            1,
                )
                if (note?.type !== 'note') throw new Error('Missing visible connector note')
                await compare('select note', () => {
                    history.replaceState({ ...history.state.value, selectedEntities: [note] })
                })
                await compare('move note', () => {
                    const transaction = createTransaction(history.state.value)
                    history.pushState(
                        window.editorTest.historySteps.nativeOperation(
                            {
                                id: 'nse.property.set',
                                data: {
                                    subject: 'note',
                                    targets: 1,
                                    assignments: [
                                        {
                                            field: 'left',
                                            value: { mode: 'uniform', value: note.left + 0.75 },
                                        },
                                    ],
                                },
                            },
                            'Move note',
                        ),
                        transaction.commit(
                            replaceNote(transaction, note, { ...note, left: note.left + 0.75 }),
                        ),
                    )
                })
                await compare('undo note', () => {
                    history.undoState()
                })
                await compare('redo note', () => {
                    history.redoState()
                })
                const event = [...store.getAllEntities()].find(
                    (entity) => entity.type === 'stageTransformEventJoint',
                )
                if (event?.type !== 'stageTransformEventJoint') throw new Error('Missing event')
                await compare('select event chain', () => {
                    history.replaceState({ ...history.state.value, selectedEntities: [event] })
                })
                await compare('stage event geometry', () => {
                    const transaction = createTransaction(history.state.value)
                    history.pushState(
                        window.editorTest.historySteps.nativeOperation(
                            {
                                id: 'nse.property.set',
                                data: {
                                    subject: 'stageTransformEvent',
                                    targets: 1,
                                    assignments: [
                                        {
                                            field: 'xTranslation',
                                            value: {
                                                mode: 'uniform',
                                                value: event.xTranslation + 1,
                                            },
                                        },
                                    ],
                                },
                            },
                            'Move stage',
                        ),
                        transaction.commit(
                            replaceStageTransformEventJoint(transaction, event, {
                                ...event,
                                xTranslation: event.xTranslation + 1,
                            }),
                        ),
                    )
                })
                await compare('stage name', () => {
                    const state = history.state.value
                    const stages = new Map(state.stages)
                    const [id, stage] = [...stages][0]!
                    stages.set(id, { ...stage, name: 'Renamed stage' })
                    history.replaceState({ ...state, stages })
                })
                await compare('group name', () => {
                    const state = history.state.value
                    const groups = new Map(state.groups)
                    for (const [id, group] of groups)
                        groups.set(id, { ...group, name: `Renamed ${group.name}` })
                    history.replaceState({ ...state, groups })
                })
                await compare('tempo', () => {
                    const bpm = [...store.getAllEntities()].find((entity) => entity.type === 'bpm')
                    if (bpm?.type !== 'bpm') throw new Error('Missing BPM')
                    const transaction = createTransaction(history.state.value)
                    history.pushState(
                        window.editorTest.historySteps.nativeOperation(
                            {
                                id: 'nse.property.set',
                                data: {
                                    subject: 'bpm',
                                    targets: 1,
                                    assignments: [
                                        { field: 'bpm', value: { mode: 'uniform', value: 150 } },
                                    ],
                                },
                            },
                            'Change tempo',
                        ),
                        transaction.commit(replaceBpm(transaction, bpm, { ...bpm, bpm: 150 })),
                    )
                })
                await compare('dynamic stages disabled', () => {
                    history.replaceState({ ...history.state.value, isDynamicStages: false })
                })
                return results
            } finally {
                VectorRanges.prototype.beginFrame = originalBegin
            }
        }, layout)

        await testInfo.attach('transition-results', {
            body: JSON.stringify(results, null, 2),
            contentType: 'application/json',
        })
        for (const result of results) {
            expect(result.changedChannels, JSON.stringify(result)).toBe(0)
            expect(result.maximumDelta, result.label).toBe(0)
        }
        const metadata = results.find(({ label }) => label === 'document metadata')!
        expect(metadata.captures).toBe(0)
        expect(metadata.replays).toBeGreaterThan(0)
        for (const label of ['move note', 'undo note', 'redo note']) {
            const result = results.find((result) => result.label === label)!
            expect(result.captures, label).toBeGreaterThan(0)
            expect(result.replays, label).toBeGreaterThan(0)
            expect(result.changedFromPrevious, label).toBeGreaterThan(0)
        }
        for (const label of ['stage event geometry', 'stage name', 'group name', 'tempo'])
            expect(
                results.find((result) => result.label === label)!.changedFromPrevious,
                label,
            ).toBeGreaterThan(0)
    })
}
