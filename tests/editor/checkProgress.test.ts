import assert from 'node:assert/strict'
import test from 'node:test'
import { phaseFraction } from '../../src/editor/check/progress'

// Check's bar slides until a phase has a batch behind it, so a bar at 0 never looks like an
// empty track.

test('the first batch of a phase has no fraction, so the bar slides while the check waits', () => {
    assert.equal(phaseFraction(0, 0, 1000), undefined)
})

test('a later batch shows the share of the phase done before it', () => {
    assert.equal(phaseFraction(1, 250, 1000), 25)
    assert.equal(phaseFraction(3, 999, 1000), 99)
})

test('a phase with nothing to count has no fraction', () => {
    assert.equal(phaseFraction(2, 0, 0), undefined)
})
