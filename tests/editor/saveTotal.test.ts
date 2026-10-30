import assert from 'node:assert/strict'
import test from 'node:test'
import { totalOf } from '../../src/editor/save/total'

// The Save dialog's total adds the ticked rows; a ticked row whose size is unknown leaves the
// total unknown instead of counting it as 0.

const estimate = { base: 100, history: 40, bgm: 1000, fallbackBgm: 400 }

test('the total adds the ticked rows', () => {
    assert.equal(totalOf(estimate, { history: false, bgm: false }), 500)
    assert.equal(totalOf(estimate, { history: true, bgm: false }), 540)
    assert.equal(totalOf(estimate, { history: true, bgm: true }), 1140)
})

test('an unknown BGM size makes the total unknown only while the BGM is ticked', () => {
    const unknown = { base: 100, history: 40, fallbackBgm: 400 }
    assert.equal(totalOf(unknown, { history: true, bgm: true }), undefined)
    assert.equal(totalOf(unknown, { history: false, bgm: true }), undefined)
    assert.equal(totalOf(unknown, { history: true, bgm: false }), 540)
    assert.equal(
        totalOf({ base: 100, history: 40, bgm: 1000 }, { history: false, bgm: false }),
        undefined,
    )
})
