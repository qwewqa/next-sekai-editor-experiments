import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arrowOutline, tiltDegrees } from '../../builtin-assets/arrows.mjs'

// The engine moves a diagonal arrow 26.6 degrees off vertical at every width, so each one points
// the same way at every width: the base's tilt, towards the left, up or down.
test('diagonal arrows point at the same tilt at every width', () => {
    for (const [direction, sign] of [
        ['upLeft', 1],
        ['downLeft', -1],
    ])
        for (let width = 1; width <= 6; width++) {
            const { tip, tail } = arrowOutline(direction, width)
            const [dx, dy] = [tip[0] - tail[0], tip[1] - tail[1]]
            assert.ok(
                dx < 0 && Math.sign(dy) === sign,
                `${direction} ${width}: points the wrong way`,
            )
            const degrees = (Math.atan2(-dx, Math.abs(dy)) * 180) / Math.PI
            assert.ok(
                Math.abs(degrees - tiltDegrees) <= 0.5,
                `${direction} ${width}: ${degrees.toFixed(1)} degrees`,
            )
        }
})
