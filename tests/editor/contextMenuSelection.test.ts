import assert from 'node:assert/strict'
import test from 'node:test'
import { canSelectSlideNotes } from '../../src/editor/contextMenu/selection'
import type { Entity } from '../../src/state/entities'
import type { SlideId } from '../../src/state/entities/slides'
import type { NoteEntity } from '../../src/state/entities/slides/note'

const note = (slide: number, beat: number) =>
    ({ type: 'note', slideId: slide as SlideId, beat }) as NoteEntity

test('slide extension checks preserve partial selections, mixed kinds and scope filtering', () => {
    const first = note(1, 0)
    const hidden = note(1, 1)
    const dimmed = note(1, 2)
    const last = note(1, 3)
    const other = note(2, 4)
    const missing = note(3, 5)
    const bpm = { type: 'bpm', beat: 0 } as Entity
    const slides = new Map([
        [first.slideId, [first, hidden, dimmed, last]],
        [other.slideId, [other]],
    ])
    const inScope = (entity: NoteEntity) => entity !== hidden && entity !== dimmed
    const selection = [bpm, other, first, missing, first]
    assert.equal(canSelectSlideNotes(selection, slides, inScope), true)
    assert.deepEqual(selection, [bpm, other, first, missing, first])
    assert.equal(canSelectSlideNotes([...selection, last], slides, inScope), false)
    assert.equal(
        canSelectSlideNotes([first], slides, () => false),
        false,
    )
    assert.equal(canSelectSlideNotes([bpm, missing], slides, inScope), false)
    assert.equal(canSelectSlideNotes([], slides, inScope), false)
    assert.equal(canSelectSlideNotes([first, hidden, dimmed, last], slides, inScope), false)
})

test('a fully selected long slide is scanned once, without testing selected notes for scope', () => {
    const originals = Array.from({ length: 1000 }, (_, beat) => note(1, beat))
    let visits = 0
    const notes = new Proxy(originals, {
        get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) visits++
            return Reflect.get(target, key, receiver)
        },
    })
    const slides = new Map([[1 as SlideId, notes]])
    assert.equal(
        canSelectSlideNotes(originals, slides, () => {
            assert.fail('selected notes do not need a scope check')
        }),
        false,
    )
    assert.equal(visits, originals.length)
})
