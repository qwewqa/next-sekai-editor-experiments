import assert from 'node:assert/strict'
import test from 'node:test'
import { diffGrids, gridsOf, MAX_BAND_ENTITIES } from '../../../src/editor/minimap/diff'
import type { State } from '../../../src/state'
import { createSlideId } from '../../../src/state/entities/slides'
import type { NoteEntity } from '../../../src/state/entities/slides/note'
import { addNote, removeNote, replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction, type Transaction } from '../../../src/state/transaction'
import { chartState, note } from '../chartFixture'

const edit = (state: State, change: (transaction: Transaction) => unknown) => {
    const transaction = createTransaction(state)
    change(transaction)
    return transaction.commit([])
}

const noteAt = (state: State, beat: number) => {
    const found = [...(state.store.grid.note.get(Math.floor(beat)) ?? [])].find(
        (entity) => entity.beat === beat,
    )
    assert.ok(found, `no note at ${beat}`)
    return found
}

const moved = (entity: NoteEntity, beat: number) => ({ ...entity, beat })

// Beats 10 and 10.5 share a bucket. The slide at 4 and 8 has a body across keys 4 to 8.
const start = () =>
    chartState([
        [note(2)],
        [note(10)],
        [note(10.5)],
        [note(20)],
        [note(4, { left: -3 }), note(8, { left: 2 })],
    ])

test('a note move gives its two keys', () => {
    const state = start()
    const next = edit(state, (transaction) => {
        const entity = noteAt(state, 10)
        replaceNote(transaction, entity, moved(entity, 15))
    })
    assert.deepEqual(diffGrids(gridsOf(state), gridsOf(next)), [10, 15])
})

test('removing the only note of a bucket gives the deleted key', () => {
    const state = start()
    const next = edit(state, (transaction) => removeNote(transaction, noteAt(state, 20)))
    assert.equal(next.store.grid.note.has(20), false)
    assert.deepEqual(diffGrids(gridsOf(state), gridsOf(next)), [20])
})

test('a slide edit gives every key of its body', () => {
    const state = start()
    const next = edit(state, (transaction) => {
        const tail = noteAt(state, 8)
        replaceNote(transaction, tail, { ...tail, left: 4 })
    })
    // The slide's bodies are rebuilt, so each key from the head to the tail changes.
    assert.deepEqual(diffGrids(gridsOf(state), gridsOf(next)), [4, 5, 6, 7, 8])
})

test('a read-only transaction gives no key', () => {
    const state = start()
    const next = edit(state, (transaction) => {
        // The first read copies each Map, so the identities differ.
        void transaction.store.grid.note
        void transaction.store.grid.connector
    })
    assert.notEqual(next.store.grid.note, state.store.grid.note)
    assert.deepEqual(diffGrids(gridsOf(state), gridsOf(next)), [])
})

test('Undo, the earlier state against now, gives the same keys', () => {
    const state = start()
    const next = edit(state, (transaction) => {
        const entity = noteAt(state, 10)
        replaceNote(transaction, entity, moved(entity, 15))
    })
    assert.deepEqual(diffGrids(gridsOf(next), gridsOf(state)), [10, 15])
})

test('more than the threshold of entities gives a full redraw', () => {
    const state = start()
    const many = edit(state, (transaction) => {
        for (let i = 0; i <= MAX_BAND_ENTITIES; i++)
            addNote(transaction, createSlideId(), note(30 + i * 0.001))
    })
    assert.equal(diffGrids(gridsOf(state), gridsOf(many)), 'full')
    // Spread over many keys it still counts every entity.
    const spread = edit(state, (transaction) => {
        for (let i = 0; i <= MAX_BAND_ENTITIES; i++)
            addNote(transaction, createSlideId(), note(50 + i))
    })
    assert.equal(diffGrids(gridsOf(state), gridsOf(spread)), 'full')
    // A few entities stay incremental.
    const few = edit(state, (transaction) => addNote(transaction, createSlideId(), note(60)))
    assert.deepEqual(diffGrids(gridsOf(state), gridsOf(few)), [60])
})
