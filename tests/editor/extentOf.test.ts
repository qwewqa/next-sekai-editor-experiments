import assert from 'node:assert/strict'
import test from 'node:test'
import type { ElevationNote } from '../../src/editor/elevation/layout'
import { elevationViewport, fitElevationViewport } from '../../src/editor/elevation/viewport'
import { extentOf } from '../../src/utils/math'

test('extentOf takes the smallest and largest of a huge array, where a spread throws', () => {
    const values = Array.from({ length: 500_000 }, (_, i) => (i * 7919) % 100_003)
    assert.throws(() => Math.min(...values), RangeError)
    assert.deepEqual(extentOf(values), { min: 0, max: 100_002 })
    assert.deepEqual(extentOf([]), { min: Infinity, max: -Infinity })
    assert.deepEqual(extentOf(new Set([3, -1, 2])), { min: -1, max: 3 })
})

test('the Elevation Editor fits a very large selection', () => {
    const notes = Array.from(
        { length: 500_000 },
        (_, i) => ({ elevation: i % 3 }) as unknown as ElevationNote,
    )
    assert.doesNotThrow(() => fitElevationViewport(600, notes, 100))
    assert.ok(Number.isFinite(elevationViewport.center))
})
