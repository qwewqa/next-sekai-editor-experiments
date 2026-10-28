import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BAND_MARGIN,
    bandKeyRange,
    bandsTooTall,
    keysToBands,
} from '../../../src/editor/minimap/diff'
import { createMapping } from '../../../src/editor/minimap/mapping'
import { calculateBpms, type BpmIntegral } from '../../../src/state/integrals/bpms'

// 60 BPM up to beat 10 (10 s), then 120 BPM: beat 12 is at 11 s.
const bpms: BpmIntegral[] = calculateBpms([
    { x: 0, y: 0, s: 1 },
    { x: 10, y: 10, s: 0.5 },
])
const rowAt = (time: number, scale: number) => (17 + (400 - 21) * (1 - time / 100)) * scale

test('keys become device rows on the tempo they are in, with margins', () => {
    for (const scale of [1, 2]) {
        const mapping = createMapping({ width: 40, height: 400, scale }, 100)
        const [fast, slow] = keysToBands([5, 12], bpms, mapping)
        assert.ok(slow && fast)
        // Beats 5 to 6 at 60 BPM are 5 s to 6 s.
        assert.equal(slow.top, Math.floor(rowAt(6, scale) - BAND_MARGIN))
        assert.equal(slow.bottom, Math.ceil(rowAt(5, scale) + BAND_MARGIN))
        // Beats 12 to 13 at 120 BPM are 11 s to 11.5 s. A flat 60 BPM would put them at 12 s.
        assert.equal(fast.top, Math.floor(rowAt(11.5, scale) - BAND_MARGIN))
        assert.equal(fast.bottom, Math.ceil(rowAt(11, scale) + BAND_MARGIN))
    }
})

test('touching and overlapping bands merge, far ones do not', () => {
    const mapping = createMapping({ width: 40, height: 400, scale: 1 }, 100)
    const merged = keysToBands([3, 4, 5], bpms, mapping)
    assert.equal(merged.length, 1)
    assert.equal(merged[0]?.top, Math.floor(rowAt(6, 1) - BAND_MARGIN))
    assert.equal(merged[0]?.bottom, Math.ceil(rowAt(3, 1) + BAND_MARGIN))
    // Margins make bands one key apart overlap at this scale (one key is about 4 rows).
    assert.equal(keysToBands([3, 5], bpms, mapping).length, 1)
    assert.equal(keysToBands([3, 40], bpms, mapping).length, 2)
})

test('bands stay inside the canvas', () => {
    const mapping = createMapping({ width: 40, height: 400, scale: 1 }, 100)
    const [first] = keysToBands([0], bpms, mapping)
    assert.ok(first && first.bottom <= 400 && first.bottom > 396)
    const [last] = keysToBands([99], bpms, createMapping({ width: 40, height: 400, scale: 1 }, 10))
    assert.ok(last && last.top >= 0)
})

test('bands past a third of the canvas call for a full redraw', () => {
    assert.equal(bandsTooTall([{ top: 0, bottom: 133 }], 400), false)
    assert.equal(
        bandsTooTall(
            [
                { top: 0, bottom: 100 },
                { top: 200, bottom: 240 },
            ],
            400,
        ),
        true,
    )
})

test('the keys a band touches reach a note beyond it, and are open at both ends', () => {
    const mapping = createMapping({ width: 40, height: 400, scale: 1 }, 100)
    const middle = { top: Math.floor(rowAt(9, 1)), bottom: Math.ceil(rowAt(8, 1)) }
    const range = bandKeyRange(middle, bpms, mapping)
    assert.ok(range.lo <= 8 && range.hi >= 8)
    assert.ok(range.hi - range.lo <= 3)
    assert.equal(bandKeyRange({ top: 0, bottom: 20 }, bpms, mapping).hi, Infinity)
    assert.equal(bandKeyRange({ top: 380, bottom: 400 }, bpms, mapping).lo, -Infinity)
})
