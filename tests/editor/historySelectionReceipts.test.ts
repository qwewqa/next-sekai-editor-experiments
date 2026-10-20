import assert from 'node:assert/strict'
import test from 'node:test'
import type { NoteObject } from '../../src/chart/note'
import { createState, type State } from '../../src/state'
import { createSlideId } from '../../src/state/entities/slides'
import { cleanBeat, GLOBAL_GRID } from '../../src/state/integrals/grid'
import { addBpm } from '../../src/state/mutations/bpm'
import { addNote } from '../../src/state/mutations/slides/note'
import { flipVerticalWithReceipt } from '../../src/state/operations/flipVertical'
import { makeVerticalWithReceipt } from '../../src/state/operations/makeVertical'
import { planEdit } from '../../src/state/operations/properties/plan'
import { scaleSelectionWithReceipt } from '../../src/state/operations/scaleSelection'
import { createTransaction } from '../../src/state/transaction'
import { baseChart, baseState, groupId, stageId } from './sameBeatKinds'

const template: NoteObject = {
    groupId: groupId(1),
    stageId: stageId(1),
    beat: 2,
    elevation: 0,
    noteStyle: 'default',
    connectorStyle: 'default',
    noteType: 'default',
    isAttached: false,
    left: -2,
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
}
const withNotes = (objects: Partial<NoteObject>[], sameSlide = false) => {
    const transaction = createTransaction(baseState())
    const slide = createSlideId()
    const selected = objects.flatMap((object) =>
        addNote(transaction, sameSlide ? slide : createSlideId(), { ...template, ...object }),
    )
    return transaction.commit(selected)
}
const notes = (source: State) => source.selectedEntities.filter((entity) => entity.type === 'note')

test('beat scale counts the changed operand and retains the anchored original correspondence', () => {
    const source = withNotes([{ beat: 2 }, { beat: 4 }])
    const [first, second] = notes(source)
    const result = scaleSelectionWithReceipt(source, source.selectedEntities, 'beat', 2, 2)
    assert.deepEqual(
        notes(result.state).map((note) => note.beat),
        [2, 6],
    )
    assert.deepEqual(result.counts, { note: 1 })
    assert.equal(result.replacements.get(first!), first)
    assert.equal(result.replacements.get(second!)?.beat, 6)
    assert.deepEqual(
        notes(source).map((note) => note.beat),
        [2, 4],
    )
})

const withTimeScales = (beats: number[], tracks = beats.map(() => 1)) => {
    const source = createState(
        {
            ...baseChart(),
            timeScales: beats.map((beat, index) => ({
                groupId: groupId(tracks[index]!),
                beat,
                editorLane: -6,
                timeScale: index + 1,
                skip: 0,
                timeScaleEase: 'none',
                timeScaleTransition: 'timeScale',
                hideNotes: false,
            })),
        },
        0,
    )
    source.selectedEntities = [...source.store.grid.timeScale.values()].flatMap((bucket) => [
        ...bucket,
    ])
    return source
}
const cleanMove = (beat: number, offset: number) =>
    offset === 0 ? beat : cleanBeat([GLOBAL_GRID], beat + offset, 1)

test('rounded timing collisions retain both principal applications but only the actual live output', () => {
    const source = withTimeScales([48, 48.000000025])
    const [first, second] = source.selectedEntities
    const result = scaleSelectionWithReceipt(
        source,
        [second!, first!, second!],
        'beat',
        2,
        0,
        cleanMove,
    )
    assert.deepEqual(result.counts, { timeScale: 2 })
    assert.equal(result.applications.size, 2)
    assert.equal(result.applications.get(first!)?.beat, 96)
    assert.equal(result.applications.get(second!)?.beat, 96)
    assert.equal(result.replacements.size, 1)
    assert.equal(result.replacements.has(second!), false)
    assert.equal(result.replacements.get(first!)?.beat, 96)
    assert.equal(result.state.selectedEntities.length, 1)
    assert.deepEqual(
        source.selectedEntities.map((entity) => entity.beat),
        [48, 48.000000025],
    )
})

test('exact same-beat pairs and different tracks preserve their own live correspondence', () => {
    for (const source of [withTimeScales([48, 48]), withTimeScales([48, 48.000000025], [1, 2])]) {
        const initial = [...source.store.grid.bpm.values()].flatMap((bucket) => [...bucket])[0]!
        const result = scaleSelectionWithReceipt(
            source,
            [...source.selectedEntities].reverse().concat(initial),
            'beat',
            2,
            0,
            cleanMove,
        )
        assert.deepEqual(result.counts, { timeScale: 2 })
        assert.equal(result.replacements.size, 3)
        assert.equal(result.applications.size, 2)
        for (const entity of source.selectedEntities) {
            const after = result.replacements.get(entity)
            assert.equal(after?.beat, 96)
            assert.equal(
                after?.type === 'timeScale' && after.timeScale,
                entity.type === 'timeScale' && entity.timeScale,
            )
        }
    }
})

test('retained initial BPM anchor is collateral to the transformed original', () => {
    const empty = baseState()
    const initial = [...empty.store.grid.bpm.values()].flatMap((bucket) => [...bucket])[0]!
    const transaction = createTransaction(empty)
    const [other] = addBpm(transaction, { beat: 4, bpm: 180, meter: 4 })
    const source = transaction.commit([initial, other!])
    const result = scaleSelectionWithReceipt(source, source.selectedEntities, 'beat', 2, -1)
    assert.deepEqual(result.counts, { bpm: 2 })
    assert.equal(result.replacements.size, 2)
    assert.equal(result.replacements.get(initial)?.beat, 1)
    assert.deepEqual(
        [...result.state.store.grid.bpm.values()]
            .flatMap((bucket) => [...bucket])
            .map((entity) => entity.beat)
            .sort(),
        [0, 1, 9],
    )
    assert.deepEqual(
        scaleSelectionWithReceipt(source, source.selectedEntities, 'beat', 2, 0).counts,
        { bpm: 1 },
    )
})

test('a selected attached tick rebuilt by width scaling keeps lineage without becoming a principal', () => {
    const source = withNotes(
        [
            { beat: 2, left: -4 },
            { beat: 3, isAttached: true },
            { beat: 4, left: 4 },
        ],
        true,
    )
    const middle = notes(source)[1]!
    const result = scaleSelectionWithReceipt(source, source.selectedEntities, 'width', 2, 0)
    assert.deepEqual(result.counts, { note: 2 })
    assert.equal(result.applications.has(middle), false)
    const after = result.replacements.get(middle)
    assert.ok(after?.type === 'note')
    assert.notEqual(after.size, middle.size)
})

test('vertical Flip excludes an unchanged central note and reversing twice restores values', () => {
    const source = withNotes([{ beat: 2 }, { beat: 3 }, { beat: 4 }])
    const result = flipVerticalWithReceipt(source, source.selectedEntities)
    assert.deepEqual(result.counts, { note: 2 })
    assert.deepEqual(
        notes(result.state).map((note) => note.beat),
        [4, 3, 2],
    )
    const twice = flipVerticalWithReceipt(result.state, result.state.selectedEntities)
    assert.deepEqual(twice.counts, { note: 2 })
    assert.deepEqual(
        notes(twice.state).map((note) => note.beat),
        [2, 3, 4],
    )
})

test('Make Vertical counts earliest-note elevation reset and changed later notes', () => {
    const source = withNotes([{ beat: 2, elevation: 5 }, { beat: 4 }, { beat: 6 }])
    const result = makeVerticalWithReceipt(source, source.selectedEntities)
    assert.deepEqual(result.counts, { note: 3 })
    assert.deepEqual(
        notes(result.state).map(({ beat, elevation }) => [beat, elevation]),
        [
            [2, 0],
            [2, 2],
            [2, 4],
        ],
    )
    assert.deepEqual(
        notes(source).map(({ beat, elevation }) => [beat, elevation]),
        [
            [2, 5],
            [4, 0],
            [6, 0],
        ],
    )
})

test('Make Vertical excludes an unchanged earliest note and includes attachment changes', () => {
    const source = withNotes([{ beat: 2 }, { beat: 3, isAttached: true }, { beat: 4 }], true)
    const result = makeVerticalWithReceipt(source, source.selectedEntities)
    assert.deepEqual(result.counts, { note: 2 })
    assert.deepEqual(
        notes(result.state).map(({ beat, isAttached }) => [beat, isAttached]),
        [
            [2, false],
            [2, false],
            [2, false],
        ],
    )
})

test('Properties relative each-values retain effective varying assignment and exact primary field', () => {
    const source = withNotes([{ size: 2 }, { size: 4 }])
    const result = planEdit(
        source,
        source.selectedEntities,
        { size: 1 },
        { each: (entity) => (entity.type === 'note' ? { size: entity.size + 1 } : {}) },
    )
    assert.deepEqual(
        notes(result.state).map((note) => note.size),
        [3, 5],
    )
    assert.deepEqual(result.receipt, {
        subject: 'note',
        changed: { note: 2 },
        assignments: [{ field: 'size', before: { mode: 'varying' }, after: { mode: 'varying' } }],
    })
})

test('Properties applied ease tokens become effective resulting ease values', () => {
    const source = withNotes([{ connectorEase: 'inQuad' }, { connectorEase: 'outQuad' }])
    const result = planEdit(source, source.selectedEntities, { connectorEase: 'linear' })
    assert.deepEqual(
        notes(result.state).map((note) => note.connectorEase),
        ['linear', 'linear'],
    )
    assert.deepEqual(result.receipt, {
        subject: 'note',
        changed: { note: 2 },
        assignments: [
            {
                field: 'connectorEase',
                before: { mode: 'varying' },
                after: { mode: 'uniform', value: 'linear' },
            },
        ],
    })
})

test('Properties geometry normalization cannot erase the applied beat field during reordering', () => {
    const source = withNotes(
        [
            { beat: 2, left: -4 },
            { beat: 3, isAttached: true },
            { beat: 4, left: 4 },
        ],
        true,
    )
    const middle = notes(source)[1]!
    const result = planEdit(source, [middle], { beat: 5, left: 7, size: 2 })
    assert.equal(result.changed.length, 1)
    assert.equal(result.state.selectedEntities[0]?.beat, 5)
    assert.ok(result.receipt)
    assert.ok(result.receipt.assignments.some(({ field }) => field === 'beat'))
    assert.equal(middle.beat, 3)
})
