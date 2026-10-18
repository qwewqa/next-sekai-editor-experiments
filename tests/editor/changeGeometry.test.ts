import assert from 'node:assert/strict'
import test from 'node:test'
import { changeShape } from '../../src/editor/canvas/changeGeometry'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import { toBpmEntity } from '../../src/state/entities/bpm'
import { createSlideId } from '../../src/state/entities/slides'
import { toNoteEntity } from '../../src/state/entities/slides/note'
import { goldenChart, note, stateOf } from '../local/records/charts'

const state = stateOf(goldenChart())
const context = { state, ups: 2 } as EditorDrawContext

test('note contours use the body width and modest corners, including zero-width placeholders', () => {
    const ordinary = changeShape(
        context,
        toNoteEntity(createSlideId(), note(4, { left: 1, size: 4 })),
    )!
    assert.equal(ordinary.kind, 'note')
    assert.equal(ordinary.x, 1)
    assert.equal(ordinary.w, 4)
    assert.equal(ordinary.radius, 0.1)
    assert.equal(ordinary.h, 0.6)
    const placeholder = changeShape(context, toNoteEntity(createSlideId(), note(4, { size: 0 })))!
    assert.equal(placeholder.w, 0.2)
    const tick = changeShape(
        context,
        toNoteEntity(createSlideId(), note(4, { noteType: 'forceTick' })),
    )!
    assert.equal(tick.kind, 'diamond')
    assert.equal(tick.w, 0.6)
    const trace = changeShape(
        context,
        toNoteEntity(createSlideId(), note(4, { noteType: 'trace' })),
    )!
    assert.equal(trace.h, 0.3)
})

test('events retain their native glyph positions rather than their broad selection hitboxes', () => {
    const bpm = changeShape(context, toBpmEntity({ beat: 4, bpm: 180 }))!
    assert.equal(bpm.kind, 'bpm')
    assert.equal(bpm.x, 6.1)
    for (const type of [
        'cameraEventJoint',
        'stageMaskEventJoint',
        'stagePivotEventJoint',
        'stageStyleEventJoint',
        'stageTransformEventJoint',
        'timeScale',
    ] as const) {
        const entity = [...state.store.grid[type].values()].flatMap((bucket) => [...bucket])[0]!
        assert.ok(entity, type)
        const shape = changeShape(context, entity)!
        assert.ok(shape, type)
        assert.equal(
            shape.kind,
            type === 'cameraEventJoint' || type === 'stageMaskEventJoint' ? 'range' : 'circle',
        )
        assert.ok(shape.h <= 0.27)
    }
})

test('tick contours use native asymmetric points and effective composed widths', () => {
    const tick = toNoteEntity(createSlideId(), note(4, { noteType: 'forceTick', size: 0 }))
    const composed = {
        ...context,
        composed: { hitbox: () => ({ lane: 7, w: 2 }) },
    } as unknown as EditorDrawContext
    const shape = changeShape(composed, tick)!
    assert.equal(shape.kind, 'diamond')
    assert.deepEqual(shape.points, [
        [6.7, 4],
        [7, 3.7],
        [7.3, 4],
        [7, 4.15],
    ])
    assert.equal(shape.y, 3.7)
    assert.equal(shape.h, 0.45)
    const collapsed = {
        ...context,
        composed: { hitbox: () => ({ lane: 7, w: 0 }) },
    } as unknown as EditorDrawContext
    assert.equal(changeShape(collapsed, tick)!.kind, 'note')
    assert.equal(changeShape(collapsed, tick)!.w, 0.2)
})
