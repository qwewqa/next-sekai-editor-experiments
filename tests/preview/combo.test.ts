import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import test from 'node:test'
import type { NoteObject } from '../../src/chart/note'
import { parseLevelDataChart } from '../../src/chart/parse/levelData'
import { parseLevelData } from '../../src/levelData/parse'
import { CATEGORIES, chartStatistics, mergeTimes } from '../../src/levelData/statistics'
import { buildPreviewChart, createPreviewChartBuilder } from '../../src/preview/engine/chart'
import { comboAt, getComboTimes } from '../../src/preview/engine/combo'
import { createState, type State } from '../../src/state'
import { createSlideId } from '../../src/state/entities/slides'
import { addBpm, removeBpm } from '../../src/state/mutations/bpm'
import { addNote, removeNote } from '../../src/state/mutations/slides/note'
import { editBpm } from '../../src/state/operations/bpm'
import { editSelectedNote } from '../../src/state/operations/note'
import { createTransaction } from '../../src/state/transaction'
import { chart, handBuilt, note } from '../helpers/scoring'

const check = (state: State, preview = buildPreviewChart(state, 10)) => {
    const times = getComboTimes(preview)
    const stats = chartStatistics(state)
    assert.equal(times.length, stats.combo)
    assert.deepEqual(times, mergeTimes(CATEGORIES.map((category) => stats.times[category])).times)
    for (const note of preview.notes) {
        if (note.isFake || note.source?.noteType === 'anchor') continue
        const before = comboAt(times, note.targetTime, true)
        const after = comboAt(times, note.targetTime, false)
        assert.ok(after > before)
        assert.equal(times[before], note.targetTime)
    }
    assert.equal(getComboTimes(preview), times)
    return times
}

test('combo times match the hand-derived Statistics counts and note target times', () => {
    check(handBuilt())
})

for (const path of [
    'tests/fixtures/generated-large.json',
    ...['test_level_data/coconut-next-sekai-24887.json'].filter(existsSync),
    ...(process.env.PREVIEW_COMBO_CHARTS?.split(delimiter).filter(Boolean) ?? []),
]) {
    test(`combo times match Statistics and note target times: ${path}`, () => {
        check(
            createState(
                parseLevelDataChart(
                    parseLevelData(JSON.parse(readFileSync(path, 'utf8'))).entities,
                ),
                0,
            ),
        )
    })
}

test('playing counts an exact hit and its chord; paused waits until after it', () => {
    const times = check(createState(chart([[note(2)], [note(2)], [note(4)]]), 0))
    for (const leftLimit of [false, true]) {
        assert.equal(comboAt(times, 0, leftLimit), 0)
        assert.equal(comboAt(times, 1.5, leftLimit), 2)
        assert.equal(comboAt(times, 3, leftLimit), 3)
    }
    assert.equal(comboAt(times, 1, false), 2)
    assert.equal(comboAt(times, 1, true), 0)
    assert.equal(comboAt(times, 2, false), 3)
    assert.equal(comboAt(times, 2, true), 2)
})

test('empty charts and charts with only fake notes or anchors have no combo', () => {
    for (const slides of [[], [[note(0, { isFake: true })], [note(2, { noteType: 'anchor' })]]]) {
        const times = check(createState(chart(slides), 0))
        assert.equal(times.length, 0)
        assert.equal(comboAt(times, Infinity, false), 0)
    }
})

test('absurd BPMs keep invalid times at the end and never count them', () => {
    for (const [bpms, beats, expected] of [
        [[{ beat: 0, bpm: 1e-10 }], [0, 100000], [0, 6e16]],
        [[{ beat: 0, bpm: 1e-310 }], [0, 100000], [Infinity, Infinity]],
        [
            [
                { beat: 0, bpm: 120 },
                { beat: 4, bpm: 1e-310 },
            ],
            [0, 2, 8],
            [0, 1, Infinity],
        ],
        [[{ beat: 0, bpm: -1e-310 }], [0, 1, 2], [Infinity, Infinity, Infinity]],
    ] as const) {
        const state = createState(
            chart(
                beats.map((beat) => [note(beat)]),
                [...bpms],
            ),
            0,
        )
        const times = getComboTimes(buildPreviewChart(state, 10))
        assert.deepEqual([...times], expected)
        assert.equal(times.length, chartStatistics(state).combo)
        for (const leftLimit of [false, true]) {
            assert.equal(
                comboAt(times, Infinity, leftLimit),
                expected.filter(Number.isFinite).length,
            )
            assert.equal(comboAt(times, -Infinity, leftLimit), 0)
            assert.equal(comboAt(times, NaN, leftLimit), 0)
        }
    }
    assert.equal(comboAt(Float64Array.of(0, 1, Infinity, NaN), Infinity, false), 2)
})

const source = () =>
    createState(
        chart([
            [note(0), note(1), note(2)],
            [note(4), note(6)],
        ]),
        0,
    )

const edits: [string, number, Partial<NoteObject>][] = [
    ['beat', 1, { beat: 1.25 }],
    ['fake note', 1, { isFake: true }],
    ['anchor', 1, { noteType: 'anchor' }],
    ['damage note', 1, { noteType: 'damage' }],
    ['trace', 1, { noteType: 'trace' }],
    ['force tick', 0, { noteType: 'forceTick' }],
    ['force non-tick', 1, { noteType: 'forceNonTick' }],
    ['flick', 1, { flickDirection: 'up' }],
    ['critical', 0, { isCritical: true }],
    ['fake connector', 0, { connectorIsFake: true }],
    ['guide connector', 0, { connectorType: 'guide' }],
    ['damage connector', 0, { connectorType: 'damage' }],
    ['connector separator', 1, { isConnectorSeparator: true, connectorIsFake: true }],
    ['attachment', 1, { isAttached: true }],
]

for (const [name, index, change] of edits) {
    test(`the combo cache follows edits to ${name}, undo and redo`, () => {
        const state = source()
        const build = createPreviewChartBuilder()
        const first = build(state, 10)
        const oldTimes = check(state, first)
        const unchanged = first.chains[1]!
        const slideTimes = getComboTimes({ ...first, chains: [unchanged] })
        const transaction = createTransaction(state)
        const edited = transaction.commit(
            editSelectedNote(transaction, first.chains[0]!.notes[index]!.source!, change),
        )
        const next = build(edited, 10)
        const times = check(edited, next)
        assert.notEqual(times, oldTimes)
        assert.notEqual(next.chains[0]!.infos, first.chains[0]!.infos)
        assert.notEqual(
            getComboTimes({ ...next, chains: [next.chains[0]!] }),
            getComboTimes({ ...first, chains: [first.chains[0]!] }),
        )
        assert.deepEqual(times, getComboTimes(buildPreviewChart(edited, 10)))
        assert.ok(next.chains.includes(unchanged))
        assert.equal(getComboTimes({ ...next, chains: [unchanged] }), slideTimes)
        assert.deepEqual(check(state, build(state, 10)), oldTimes)
        assert.deepEqual(check(edited, build(edited, 10)), times)
    })
}

test('adding and removing notes and slides refreshes the combo', () => {
    let state = source()
    const build = createPreviewChartBuilder()
    let previous = check(state, build(state, 10))
    for (const action of ['add note', 'add slide', 'remove note', 'remove slide'] as const) {
        const transaction = createTransaction(state)
        const notes = [...state.store.slides.note.values()][0]!
        if (action === 'add note') addNote(transaction, notes[0]!.slideId, note(1.5))
        if (action === 'add slide') addNote(transaction, createSlideId(), note(9))
        if (action === 'remove note') removeNote(transaction, notes[1]!)
        if (action === 'remove slide') for (const note of notes) removeNote(transaction, note)
        state = transaction.commit([])
        const times = check(state, build(state, 10))
        assert.notDeepEqual(times, previous, action)
        assert.deepEqual(times, getComboTimes(buildPreviewChart(state, 10)))
        previous = times
    }
})

test('BPM edits recompute times and reuse the cache across chain wrappers', () => {
    let state = source()
    const build = createPreviewChartBuilder()
    let previous = build(state, 10)
    check(state, previous)
    for (const action of ['add', 'move', 'edit', 'remove'] as const) {
        const previousSlideTimes = previous.chains.map((chain) =>
            getComboTimes({ ...previous, chains: [chain] }),
        )
        const transaction = createTransaction(state)
        const bpm = [...state.store.grid.bpm.values()].flatMap((cell) => [...cell]).at(-1)!
        if (action === 'add') addBpm(transaction, { beat: 1, bpm: 60 })
        if (action === 'move') editBpm(transaction, bpm, { beat: 2 })
        if (action === 'edit') editBpm(transaction, bpm, { bpm: 180 })
        if (action === 'remove') removeBpm(transaction, bpm)
        state = transaction.commit([])
        const next = build(state, 10)
        const times = check(state, next)
        assert.ok(
            next.chains.every((chain) => !previous.chains.includes(chain)),
            action,
        )
        for (const [index, chain] of next.chains.entries()) {
            const oldChain = previous.chains[index]!
            assert.equal(chain.infos, oldChain.infos, action)
            assert.notEqual(chain.bpms, oldChain.bpms, action)
            const slideTimes = getComboTimes({ ...next, chains: [chain] })
            assert.equal(getComboTimes({ ...next, chains: [{ ...chain }] }), slideTimes)

            // Revisiting an older tempo must replace the latest per-slide times.
            const oldTimes = getComboTimes({ ...previous, chains: [{ ...oldChain }] })
            assert.deepEqual(oldTimes, previousSlideTimes[index])
            assert.notEqual(oldTimes, slideTimes)
            const restored = getComboTimes({ ...next, chains: [{ ...chain }] })
            assert.deepEqual(restored, slideTimes)
            assert.notEqual(restored, slideTimes)
            assert.equal(getComboTimes({ ...next, chains: [{ ...chain }] }), restored)
        }
        assert.notDeepEqual(times, getComboTimes(previous), action)
        assert.deepEqual(times, getComboTimes(buildPreviewChart(state, 10)))
        previous = next
    }
})

test('camera, stage-event and note-speed edits reuse the chart combo times', () => {
    const state = { ...source(), isDynamicStages: true }
    const build = createPreviewChartBuilder()
    const first = build(state, 10)
    const times = getComboTimes(first)
    const raw = chart([])
    raw.cameraEvents.push({
        beat: 0,
        cameraLeft: -3,
        cameraSize: 8,
        cameraZoom: 1.5,
        cameraZoomTargetLane: 0,
        cameraZoomTargetY: 0,
        cameraZoomVerticalAlign: 'default',
        cameraRotation: 12,
        cameraStageTilt: 0.6,
        eventEase: 'linear',
    })
    raw.stagePivotEvents.push({
        stageId: note(0).stageId,
        beat: 0,
        pivotLane: 1,
        divisionSize: 2,
        divisionParity: 'even',
        yOffset: 0.2,
        yOffsetBeat: 1,
        eventEase: 'linear',
    })
    const replacement = createState(raw, 0)
    for (const key of ['cameraEventJoint', 'stagePivotEventJoint'] as const) {
        const edited = {
            ...state,
            store: {
                ...state.store,
                grid: { ...state.store.grid, [key]: replacement.store.grid[key] },
            },
        }
        const next = build(edited, 10)
        if (key === 'cameraEventJoint') assert.notDeepEqual(next.cameras, first.cameras)
        else assert.notDeepEqual(next.stages[0]!.pivots, first.stages[0]!.pivots)
        assert.equal(getComboTimes(next), times)
        check(edited, next)
    }
    assert.equal(getComboTimes(build(state, 8)), times)
})
