import assert from 'node:assert/strict'
import test from 'node:test'
import { alignFraction, safeUnlerp, safeUnlerpClamped } from '../../src/utils/math'

test('safe unlerps take a fixed fraction for spans under 1e-6, as the engine does', () => {
    assert.equal(safeUnlerp(2, 2, 2), 0.5)
    assert.equal(safeUnlerp(2, 2 + 1e-7, 3), 0.5)
    assert.equal(safeUnlerp(2, 2, 2, 0), 0)
    assert.equal(safeUnlerp(2, 4, 5), 1.5)
    assert.equal(safeUnlerpClamped(2, 2, 2), 0.5)
    assert.equal(
        safeUnlerpClamped(2.9333333333333336, 2.9333333333333336, 2.9333333333333336, 1),
        1,
    )
    assert.equal(safeUnlerpClamped(2, 4, 3), 0.5)
    assert.equal(safeUnlerpClamped(2, 4, 5), 1)
    assert.equal(safeUnlerpClamped(2, 4, 1), 0)
})

test('alignFraction only removes float noise: deliberate offsets and typed decimals stay', () => {
    // A seeded generator, so a failure repeats.
    let seed = 1
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
    for (let i = 0; i < 200_000; i++) {
        const value = random() * 1000
        // Within 1e-11 of the fraction, which then rounds once.
        const error = Math.abs(alignFraction(value) - value)
        assert.ok(error <= 1e-11 + value * Number.EPSILON, `${value}`)
    }
    // A line k/d of the editor's divisions, offset by 1e-9 to 1e-6 either way.
    for (let i = 0; i < 200_000; i++) {
        const division = 1 + Math.floor(random() * 16)
        const line = Math.floor(random() * 1000 * division) / division
        const offset = 10 ** (-9 + 3 * random()) * (random() < 0.5 ? -1 : 1)
        const value = line + offset
        if (value < 0) continue
        assert.equal(alignFraction(value), value, `${line} ${offset}`)
    }
    // Typed decimals, up to 6 places, are at least 1e-10 from any other small fraction.
    for (let i = 0; i < 200_000; i++) {
        const value = Number((random() * 1000).toFixed(6))
        assert.equal(alignFraction(value), value, `${value}`)
    }
    // Noise off a small fraction goes.
    assert.equal(alignFraction(1 / 3 + 4 / 3), 5 / 3)
    assert.equal(alignFraction(14.999999999999998), 15)
    assert.equal(alignFraction(-1e-17), 0)
})
