import assert from 'node:assert/strict'
import test from 'node:test'
import type { NoteObject } from '../../src/chart/note'
import { sameChart } from '../../src/history/sameChart'
import { canUndo, isPristine, pushState, resetStates, state } from '../../src/history/stack'
import { stateFromRecords, toRecords } from '../../src/local/records/records'
import type { State } from '../../src/state'
import { createSlideId } from '../../src/state/entities/slides'
import { addNote, removeNote } from '../../src/state/mutations/slides/note'
import { createTransaction } from '../../src/state/transaction'
import { initialLife, initialStep, noteAdd } from '../helpers/historySteps'
import { add, baseState, edits, entityAt, groupId, kinds, stageId } from './sameBeatKinds'

// An action whose result equals the chart it started from adds no History step.
// Equal means the same stored records in the same order, so a rebuilt entity with
// the same values is no change, and a reorder of same-beat objects is one.

const note = (beat: number, left = 0): NoteObject => ({
    groupId: groupId(1),
    stageId: stageId(1),
    beat,
    elevation: 0,
    noteStyle: 'default',
    connectorStyle: 'default',
    noteType: 'default',
    isAttached: false,
    left,
    size: 3,
    isCritical: false,
    flickDirection: 'none',
    isFake: false,
    sfx: 'default',
    isConnectorSeparator: false,
    connectorType: 'active',
    connectorEase: 'linear',
    connectorIsFake: false,
    connectorActiveIsCritical: false,
    connectorGuideAlpha: 1,
    connectorLayer: 'top',
    connectorIsPassThrough: false,
    connectorPresentation: 'default',
})

const withNote = (base: State, beat: number, left = 0) =>
    edits(base, (transaction) => addNote(transaction, createSlideId(), note(beat, left)))

/** The same chart with every entity built afresh. */
const rebuilt = (source: State) => stateFromRecords(toRecords(source))

const start = (first: State) => resetStates({ isDirty: false, step: initialStep(), state: first })

test('a rebuilt chart with the same records is the same chart', () => {
    const chart = withNote(baseState(), 4)
    const copy = rebuilt(chart)
    assert.notEqual(copy.store.slides.note, chart.store.slides.note)
    assert.equal(sameChart(chart, copy), true)
})

test('a note edited in a field, moved, added or removed is a different chart', () => {
    const chart = withNote(baseState(), 4)
    assert.equal(sameChart(chart, withNote(baseState(), 5)), false)
    assert.equal(sameChart(chart, withNote(baseState(), 4, 1)), false)
    assert.equal(sameChart(chart, withNote(chart, 6)), false)
    assert.equal(sameChart(baseState(), chart), false)
    const [only] = chart.store.slides.note.values()
    const emptied = edits(chart, (transaction) => removeNote(transaction, only![0]!))
    assert.equal(sameChart(chart, emptied), false)
})

test('removing a note and adding it back is the same chart, as slide ids are not stored', () => {
    const chart = withNote(baseState(), 4)
    const [only] = chart.store.slides.note.values()
    const back = edits(
        chart,
        (transaction) => removeNote(transaction, only![0]!),
        (transaction) => addNote(transaction, createSlideId(), note(4)),
    )
    assert.equal(sameChart(chart, back), true)
})

test('a header field or the level info makes a different chart', () => {
    const chart = baseState()
    assert.equal(sameChart(chart, { ...chart, initialLife: 900 }), false)
    assert.equal(sameChart(chart, { ...chart, isDynamicStages: !chart.isDynamicStages }), false)
    assert.equal(sameChart(chart, { ...chart, bgm: { ...chart.bgm, offset: 1 } }), false)
    assert.equal(sameChart(chart, { ...chart, bgm: { ...chart.bgm, filename: 'a.mp3' } }), false)
    assert.equal(sameChart(chart, { ...chart, selectedEntities: [] }), true)
})

for (const kind of kinds) {
    test(`${kind.name}: the same objects rebuilt are one chart; the same beat in another order is not`, () => {
        const two = edits(
            baseState(),
            (transaction) => add(transaction, kind, 4, 1),
            (transaction) => add(transaction, kind, 4, 2),
        )
        // Taking the last object out and putting it back keeps the order.
        const second = entityAt(two, kind, 4, 2)
        const back = edits(
            two,
            (transaction) => kind.remove(transaction, second as never),
            (transaction) => add(transaction, kind, 4, 2),
        )
        assert.notEqual(entityAt(back, kind, 4, 2), second)
        assert.equal(sameChart(two, back), true)

        // Taking the first out and putting it back puts it after the other: the same objects, reordered.
        const first = entityAt(two, kind, 4, 1)
        const reordered = edits(
            two,
            (transaction) => kind.remove(transaction, first as never),
            (transaction) => add(transaction, kind, 4, 1),
        )
        assert.equal(sameChart(two, reordered), false)
        assert.equal(sameChart(reordered, two), false)
        assert.equal(
            sameChart(
                two,
                edits(two, (transaction) => add(transaction, kind, 5, 3)),
            ),
            false,
        )
    })
}

test('pushing an equal chart adds no step; the stack, the state and the dirty flag stay', () => {
    const first = withNote(baseState(), 4)
    start(first)
    const pushed = pushState(noteAdd(1), rebuilt(first))
    assert.equal(pushed, false)
    assert.equal(isPristine.value, true)
    assert.equal(canUndo.value, false)
    assert.equal(state.value, first)
})

test('pushing a changed chart adds a step', () => {
    const first = withNote(baseState(), 4)
    start(first)
    const second = withNote(first, 6)
    assert.equal(pushState(noteAdd(1), second), true)
    assert.equal(isPristine.value, false)
    assert.equal(canUndo.value, true)
    assert.equal(state.value, second)
})

test('pushing a header-only change adds a step', () => {
    const first = baseState()
    start(first)
    assert.equal(pushState(initialLife(1000, 900), { ...first, initialLife: 900 }), true)
    assert.equal(canUndo.value, true)
})

test('pushing a reordered chart adds a step', () => {
    const kind = kinds[0]!
    const two = edits(
        baseState(),
        (transaction) => add(transaction, kind, 4, 1),
        (transaction) => add(transaction, kind, 4, 2),
    )
    start(two)
    const reordered = edits(
        two,
        (transaction) => kind.remove(transaction, entityAt(two, kind, 4, 1) as never),
        (transaction) => add(transaction, kind, 4, 1),
    )
    assert.equal(pushState(noteAdd(1), reordered), true)
    assert.equal(canUndo.value, true)
})

test('an equal chart with another selection keeps the selection and adds no step', () => {
    const first = withNote(baseState(), 4)
    start(first)
    const copy = rebuilt(first)
    const [slide] = copy.store.slides.note.values()
    const selected = { ...copy, selectedEntities: [slide![0]!] }
    assert.equal(pushState(noteAdd(1), selected), false)
    assert.equal(canUndo.value, false)
    assert.equal(state.value.selectedEntities.length, 1)
    assert.equal(state.value.selectedEntities[0], slide![0])
})

test('Restore pushes a step even when the chart equals the current one', () => {
    const first = withNote(baseState(), 4)
    start(first)
    assert.equal(pushState(noteAdd(1), rebuilt(first), 'restore'), true)
    assert.equal(canUndo.value, true)
})

test('a transaction that changes nothing commits an equal chart', () => {
    const chart = withNote(baseState(), 4)
    assert.equal(sameChart(chart, createTransaction(chart).commit([])), true)
})

test('states it cannot read count as different, so a step is never dropped on a doubt', () => {
    const chart = baseState()
    const unreadable = { ...chart, groups: undefined } as unknown as State
    assert.equal(sameChart(chart, unreadable), false)
    start(chart)
    assert.equal(pushState(noteAdd(1), unreadable), true)
})
