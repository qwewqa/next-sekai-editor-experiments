import assert from 'node:assert/strict'
import test from 'node:test'
import { extendSelectionToSlides } from '../../src/editor/tools/slideSelection'
import type { Entity } from '../../src/state/entities'
import type { SlideId } from '../../src/state/entities/slides'
import type { NoteEntity } from '../../src/state/entities/slides/note'

const note = (slide: number, beat: number) =>
    ({ type: 'note', slideId: slide as SlideId, beat }) as NoteEntity

test('slide expansion keeps original selection order and appends siblings in first-seen slide order', () => {
    const first = note(1, 0)
    const middle = note(1, 1)
    const last = note(1, 2)
    const otherFirst = note(2, 3)
    const otherLast = note(2, 4)
    const missing = note(3, 5)
    const bpm = { type: 'bpm', beat: 0 } as Entity
    const slides = new Map([
        [first.slideId, [first, middle, last]],
        [otherFirst.slideId, [otherFirst, otherLast]],
    ])
    const selected = [last, bpm, otherFirst, missing, first, last]
    assert.deepEqual(
        extendSelectionToSlides(selected, slides, () => true),
        [last, bpm, otherFirst, missing, first, middle, otherLast],
    )
    assert.deepEqual(selected, [last, bpm, otherFirst, missing, first, last])
    assert.deepEqual(
        extendSelectionToSlides([], slides, () => true),
        [],
    )
})

test('slide expansion skips hidden and dimmed siblings while retaining already selected objects', () => {
    const first = note(1, 0)
    const hidden = note(1, 1)
    const dimmed = note(1, 2)
    const last = note(1, 3)
    const slides = new Map([[first.slideId, [first, hidden, dimmed, last]]])
    const inScope = (entity: NoteEntity) => entity !== hidden && entity !== dimmed
    assert.deepEqual(extendSelectionToSlides([first], slides, inScope), [first, last])
    assert.deepEqual(extendSelectionToSlides([hidden, first], slides, inScope), [
        hidden,
        first,
        last,
    ])
    assert.deepEqual(
        extendSelectionToSlides([first, last], slides, () => false),
        [first, last],
    )
})

test('expanding many notes from the same slide checks every sibling only once', () => {
    const notes = Array.from({ length: 1000 }, (_, beat) => note(1, beat))
    const slides = new Map([[1 as SlideId, notes]])
    let scopeChecks = 0
    assert.deepEqual(
        extendSelectionToSlides(notes, slides, () => {
            scopeChecks++
            return true
        }),
        notes,
    )
    assert.equal(scopeChecks, notes.length)
})
