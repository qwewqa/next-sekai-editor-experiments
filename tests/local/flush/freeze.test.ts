import assert from 'node:assert/strict'
import test from 'node:test'
import { pushState, resetStates } from '../../../src/history/stack'
import { replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'
import { goldenChart, stateOf } from '../records/charts'

// Outside release builds the undo stack freezes what it publishes (the flush's identity memo
// relies on states never changing in place), so a change in place throws where it's made.

test('a published state’s maps, sets, arrays and entities refuse a change in place', () => {
    const state = stateOf(goldenChart())
    resetStates({ isDirty: false, name: () => 'Initialize', state })
    const { grid, slides } = state.store
    assert.throws(() => grid.bpm.set(99, new Set()), /changed in place/)
    const [bucket] = grid.note.values()
    assert.ok(bucket)
    assert.throws(() => bucket.clear(), /changed in place/)
    const [notes] = slides.note.values()
    assert.ok(notes)
    assert.throws(() => (notes as unknown[]).push(undefined), TypeError)
    const [note] = notes
    assert.ok(note)
    assert.throws(() => {
        ;(note as { size: number }).size = 3
    }, TypeError)
    // Maps nobody published are untouched.
    const own = new Map([[1, 1]])
    own.set(2, 2)
    assert.equal(own.size, 2)
})

test('edits of a published state still work, by copying what they change', () => {
    const state = stateOf(goldenChart())
    resetStates({ isDirty: false, name: () => 'Initialize', state })
    const transaction = createTransaction(state)
    const [note] = [...state.store.slides.note.values()].flat()
    assert.ok(note)
    replaceNote(transaction, note, { ...note, size: note.size + 1 })
    const next = transaction.commit([])
    pushState(() => 'Changed note', next)
    assert.notEqual(next.store.slides.note, state.store.slides.note)
    assert.equal([...state.store.slides.note.values()].flat()[0]?.size, note.size)
})
