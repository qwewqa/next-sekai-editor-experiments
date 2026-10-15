import assert from 'node:assert/strict'
import test from 'node:test'
import { tessellateStroke } from '../../src/rendering/geometry'
import { DrawPath } from '../../src/rendering/path'

const contains = (triangles: Float64Array, x: number, y: number) => {
    for (let i = 0; i < triangles.length; i += 6) {
        const sides = []
        for (let j = 0; j < 3; j++) {
            const a = i + j * 2,
                b = i + ((j + 1) % 3) * 2
            sides.push(
                (triangles[b]! - triangles[a]!) * (y - triangles[a + 1]!) -
                    (triangles[b + 1]! - triangles[a + 1]!) * (x - triangles[a]!),
            )
        }
        if (sides.every((side) => side >= -1e-10) || sides.every((side) => side <= 1e-10))
            return true
    }
    return false
}

// These are the three paths in webglContext's fractional dashed-round scene.
// The retained path is tessellated before its draw transform. The current path
// stroked after resetTransform already contains the renderer's Float32 CTM.
const cases = [
    { name: 'identity', from: [12.25, 16.75], to: [132.5, 32.125], width: 2.75, tolerance: 0.1 },
    { name: 'retained', from: [8.125, 12.75], to: [124.25, 36.5], width: 2.75, tolerance: 0.05 },
    {
        name: 'reset current path',
        from: [Math.fround(0.8) * 16.25 + 20.25, Math.fround(1.1) * 60.125 + 40.75],
        to: [Math.fround(0.8) * 120.75 + 20.25, Math.fround(1.1) * 72.5 + 40.75],
        width: 1.25,
        tolerance: 0.1,
    },
] as const

for (const { name, from, to, width, tolerance } of cases) {
    test(`round dashed caps have no degenerate ears and preserve capsule coverage: ${name}`, () => {
        const path = new DrawPath()
        path.moveTo(from[0], from[1])
        path.lineTo(to[0], to[1])
        const triangles = tessellateStroke(
            path,
            {
                width,
                cap: 'round',
                join: 'miter',
                miterLimit: 10,
                dash: [7.25, 3.5],
                dashOffset: 1.75,
            },
            tolerance,
        )
        assert.ok(triangles.length > 0)
        assert.equal(triangles.length % 6, 0)
        assert.ok(triangles.every(Number.isFinite))

        const length = Math.hypot(to[0] - from[0], to[1] - from[1])
        const dx = (to[0] - from[0]) / length,
            dy = (to[1] - from[1]) / length,
            radius = width / 2
        // Independent analytic intervals for this fixed dash pattern and phase.
        const intervals: [number, number][] = []
        for (let k = 0; 10.75 * k - 1.75 < length; k++)
            intervals.push([Math.max(0, 10.75 * k - 1.75), Math.min(length, 10.75 * k + 5.5)])

        let area = 0
        for (let i = 0; i < triangles.length; i += 6) {
            const ax = triangles[i]!,
                ay = triangles[i + 1]!,
                bx = triangles[i + 2]!,
                by = triangles[i + 3]!,
                cx = triangles[i + 4]!,
                cy = triangles[i + 5]!
            const twiceArea = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
            assert.notEqual(twiceArea, 0, `triangle ${i / 6} must not be a collinear cap ear`)
            area += Math.abs(twiceArea) / 2
        }
        for (let i = 0; i < triangles.length; i += 2) {
            const x = triangles[i]! - from[0],
                y = triangles[i + 1]! - from[1]
            const along = x * dx + y * dy,
                across = -x * dy + y * dx
            const distance = Math.min(
                ...intervals.map(([start, end]) =>
                    Math.hypot(Math.max(start - along, 0, along - end), across),
                ),
            )
            assert.ok(distance <= radius + 1e-10, 'vertices stay within the ideal dash capsules')
        }

        const bodies = intervals.reduce((sum, [start, end]) => sum + width * (end - start), 0)
        const idealArea = bodies + intervals.length * Math.PI * radius ** 2
        // A polygon within the requested sagitta error contains a concentric
        // circle of radius r - tolerance. This bound does not prescribe its mesh.
        const minimumArea = bodies + intervals.length * Math.PI * (radius - tolerance) ** 2
        assert.ok(area >= minimumArea, `caps retain their area: ${area} >= ${minimumArea}`)
        assert.ok(
            area <= idealArea + 1e-9,
            `caps do not exceed their ideal area: ${area} <= ${idealArea}`,
        )

        const covered = (along: number, across = 0) =>
            contains(
                triangles,
                from[0] + dx * along - dy * across,
                from[1] + dy * along + dx * across,
            )
        const inset = (radius - tolerance) * 0.75
        for (const [start, end] of intervals) {
            assert.ok(covered(start - inset), 'leading cap interior remains covered')
            assert.ok(covered(end + inset), 'trailing cap interior remains covered')
            assert.ok(covered((start + end) / 2, inset), 'upper ribbon interior remains covered')
            assert.ok(covered((start + end) / 2, -inset), 'lower ribbon interior remains covered')
        }
        for (let i = 1; i < intervals.length; i++)
            assert.ok(
                !covered((intervals[i - 1]![1] + intervals[i]![0]) / 2),
                'dash gaps stay empty',
            )
    })
}
