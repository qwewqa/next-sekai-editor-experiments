import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSvgPath } from '../../src/rendering/pathSvg'

test('SVG repeated moves become lines and every new move resets the close destination', () => {
    assert.deepEqual(parseSvgPath('M0 0 20 0 M40 40 L50 50 Z l10 10').commands, [
        ['moveTo', 0, 0],
        ['lineTo', 20, 0],
        ['moveTo', 40, 40],
        ['lineTo', 50, 50],
        ['closePath'],
        ['lineTo', 50, 50],
    ])
    assert.deepEqual(parseSvgPath('m10 20 2 3 h4 v-5z m1 2').commands, [
        ['moveTo', 10, 20],
        ['lineTo', 12, 23],
        ['lineTo', 16, 23],
        ['lineTo', 16, 18],
        ['closePath'],
        ['moveTo', 11, 22],
    ])
})

test('SVG compact and scientific numbers preserve their sign and decimal boundaries', () => {
    assert.deepEqual(parseSvgPath('M.5-.25L1e2+2E-1 3.4.5').commands, [
        ['moveTo', 0.5, -0.25],
        ['lineTo', 100, 0.2],
        ['lineTo', 3.4, 0.5],
    ])
})

test('SVG smooth curves reflect only the preceding matching control point', () => {
    assert.deepEqual(parseSvgPath('M10 20 c1 2 3 4 5 6 s7 8 9 10 l2 3 s4 5 6 7').commands, [
        ['moveTo', 10, 20],
        ['bezierCurveTo', 11, 22, 13, 24, 15, 26],
        ['bezierCurveTo', 17, 28, 22, 34, 24, 36],
        ['lineTo', 26, 39],
        ['bezierCurveTo', 26, 39, 30, 44, 32, 46],
    ])
    assert.deepEqual(parseSvgPath('M10 20 q1 2 3 4 t5 6 z t1 2').commands, [
        ['moveTo', 10, 20],
        ['quadraticCurveTo', 11, 22, 13, 24],
        ['quadraticCurveTo', 15, 26, 18, 30],
        ['closePath'],
        ['quadraticCurveTo', 10, 20, 11, 22],
    ])
})

test('SVG zero-radius arcs become lines and coincident endpoints add no geometry', () => {
    assert.deepEqual(
        parseSvgPath('M1 2 A0 20 30 0 1 10 20 a5 0 0 0 0 4 5 A5 5 0 1 1 14 25').commands,
        [
            ['moveTo', 1, 2],
            ['lineTo', 10, 20],
            ['lineTo', 14, 25],
        ],
    )
})

test('SVG arc flags can abut each other and the endpoint number', () => {
    assert.deepEqual(
        parseSvgPath('M0 0 A10 20 30 0110 20').commands,
        parseSvgPath('M0 0 A10 20 30 0 1 10 20').commands,
    )
})

test('SVG elliptical arc conversion preserves endpoints, direction and corrected radii', () => {
    for (const large of [0, 1]) {
        for (const sweep of [0, 1]) {
            const command = parseSvgPath(`M10 20 A-25 -35 30 ${large} ${sweep} 60 70`).commands[1]
            assert.ok(command && command[0] === 'ellipse')
            const [, x, y, rx, ry, rotation, start, end, ccw] = command
            assert.ok(rx >= 25 && ry >= 35)
            assert.equal(ccw, !sweep)
            assert.equal(end >= start, !!sweep)
            const point = (angle: number) => [
                x +
                    Math.cos(rotation) * rx * Math.cos(angle) -
                    Math.sin(rotation) * ry * Math.sin(angle),
                y +
                    Math.sin(rotation) * rx * Math.cos(angle) +
                    Math.cos(rotation) * ry * Math.sin(angle),
            ]
            for (const [actual, expected] of [
                [point(start), [10, 20]],
                [point(end), [60, 70]],
            ]) {
                assert.ok(actual && expected)
                assert.ok(Math.abs(actual[0]! - expected[0]!) < 1e-7)
                assert.ok(Math.abs(actual[1]! - expected[1]!) < 1e-7)
            }
        }
    }
})

test('SVG parser stops at an incomplete or unknown command without inventing geometry', () => {
    for (const suffix of ['L2', 'L2x3', 'X2 3', 'A1 1 0 2 0 3 4', 'L1e999 2']) {
        assert.deepEqual(parseSvgPath(`M1 2 ${suffix}`).commands, [['moveTo', 1, 2]])
    }
    assert.deepEqual(parseSvgPath('L1 2').commands, [])
})
