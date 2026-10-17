import assert from 'node:assert/strict'
import test from 'node:test'
import { faceAfterPick, movesFace, type Pick } from '../../src/editor/toolbar/face'

const pick = (overrides: Partial<Pick>): Pick => ({
    name: 'copy',
    state: undefined,
    inGroup: true,
    toolInUse: false,
    ...overrides,
})

test('a picked action takes the face', () => {
    assert.deepEqual(
        faceAfterPick({ face: 'undo', displaced: undefined }, pick({ name: 'copy' })),
        {
            face: 'copy',
            displaced: undefined,
        },
    )
})

test('a member that keeps the face leaves the face and the displaced face as they are', () => {
    const group = { face: 'undo', displaced: undefined } as const
    assert.equal(faceAfterPick(group, pick({ name: 'redo', keepsFace: true })), group)

    const open = { kind: 'panel', current: true } as const
    assert.equal(faceAfterPick(group, pick({ name: 'redo', state: open, keepsFace: true })), group)

    const displaced = { face: 'select', displaced: 'undo' } as const
    assert.equal(faceAfterPick(displaced, pick({ name: 'redo', keepsFace: true })), displaced)
})

test('a toggle left off, or a member no longer in the group, leaves the face', () => {
    const group = { face: 'select', displaced: undefined } as const
    const off = { kind: 'tool', current: false } as const
    assert.equal(faceAfterPick(group, pick({ name: 'eraser', state: off })), group)
    assert.equal(faceAfterPick(group, pick({ name: 'eraser', inGroup: false })), group)
})

test('over a temporary face, a tool holds the face and anything else is where it returns', () => {
    const group = { face: 'brush', displaced: 'deselect' } as const
    const tool = { kind: 'tool', current: true } as const
    assert.deepEqual(faceAfterPick(group, pick({ name: 'eraser', state: tool })), {
        face: 'eraser',
        displaced: undefined,
    })
    assert.deepEqual(faceAfterPick(group, pick({ name: 'increaseNoteSize' })), {
        face: 'increaseNoteSize',
        displaced: 'increaseNoteSize',
    })
})

test('a value leaves the face to a tool in use', () => {
    const value = { kind: 'value', family: 'division', current: true } as const
    const group = { face: 'select', displaced: undefined } as const
    assert.deepEqual(
        faceAfterPick(group, pick({ name: 'division4', state: value, toolInUse: true })),
        group,
    )
    assert.deepEqual(faceAfterPick(group, pick({ name: 'division4', state: value })), {
        face: 'division4',
        displaced: undefined,
    })
})

test('an open panel shows pressed but never moves the face', () => {
    assert.equal(movesFace({ kind: 'panel', current: true }), false)
    assert.equal(movesFace({ kind: 'tool', current: true }), true)
    assert.equal(movesFace({ kind: 'value', family: 'division', current: false }), true)
    assert.equal(movesFace(undefined), false)
})
