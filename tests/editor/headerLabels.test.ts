import assert from 'node:assert/strict'
import test from 'node:test'
import {
    bgmInput,
    bgmOffsetInput,
    groupEditInput,
    initialLifeInput,
    stageEditInput,
} from '../../src/editor/headerLabelText'
import { createOperation, decodeOperation } from '../../src/history/operations'

const capture = (input: Parameters<typeof createOperation>[0]) =>
    JSON.parse(
        JSON.stringify(createOperation(input, { locale: 'en', describe: () => 'Captured action' })),
    ) as ReturnType<typeof createOperation>

const stage = {
    name: 'Main',
    isFromStart: false,
    isUntilEnd: false,
    generateSimLines: 'global' as const,
}

test('header operations preserve exact before and after values without formatting', () => {
    for (const [before, after] of [
        [1000, 999],
        [0.123456789012345, Number.MIN_VALUE],
        [-1e200, 1e200],
    ]) {
        const life = capture(initialLifeInput(before!, after!))
        const offset = capture(bgmOffsetInput(before!, after!))
        assert.deepEqual(life.data, { field: 'initialLife', before, after })
        assert.deepEqual(offset.data, { field: 'bgmOffset', before, after })
        assert.equal(decodeOperation(life).status, 'known')
        assert.equal(decodeOperation(offset).status, 'known')
    }
})

test('BGM operations distinguish offset, file and compound changes including equal basenames', () => {
    const old = { buffer: {}, filename: 'a{1}$&.mp3', offset: 0.123456789012345 }
    const offset = bgmInput(old, { ...old, offset: Number.MIN_VALUE })
    assert.deepEqual(offset, bgmOffsetInput(old.offset, Number.MIN_VALUE))
    const replacement = capture(bgmInput(old, { ...old, buffer: {} }))
    assert.equal(replacement.id, 'nse.bgm.change')
    assert.deepEqual(replacement.data, {
        file: { before: { text: old.filename }, after: { text: old.filename } },
    })
    assert.deepEqual(bgmInput(old, { buffer: {}, filename: 'b.mp3', offset: -1e-200 }), {
        id: 'nse.bgm.change',
        data: {
            file: { before: { text: old.filename }, after: { text: 'b.mp3' } },
            offset: { before: old.offset, after: -1e-200 },
        },
    })
    assert.deepEqual(bgmInput({ offset: 0 }, { filename: 'x.mp3', offset: 0 }), {
        id: 'nse.bgm.change',
        data: { file: { before: null, after: { text: 'x.mp3' } } },
    })
})

test('group property values distinguish clear from zero and retain typed target identity', () => {
    const old = { name: '12{1}<b>??', forceNoteSpeed: 8.123456789012344 }
    const cleared = capture(groupEditInput(7, old, 'forceNoteSpeed', undefined))
    assert.deepEqual(cleared.data, {
        target: { kind: 'group', id: 7, name: { text: old.name } },
        changes: [{ field: 'forceNoteSpeed', before: old.forceNoteSpeed, after: null }],
    })
    const zero = capture(groupEditInput(7, old, 'forceNoteSpeed', 0))
    assert.equal(zero.id, 'nse.owner.set')
    assert.notDeepEqual(zero.data, cleared.data)
    assert.equal(decodeOperation(zero).status, 'known')
})

test('historical names are literal immutable bounded excerpts', () => {
    const old = { name: '123{1}$&<b>??' }
    const operation = capture(groupEditInput(5, old, 'name', '??'.repeat(257)))
    old.name = 'Later'
    assert.equal(operation.id, 'nse.owner.rename')
    assert.deepEqual(operation.data, {
        target: { kind: 'group', id: 5, name: { text: '123{1}$&<b>??' } },
        before: { text: '123{1}$&<b>??' },
        after: { text: '??'.repeat(256), truncated: true },
    })
})

test('stage properties capture exact booleans and enum transitions under the stage domain', () => {
    const cases = [
        ['isFromStart', true],
        ['isUntilEnd', true],
        ['generateSimLines', 'isolated'],
    ] as const
    for (const [field, after] of cases) {
        const operation = capture(stageEditInput(8, stage, field, after))
        assert.deepEqual(operation.data, {
            target: { kind: 'stage', id: 8, name: { text: 'Main' } },
            changes: [{ field, before: stage[field], after }],
        })
        assert.equal(decodeOperation(operation).status, 'known')
    }
    assert.deepEqual(stageEditInput(8, stage, 'name', 'Side'), {
        id: 'nse.owner.rename',
        data: {
            target: { kind: 'stage', id: 8, name: { text: 'Main' } },
            before: { text: 'Main' },
            after: { text: 'Side' },
        },
    })
})
