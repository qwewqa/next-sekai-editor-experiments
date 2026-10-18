import assert from 'node:assert/strict'
import test from 'node:test'
import {
    clearHistoryView,
    historyViewGeneration,
    rememberedHistoryView,
    rememberHistoryView,
    restoreHistoryView,
    type HistoryViewMemory,
} from '../../src/editor/history/state'
import { notifyResetState } from '../../src/history/resetHooks'
import { session } from '../../src/history/session'

const saved = (): HistoryViewMemory => ({
    sessionId: session.value.sessionId,
    cursorId: 'selected',
    anchorId: 'anchor',
    offset: 13,
    window: { first: 'newest', last: 'oldest', gap: true },
})

test('dialog view restoration anchors by row identity after rows shift', () => {
    assert.deepEqual(
        restoreHistoryView(
            saved(),
            {
                ids: ['now', 'inserted', 'selected', 'anchor'],
                offsets: [4, 48, 92, 136],
            },
            'selected',
        ),
        { cursorId: 'selected', top: 149 },
    )
})

test('a vanished anchor falls back to the surviving selected row without selecting again', () => {
    assert.deepEqual(
        restoreHistoryView(
            saved(),
            {
                ids: ['now', 'survivor'],
                offsets: [4, 48],
            },
            'survivor',
        ),
        { cursorId: 'survivor', top: 48 },
    )
    assert.deepEqual(restoreHistoryView(saved(), { ids: ['now'], offsets: [4] }), {
        cursorId: 'now',
        top: 4,
    })
})

test('view memory is a single current-session descriptor and reset rejects stale unmounts', () => {
    clearHistoryView()
    const generation = historyViewGeneration()
    const first = saved()
    rememberHistoryView(first, generation)
    const second = { ...first, anchorId: 'other' }
    rememberHistoryView(second, generation)
    assert.equal(rememberedHistoryView(), second)
    rememberHistoryView({ ...first, sessionId: 'another-session' }, generation)
    assert.equal(rememberedHistoryView(), second)
    notifyResetState()
    assert.equal(rememberedHistoryView(), undefined)
    rememberHistoryView(first, generation)
    assert.equal(rememberedHistoryView(), undefined)
})
