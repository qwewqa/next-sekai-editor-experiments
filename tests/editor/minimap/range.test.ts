import assert from 'node:assert/strict'
import test from 'node:test'
import {
    computeEnd,
    endForLastTime,
    endOf,
    lastBeatOf,
    MIN_END,
} from '../../../src/editor/minimap/range'
import { replaceBpm } from '../../../src/state/mutations/bpm'
import { createTransaction } from '../../../src/state/transaction'
import { chartState, note } from '../chartFixture'

// The fixture's tempo is 60 BPM, so a beat is a second.

test('the end rounds up to a step that grows with the chart', () => {
    assert.equal(endForLastTime(165), 172)
    // The step is 4 up to 256 s: anything within the same step keeps the end.
    assert.equal(endForLastTime(168), 172)
    assert.equal(endForLastTime(164.5), 172)
    assert.equal(endForLastTime(168.5), 176)
    // Past 256 s the step doubles to 8.
    assert.equal(endForLastTime(300), 312)
})

test('an empty chart and a very short one take the minimum', () => {
    assert.equal(endOf(chartState([])), MIN_END)
    assert.equal(endOf(chartState([[note(2)]])), MIN_END)
    assert.equal(endForLastTime(undefined), MIN_END)
})

test('the last beat is the largest key, whatever order the keys were inserted in', () => {
    // The 100 s slide is inserted first, so the Map's last key is 3.
    const state = chartState([[note(100.2)], [note(100.7)], [note(3)]])
    const keys = [...state.store.grid.note.keys()]
    assert.equal(keys.at(-1), 3)
    assert.equal(lastBeatOf(state.store.grid.note), 100.7)
    assert.equal(endOf(state), endForLastTime(100.7))
})

test('a BPM edit that leaves the note grid alone changes the end', () => {
    const state = chartState([[note(100)]])
    const entity = [...(state.store.grid.bpm.get(0) ?? [])][0]
    assert.ok(entity)
    const transaction = createTransaction(state)
    replaceBpm(transaction, entity, { beat: 0, bpm: 30 })
    const halved = transaction.commit([])
    assert.equal(halved.store.grid.note, state.store.grid.note)
    assert.equal(endOf(state), 102)
    assert.equal(endOf(halved), 204)
})

test('while peeking the end is the larger of the live and peeked ends', () => {
    const short = chartState([[note(20)]])
    const long = chartState([[note(165)]])
    assert.equal(computeEnd(short, long, true), endOf(long))
    assert.equal(computeEnd(long, short, true), endOf(long))
    assert.equal(computeEnd(short, long, false), endOf(short))
    // Arrowing between two shorter entries keeps one scale.
    const other = chartState([[note(40)]])
    assert.equal(computeEnd(short, long, true), computeEnd(other, long, true))
})
