import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// Property tests over seeded random charts and selections that run the real Select move
// (`moveEntities`) and the real Scale session, rather than a stand-in for them. The receipt's
// `displaced` is checked against an independent oracle: the objects that were in the chart, were
// not moved by the action, and are not in the result. So it can never name a moved operand,
// and it names exactly what left the chart. (A selected initial BPM pinned by a move toward
// beat 0 is no operand: another BPM landing on it displaces it.) `retainedInitialBpm` can only be set when the initial BPM
// was selected and a BPM is back at beat 0.

type Outcome = {
    failures: string[]
    cases: number
    pushed: number
    withDisplaced: number
    withRetained: number
}

const run = (page: Page, mode: 'move' | 'scale', seeds: number): Promise<Outcome> =>
    page.evaluate(
        async ({ mode, seeds }) => {
            const { fixtures, show, history, appImport, view } = window.editorTest
            // Whole beats, so scaled objects snap onto each other and collide.
            view.division = 1
            const select = await appImport<typeof import('../../src/editor/tools/select')>(
                '/src/editor/tools/select.ts',
            )
            const session = await appImport<
                typeof import('../../src/editor/commands/scaleSelection/session')
            >('/src/editor/commands/scaleSelection/session.ts')
            const preview =
                await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
            const receipts = await appImport<
                typeof import('../../src/state/operations/historyReceipts')
            >('/src/state/operations/historyReceipts.ts')
            const { createHistoryOperation } = await appImport<
                typeof import('../../src/history/createHistoryOperation')
            >('/src/history/createHistoryOperation.ts')
            const { decodeOperation } = await appImport<
                typeof import('../../src/history/operations')
            >('/src/history/operations/index.ts')
            type State = typeof history.state.value
            type Entity = State['selectedEntities'][number]

            const random = (seed: number) => {
                let a = seed >>> 0
                return () => {
                    a = (a + 0x6d2b79f5) >>> 0
                    let t = a
                    t = Math.imul(t ^ (t >>> 15), t | 1)
                    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
                    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
                }
            }
            const beats = [0, 1, 2, 3, 4, 6, 8]
            const nativeTypes = [
                'bpm',
                'timeScale',
                'cameraEventJoint',
                'stageMaskEventJoint',
                'stagePivotEventJoint',
                'stageStyleEventJoint',
                'stageTransformEventJoint',
            ] as const
            const allNative = (state: State) => {
                const all = new Set<Entity>()
                for (const notes of state.store.slides.note.values())
                    for (const note of notes) all.add(note)
                for (const type of nativeTypes)
                    for (const bucket of state.store.grid[type].values())
                        for (const entity of bucket) all.add(entity)
                return all
            }
            const sorted = (counts: object) =>
                JSON.stringify(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)))

            const outcome: Outcome = {
                failures: [],
                cases: 0,
                pushed: 0,
                withDisplaced: 0,
                withRetained: 0,
            }
            for (let seed = 0; seed < seeds; seed++) {
                const rand = random(seed + (mode === 'move' ? 7000 : 9000))
                const int = (max: number) => Math.floor(rand() * (max + 1))
                const pick = <T>(items: readonly T[]) => items[int(items.length - 1)]!
                const chance = (p: number) => rand() < p
                const events = fixtures.events
                const note = fixtures.interaction.slides[0]![0]!
                const chart = {
                    ...events,
                    bpms: [
                        { beat: 0, bpm: 120 },
                        ...beats
                            .slice(1)
                            .flatMap((beat) => (chance(0.25) ? [{ beat, bpm: 90 + int(60) }] : [])),
                    ],
                    timeScales: [1, 2].flatMap((groupId) =>
                        beats.flatMap((beat) =>
                            chance(0.3)
                                ? [
                                      {
                                          ...events.timeScales[0]!,
                                          groupId: groupId as never,
                                          beat,
                                          timeScale: 1 + int(3),
                                      },
                                  ]
                                : [],
                        ),
                    ),
                    cameraEvents: beats.flatMap((beat) =>
                        chance(0.25) ? [{ ...events.cameraEvents[0]!, beat }] : [],
                    ),
                    stageMaskEvents: beats.flatMap((beat) =>
                        chance(0.25) ? [{ ...events.stageMaskEvents[0]!, beat }] : [],
                    ),
                    stagePivotEvents: beats.flatMap((beat) =>
                        chance(0.25) ? [{ ...events.stagePivotEvents[0]!, beat }] : [],
                    ),
                    stageStyleEvents: beats.flatMap((beat) =>
                        chance(0.25) ? [{ ...events.stageStyleEvents[0]!, beat }] : [],
                    ),
                    stageTransformEvents: beats.flatMap((beat) =>
                        chance(0.25) ? [{ ...events.stageTransformEvents[0]!, beat }] : [],
                    ),
                    slides: Array.from({ length: int(3) + 1 }, () => [
                        {
                            ...note,
                            beat: pick(beats),
                            left: int(8) - 4,
                            isAttached: false,
                            groupId: 1 as never,
                            stageId: 1 as never,
                        },
                    ]),
                }
                const label = `${mode} seed ${seed}`
                try {
                    show(chart)
                    const pool = [...allNative(history.state.value)]
                    const selected = pool.filter(() => chance(0.55))
                    if (!selected.length) selected.push(pool[int(pool.length - 1)]!)
                    history.replaceState({ ...history.state.value, selectedEntities: selected })
                    const source = history.state.value
                    const selectedSet = new Set(selected)

                    let result: State
                    let data: Record<string, unknown>
                    // Selected objects the action moved, which it never calls displaced.
                    let operands = selectedSet
                    if (mode === 'move') {
                        const focus = pick(selected)
                        const active = {
                            type: 'move' as const,
                            lane: 0,
                            focus,
                            entities: [...selected],
                            onlyType: undefined,
                            pressBeat: focus.beat,
                        }
                        // Like the tool: nothing moves before beat 0.
                        const earliest = Math.min(
                            ...selected
                                .filter((entity) => !(entity.type === 'bpm' && !entity.beat))
                                .map((entity) => entity.beat),
                        )
                        let beatOffset = pick([-4, -2, -1, 1, 2, 3, 5])
                        if (Number.isFinite(earliest)) beatOffset = Math.max(beatOffset, -earliest)
                        if (!beatOffset) continue
                        if (beatOffset < 0)
                            operands = new Set(
                                selected.filter(
                                    (entity) => !(entity.type === 'bpm' && !entity.beat),
                                ),
                            )
                        const { plan, rawMove } = select.planMove(source, active, 0, beatOffset)
                        const moved = select.moveEntities(
                            source,
                            active,
                            0,
                            beatOffset,
                            plan,
                            rawMove,
                        )
                        result = moved.state
                        // The codec accepts it, as `createHistoryOperation` throws when it does not.
                        data = createHistoryOperation(moved.operation).data as never
                    } else {
                        if (!session.beginScalingSession('beat')) {
                            session.cancelScalingSession()
                            continue
                        }
                        const factors = [0.5, 1.5, 2, 3]
                        session.setScalingFactor(pick(factors))
                        if (chance(0.5)) session.setScalingFactor(pick(factors))
                        if (chance(0.7)) {
                            // Drag a drafted object, possibly onto another: a later step can
                            // displace what an earlier one created, which is no part of the chart.
                            const draft = preview.getPreviewState(history.state.value)
                            const draggable = draft.selectedEntities.filter(
                                (entity) =>
                                    entity.type === 'note' ||
                                    entity.type === 'timeScale' ||
                                    (entity.type === 'bpm' && entity.beat > 0),
                            )
                            const dragged = draggable.length ? pick(draggable) : undefined
                            if (dragged) {
                                session.beginScalingDrag(dragged as never, dragged.beat)
                                session.updateScalingDrag(
                                    chance(0.6) ? pick(draft.selectedEntities).beat : pick(beats),
                                )
                                session.endScalingDrag()
                            }
                        }
                        session.applyScalingSession()
                        session.cancelScalingSession()
                        // No step means the result was the chart it started from.
                        if (!history.canUndo.value) {
                            outcome.cases++
                            continue
                        }
                        result = history.state.value
                        const decoded = decodeOperation(history.headStep.value!.operation)
                        if (decoded.status !== 'known') throw new Error('Unsupported operation')
                        data = decoded.operation.data as never
                        outcome.pushed++
                    }
                    outcome.cases++

                    const inResult = allNative(result)
                    const gone = [...allNative(source)].filter(
                        (entity) => !operands.has(entity) && !inResult.has(entity),
                    )
                    const expected = receipts.countNativeEntities(gone)
                    const actual = (data.displaced ?? {}) as object
                    if (sorted(actual) !== sorted(expected))
                        outcome.failures.push(
                            `${label}: displaced ${sorted(actual)}, expected ${sorted(expected)}`,
                        )
                    if (Object.keys(expected).length) outcome.withDisplaced++
                    if (data.retainedInitialBpm) {
                        outcome.withRetained++
                        const initial = [...selectedSet].some(
                            (entity) => entity.type === 'bpm' && !entity.beat,
                        )
                        const back = [...inResult].some(
                            (entity) => entity.type === 'bpm' && !entity.beat,
                        )
                        if (!initial || !back)
                            outcome.failures.push(
                                `${label}: retainedInitialBpm with initial selected ${initial}, back ${back}`,
                            )
                    }
                } catch (error) {
                    session.cancelScalingSession()
                    outcome.failures.push(`${label}: ${String(error)}`)
                }
            }
            return outcome
        },
        { mode, seeds },
    )

test('the Select move records exactly what it displaced, never a selected operand', async ({
    page,
}) => {
    const outcome = await run(page, 'move', 120)
    expect(outcome.failures).toEqual([])
    expect(outcome.cases).toBeGreaterThan(60)
    // The generator reaches the interesting cases.
    expect(outcome.withDisplaced).toBeGreaterThan(5)
    expect(outcome.withRetained).toBeGreaterThan(5)
})

test('the Scale session ledger records exactly what it displaced, never a selected operand', async ({
    page,
}) => {
    const outcome = await run(page, 'scale', 120)
    expect(outcome.failures).toEqual([])
    expect(outcome.pushed).toBeGreaterThan(30)
    expect(outcome.withDisplaced).toBeGreaterThan(3)
})
