import assert from 'node:assert/strict'
import test from 'node:test'
import { snappedOffset } from '../../src/editor/snapping'

test('relative snapping preserves an off-grid anchor and rounds only the drag distance', () => {
    assert.equal(snappedOffset(1.3, 1.71, 0.15, 4, 'relative'), 0.5)
    assert.equal(snappedOffset(1.3, 0.89, 0.15, 4, 'relative'), -0.5)
})

test('absolute snapping aligns the object position while preserving the pointer grab offset', () => {
    assert.ok(Math.abs(snappedOffset(1.3, 1.71, 0.15, 4, 'absolute') - 0.35) < 1e-12)
    assert.ok(Math.abs(snappedOffset(1.3, 0.89, 0.15, 4, 'absolute') + 0.4) < 1e-12)
})

test('the default whole-lane relative snapping keeps existing drag behavior', () => {
    assert.equal(snappedOffset(-2.2, -1.8, -3.25, 1, 'relative'), 0)
    assert.equal(snappedOffset(-2.2, -1.6, -3.25, 1, 'relative'), 1)
})

test('absolute snapping waits for half a step of pointer movement and snaps relatively until then', () => {
    // A note at 0.37 dragged along the other axis stays put.
    assert.equal(snappedOffset(2, 2, 0.37, 1, 'absolute', 0), 0)
    assert.equal(snappedOffset(2, 2.49, 0.37, 1, 'absolute', 0.49), 0)
    assert.equal(snappedOffset(2, 1.51, 0.37, 1, 'absolute', -0.49) + 0, 0)
    // From half a step on, it lands on the grid.
    assert.ok(Math.abs(snappedOffset(2, 2.5, 0.37, 1, 'absolute', 0.5) - 0.63) < 1e-12)
    assert.ok(Math.abs(snappedOffset(2, 1.49, 0.37, 1, 'absolute', -0.51) + 0.37) < 1e-12)
    // Half a step is half a lane division.
    assert.equal(snappedOffset(2, 2.12, 0.37, 4, 'absolute', 0.12), 0)
    assert.ok(Math.abs(snappedOffset(2, 2.13, 0.37, 4, 'absolute', 0.13) - 0.13) < 1e-12)
    // A stage shift the pointer didn't make snaps relatively.
    assert.equal(snappedOffset(2, 2.7, 0.37, 1, 'absolute', 0.1), 1)
    // Relative snapping ignores the pointer movement.
    assert.equal(snappedOffset(2, 2.49, 0.37, 1, 'relative', 0.49), 0)
    assert.equal(snappedOffset(2, 2.7, 0.37, 1, 'relative', 0.7), 1)
})

test('the half-step wait never moves an on-grid object differently', () => {
    for (const division of [1, 2, 3, 4, 8]) {
        for (let k = -8; k <= 8; k++) {
            const anchor = k / division
            for (let d = -0.49 / division; d <= 0.49 / division; d += 0.07 / division) {
                const waited = snappedOffset(1, 1 + d, anchor, division, 'absolute', d)
                const snapped = snappedOffset(1, 1 + d, anchor, division, 'absolute')
                assert.ok(Math.abs(waited - snapped) < 1e-12)
            }
        }
    }
})

test('the movement is monotonic across the half-step boundary', () => {
    let previous = -Infinity
    for (let d = -2; d <= 2; d += 0.01) {
        const value = 0.37 + snappedOffset(0, d, 0.37, 1, 'absolute', d)
        assert.ok(value >= previous)
        previous = value
    }
})
