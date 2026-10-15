import assert from 'node:assert/strict'
import test from 'node:test'
import { ease } from '../../src/ease'
import { createEventPath, createRangeEventPaths } from '../../src/editor/entities/events/path'

test('quadratic event curves preserve their exact controls and midpoint joins', () => {
    const cases = {
        linear: [
            ['moveTo', -2, 8],
            ['lineTo', 6, -4],
        ],
        inQuad: [
            ['moveTo', -2, 8],
            ['quadraticCurveTo', -2, 2, 6, -4],
        ],
        outQuad: [
            ['moveTo', -2, 8],
            ['quadraticCurveTo', 6, 2, 6, -4],
        ],
        inOutQuad: [
            ['moveTo', -2, 8],
            ['quadraticCurveTo', -2, 5, 2, 2],
            ['quadraticCurveTo', 6, -1, 6, -4],
        ],
        outInQuad: [
            ['moveTo', -2, 8],
            ['quadraticCurveTo', 2, 5, 2, 2],
            ['quadraticCurveTo', 2, -1, 6, -4],
        ],
    }
    for (const eventEase of Object.keys(cases) as (keyof typeof cases)[])
        assert.deepEqual(createEventPath(-2, 6, 8, -4, eventEase).commands, cases[eventEase])
})

test('sampled curves retain the engine endpoint and overshoot values', () => {
    for (const eventEase of ['outBack', 'inBack', 'outElastic', 'inOutElastic'] as const) {
        const commands = createEventPath(0, 2, 0, -4, eventEase).commands
        assert.deepEqual(commands[0], ['moveTo', 2 * ease(eventEase, 0), 0])
        assert.deepEqual(commands.at(-1), ['lineTo', 2 * ease(eventEase, 1), -4])
        assert.ok(commands.length > 2)
        for (const command of commands) {
            assert.ok(command[0] === 'moveTo' || command[0] === 'lineTo')
            const [, x, y] = command
            assert.equal(x, 2 * ease(eventEase, y === 0 ? 0 : y / -4))
        }
    }
})

test('floored ranges stay centered through easing overshoot while their width shrinks', () => {
    for (const eventEase of ['inBack', 'outBack', 'inOutElastic'] as const) {
        const [left, right] = createRangeEventPaths([-1, 1], [4, 4.01], 0, -4, eventEase, 0.02)
        assert.equal(left.commands.length, right.commands.length)
        let atFloor = false
        for (let i = 0; i < left.commands.length; i++) {
            const l = left.commands[i]!,
                r = right.commands[i]!
            assert.ok(l[0] === 'moveTo' || l[0] === 'lineTo')
            assert.ok(r[0] === 'moveTo' || r[0] === 'lineTo')
            assert.equal(l[2], r[2])
            const q = ease(eventEase, l[2] / -4)
            const center = 4.005 * q
            const width = Math.max(0.02, 2 + (0.01 - 2) * q)
            assert.ok(Math.abs((l[1] + r[1]) / 2 - center) < 1e-12)
            assert.ok(Math.abs(r[1] - l[1] - width) < 1e-12)
            if (Math.abs(width - 0.02) < 1e-12) atFloor = true
        }
        assert.ok(atFloor)
    }
})

test('overflow keeps only the valid event prefix and never resumes after an invalid segment', () => {
    for (const eventEase of ['inOutQuad', 'outInQuad'] as const)
        assert.deepEqual(createEventPath(-1e308, 1e308, 0, 1, eventEase).commands, [
            ['moveTo', -1e308, 0],
        ])
    assert.deepEqual(createEventPath(-1e308, 1e308, 0, 1, 'outInStep').commands, [])
    assert.deepEqual(createEventPath(0, 2, 0, Infinity, 'inOutStep').commands, [['moveTo', 0, 0]])
    assert.deepEqual(createEventPath(-1e308, 1e308, 0, 1, 'linear').commands, [
        ['moveTo', -1e308, 0],
        ['lineTo', 1e308, 1],
    ])
})

test('floored ranges retain interpolation overflow behavior independently on each edge', () => {
    assert.deepEqual(
        createRangeEventPaths([-1e308, 1e308], [-1e308, 1e308], 0, 1, 'linear', 0.02).map(
            (path) => path.commands,
        ),
        [[], []],
    )
    // These held pieces still interpolate their endpoint times. An overflowing
    // time span invalidates the first point instead of resuming after the gap.
    assert.deepEqual(
        createRangeEventPaths([2, 2], [-1, 1], -1e308, 1e308, 'inOutStep', 0.02).map(
            (path) => path.commands,
        ),
        [[], []],
    )
})
