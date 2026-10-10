import assert from 'node:assert/strict'
import test from 'node:test'
import { formatNumber } from '../../src/modals/form/fieldUsage'
import { addDecimal, createStepTrail, stepNumber } from '../../src/modals/form/numberStep'

test('steps add in decimal, without float noise', () => {
    assert.equal(addDecimal(1.1, -1), 0.1)
    assert.equal(addDecimal(2.3, -1), 1.3)
    assert.equal(addDecimal(8.2, -1), 7.2)
    assert.equal(addDecimal(4.35, -1), 3.35)
    assert.equal(addDecimal(1.123456789, -1), 0.123456789)
    assert.equal(addDecimal(4 / 3, -1), 1 / 3)
    assert.equal(addDecimal(-0.7, 1), 0.3)
    assert.equal(addDecimal(-2.5, -1), -3.5)
    // A displayed beat steps exactly by 1.
    assert.equal(addDecimal(37.458333333333336, 1), 38.458333333333336)
    // Exponent forms count their exponent.
    assert.equal(addDecimal(1e-7, 1), 1.0000001)
    assert.equal(addDecimal(1.0000001, -1), 1e-7)
    assert.equal(addDecimal(2.5e-16, 1), 1 + 2.5e-16)
    assert.equal(addDecimal(1e21, 1), 1e21 + 1)
    assert.equal(addDecimal(-1e-7, -1), -1.0000001)
})

test('a step and its reverse return the exact value', () => {
    for (const value of [0.3, 0.1, 1 / 3, 0.123456789, -0.3, 36.458333333333336, 1e-7]) {
        assert.equal(addDecimal(addDecimal(value, 1), -1), value, `${value} up, down`)
        assert.equal(addDecimal(addDecimal(value, -1), 1), value, `${value} down, up`)
    }
})

test('a step back returns exactly where the last step began', () => {
    const step = createStepTrail()
    // Adding back alone leaves 2/3 an ulp off.
    assert.notEqual(addDecimal(addDecimal(2 / 3, 1), -1), 2 / 3)
    assert.equal(step(step(2 / 3, 1, {}), -1, {}), 2 / 3)
    const twice = step(step(2 / 3, 1, {}), 1, {})
    assert.equal(step(step(twice, -1, {}), -1, {}), 2 / 3)
    // A step stopped at a limit steps back natively.
    const limits = { min: 0, max: 1 }
    assert.equal(step(0.7, 1, limits), 1)
    assert.equal(step(1, -1, limits), 0)
    // Only from where the last step ended.
    const up = step(2 / 3, 1, {})
    assert.equal(step(up + 1, -1, {}), addDecimal(up + 1, -1))
})

test('steps stop at the limit they would pass, as native steps do', () => {
    const rows: [number, number, Parameters<typeof stepNumber>[2], number][] = [
        [1.5, -1, { min: 1 }, 1],
        [23.99999, 1, { min: 6, max: 24 }, 24],
        [0.7, 1, { min: 0, max: 1 }, 1],
        [0.3, -1, { min: 0, max: 1 }, 0],
        [1, 1, { min: 0, max: 1 }, 1],
        [0, -1, { min: 0, max: 1 }, 0],
        // Past a limit already, only a step back toward it moves.
        [-5, 1, { min: 0, max: 1 }, 0],
        [-5, -1, { min: 0, max: 1 }, -5],
        [7, -1, { min: 0, max: 1 }, 1],
        [7, 1, { min: 0, max: 1 }, 7],
        [-0.5, 1, { min: 0, max: 1 }, 0.5],
        [1.1, -1, {}, 0.1],
        [2.5, -1, { min: 1 }, 1.5],
        [1, -1, { min: 1 }, 1],
        [0.0100001, -1, { min: 0.01 }, 0.01],
        // A meter is above 0, never at a stand-in minimum.
        [1, -1, { min: Number.EPSILON, exclusiveMin: true }, 1],
        [1.5, -1, { min: Number.EPSILON, exclusiveMin: true }, 0.5],
        [0.5, 1, { min: Number.EPSILON, exclusiveMin: true }, 1.5],
    ]
    for (const [from, delta, limits, expected] of rows)
        assert.equal(stepNumber(from, delta, limits), expected, `${from} by ${delta}`)
})

test('numbers show to 4 decimals, and small ones keep 4 digits rather than show 0', () => {
    assert.equal(formatNumber(0.123456789), '0.1235')
    assert.equal(formatNumber(37.458333333333336), '37.4583')
    assert.equal(formatNumber(3), '3')
    assert.equal(formatNumber(-2.5), '-2.5')
    assert.equal(formatNumber(0), '0')
    assert.equal(formatNumber(-0), '0')
    assert.equal(formatNumber(0.00001), '0.00001')
    assert.equal(formatNumber(-0.00001), '-0.00001')
    assert.equal(formatNumber(0.0000123456), '0.00001235')
    assert.equal(formatNumber(1e-7), '1e-7')
    assert.equal(formatNumber(Number.EPSILON), '2.22e-16')
    assert.equal(formatNumber(0.00004), '0.00004')
    assert.equal(formatNumber(0.00005), '0.0001')
})
