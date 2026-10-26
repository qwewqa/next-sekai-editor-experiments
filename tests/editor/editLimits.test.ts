import assert from 'node:assert/strict'
import test from 'node:test'
import { maxBeat, maxLane, maxMeter, maxSize } from '../../src/chart/limits'
import type { NoteObject } from '../../src/chart/note'
import { parseLevelDataChart } from '../../src/chart/parse/levelData'
import { validateChart } from '../../src/chart/validate'
import { pushState, resetStates, state } from '../../src/history/stack'
import { serializeToLevelData } from '../../src/levelData/serialize'
import type { State } from '../../src/state'
import { createSlideId } from '../../src/state/entities/slides'
import { addBpm } from '../../src/state/mutations/bpm'
import { addNote, removeNote } from '../../src/state/mutations/slides/note'
import { initialStep, noteAdd } from '../helpers/historySteps'
import { baseState, edits, groupId, stageId } from './sameBeatKinds'

// An edit whose result the editor would refuse to reopen does not happen: stored sessions are
// rebuilt through the same checks as a file.

const note = (beat: number, left = 0, size = 3): NoteObject => ({
    groupId: groupId(1),
    stageId: stageId(1),
    beat,
    elevation: 0,
    noteStyle: 'default',
    connectorStyle: 'default',
    noteType: 'default',
    isAttached: false,
    left,
    size,
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

const start = (first: State) => resetStates({ isDirty: false, step: initialStep(), state: first })

const withNote = (base: State, object: NoteObject) =>
    edits(base, (transaction) => addNote(transaction, createSlideId(), object))

/** What reopening the chart does with the state as it is saved. */
const reopens = (source: State) => {
    const data = serializeToLevelData(
        source.initialLife,
        source.isDynamicStages,
        0,
        source.store,
        source.groups,
        source.stages,
    )
    validateChart(parseLevelDataChart(data.entities))
}

test('a note placed or pasted past the largest beat is not pushed', () => {
    const first = withNote(baseState(), note(maxBeat))
    start(first)
    assert.equal(pushState(noteAdd(1), withNote(first, note(maxBeat + 1))), false)
    assert.equal(state.value, first)
    // At the limit it is an edit, and the state it makes reopens.
    const accepted = withNote(first, note(maxBeat, 2))
    assert.equal(pushState(noteAdd(1), accepted), true)
    reopens(state.value)
})

test('a note moved past a lane or size limit is not pushed', () => {
    const first = withNote(baseState(), note(4))
    start(first)
    const [only] = first.store.slides.note.values()
    const moved = (object: NoteObject) =>
        edits(
            first,
            (transaction) => removeNote(transaction, only![0]!),
            (transaction) => addNote(transaction, createSlideId(), object),
        )
    assert.equal(pushState(noteAdd(1), moved(note(4, maxLane + 1))), false)
    assert.equal(pushState(noteAdd(1), moved(note(4, -maxLane - 1))), false)
    assert.equal(pushState(noteAdd(1), moved(note(4, 0, maxSize + 1))), false)
    assert.equal(state.value, first)
    assert.equal(pushState(noteAdd(1), moved(note(4, maxLane, maxSize))), true)
    reopens(state.value)
})

test('a BPM change with a meter past the limits is not pushed', () => {
    const first = baseState()
    start(first)
    const withMeter = (meter: number) =>
        edits(first, (transaction) => addBpm(transaction, { beat: 8, bpm: 120, meter }))
    for (const meter of [1e16, maxMeter + 1, 0])
        assert.equal(pushState(noteAdd(1), withMeter(meter)), false, `${meter}`)
    assert.equal(pushState(noteAdd(1), withMeter(3)), true)
    reopens(state.value)
})
