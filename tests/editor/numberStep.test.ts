import assert from 'node:assert/strict'
import test from 'node:test'
import { fromDisplayedBeat, toDisplayedBeat } from '../../src/editor/beatDisplay'
import { fromFieldBeat, fromSteppedBeat, toFieldBeat } from '../../src/modals/form/beatField'
import {
    addDecimal,
    alignFraction,
    createStepTrail,
    isChromium,
    stepNumber,
    stepValues,
} from '../../src/modals/form/numberStep'
import { formatNumber } from '../../src/utils/formatNumber'

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
        // Typed below it, a step up still moves.
        [-5, 1, { min: Number.EPSILON, exclusiveMin: true }, -4],
        [-5, -1, { min: Number.EPSILON, exclusiveMin: true }, -5],
        // A whole-number step snaps a typed fraction to its grid, as native steps do.
        [2.5, 1, { min: 1, step: 1 }, 3],
        [2.5, -1, { min: 1, step: 1 }, 2],
        [1.2, -1, { min: 1, step: 1 }, 1],
        [3, 1, { min: 1, step: 1 }, 4],
        [1, -1, { min: 1, step: 1 }, 1],
        [0.5, 1, { min: 1, step: 1 }, 1],
        [0.5, -1, { min: 1, step: 1 }, 0.5],
        [2.5, 1, { min: 1, step: 'any' }, 3.5],
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

test('the wheel steps where Chromium would, on any origin', () => {
    const chrome = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0'
    const rows: [string, boolean][] = [
        [`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${chrome} Safari/537.36`, true],
        [`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${chrome} Safari/537.36 Edg/129.0.0.0`, true],
        [`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${chrome} Safari/537.36 OPR/114.0.0.0`, true],
        [
            'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
            true,
        ],
        [`Mozilla/5.0 (Linux; Android 10; K) ${chrome} Mobile Safari/537.36`, true],
        [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/129.0.0.0 Safari/537.36',
            true,
        ],
        [
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/129.0.0.0',
            true,
        ],
        ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0', false],
        ['Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0', false],
        [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
            false,
        ],
        // Every iOS browser is WebKit.
        [
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
            false,
        ],
        [
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/129.0.2792.84 Mobile/15E148 Safari/605.1.15',
            false,
        ],
        [
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
            false,
        ],
    ]
    for (const [userAgent, expected] of rows)
        assert.equal(isChromium({ userAgent }), expected, userAgent)
    assert.equal(isChromium({ userAgent: '', userAgentData: {} } as { userAgent: string }), true)
})

test('a beat stepped by whole beats stays on its grid', () => {
    // As the Beat field steps: in displayed space, then back to the chart's beat.
    const stepBeat = (beat: number, delta: number) =>
        fromSteppedBeat(stepNumber(toFieldBeat(beat), delta, { min: 1 }))
    assert.notEqual(fromDisplayedBeat(addDecimal(toDisplayedBeat(1 / 3), 1)), 4 / 3)
    assert.equal(stepBeat(1 / 3, 1), 4 / 3)
    for (const division of [3, 5, 6, 7, 9, 10, 11, 12, 24, 48, 192, 480, 1920]) {
        for (let k = 0; k < 600 * division; k += division > 48 ? 13 : 1) {
            const at = `${k}/${division}`
            assert.equal(stepBeat(k / division, 1), (k + division) / division, at)
            if (k >= division)
                assert.equal(stepBeat(k / division, -1), (k - division) / division, at)
        }
    }
    // Off any grid, a step keeps its decimals.
    assert.equal(stepBeat(0.123456789, 1), 1.123456789)
    assert.equal(alignFraction(0.123456789), 0.123456789)
    assert.equal(alignFraction(2.5), 2.5)
})

test('mixed values stepped back to their own leave nothing changed', () => {
    const trails = new Map<unknown, ReturnType<typeof createStepTrail>>()
    const origins = new Map<unknown, number>([
        [-4, -4],
        [0, 0],
        [2 / 3, 2 / 3],
    ])
    const step = (steps: Map<unknown, number> | undefined, delta: number) =>
        stepValues(origins, steps, (value, from) => {
            let trail = trails.get(value)
            if (!trail) trails.set(value, (trail = createStepTrail()))
            return trail(from, delta, {})
        })
    const up = step(undefined, 1)
    assert.deepEqual(up.changed, [-4, 0, 2 / 3])
    assert.deepEqual([...up.next.values()], [-3, 1, addDecimal(2 / 3, 1)])
    const down = step(up.next, -1)
    assert.deepEqual(down.changed, [])
    assert.deepEqual([...down.next.values()], [-4, 0, 2 / 3])
    // A value held at a limit is unchanged from the first step.
    assert.deepEqual(
        stepValues(new Map([[1, 1]]), undefined, (_, from) => stepNumber(from, 1, { max: 1 }))
            .changed,
        [],
    )
})

test('a typed beat holds its decimals, without noise from the 1-based display', () => {
    assert.notEqual(fromDisplayedBeat(1.01), 0.01)
    assert.equal(fromFieldBeat(1.01), 0.01)
    assert.equal(fromFieldBeat(2.1), 1.1)
    assert.equal(fromFieldBeat(1.0625), 0.0625)
    assert.equal(fromFieldBeat(1.001), 0.001)
    // Many digits keep them.
    assert.equal(fromFieldBeat(Number('1.123456789012345678')), 0.1234567890123457)
    assert.equal(fromFieldBeat(1.123456789), 0.123456789)
    // Shown the other way without noise too.
    assert.notEqual(toDisplayedBeat(0.14), 1.14)
    assert.equal(toFieldBeat(0.14), 1.14)
    for (const places of [1, 2, 3, 4, 6]) {
        const scale = 10 ** places
        for (let i = 0; i < 50000; i++) {
            const k = (i * 7919) % (3000 * scale)
            const shown = Number(((k + scale) / scale).toFixed(places))
            const held = Number((k / scale).toFixed(places))
            assert.equal(fromFieldBeat(shown), held, `${shown}`)
            assert.equal(toFieldBeat(held), shown, `${held}`)
        }
    }
})
