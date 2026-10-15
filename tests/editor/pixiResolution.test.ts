import assert from 'node:assert/strict'
import test from 'node:test'
import type { GraphicsContext, Polygon } from 'pixi.js'
import { DrawGradient } from '../../src/rendering/paint'
import { DrawPath } from '../../src/rendering/path'
import { compilePath, PathGraphicsCache, resolutionScale } from '../../src/rendering/pathGraphics'
import { PathMeshGeometry } from '../../src/rendering/pathMesh'
import { PaintStyles } from '../../src/rendering/pixiPaint'
import { pathResourceGeometry as geometry } from './pixiGeometryTestUtils'

type Point = readonly [number, number]

function coverage(
    context: GraphicsContext | PathMeshGeometry,
    resolution: number,
    x: number,
    y: number,
) {
    const { vertices, indices } = geometry(context)
    x *= resolution
    y *= resolution
    let count = 0
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i]! * 2,
            b = indices[i + 1]! * 2,
            c = indices[i + 2]! * 2
        const cross = (from: number, to: number) =>
            (vertices[to]! - vertices[from]!) * (y - vertices[from + 1]!) -
            (vertices[to + 1]! - vertices[from + 1]!) * (x - vertices[from]!)
        const edges = [cross(a, b), cross(b, c), cross(c, a)]
        if (edges.every((v) => v > 1e-9) || edges.every((v) => v < -1e-9)) count++
    }
    return count
}

function distanceToSegment(point: Point, a: Point, b: Point) {
    const dx = b[0] - a[0],
        dy = b[1] - a[1]
    const fraction = Math.max(
        0,
        Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)),
    )
    return Math.hypot(point[0] - a[0] - fraction * dx, point[1] - a[1] - fraction * dy)
}

test('resolution buckets include maximum affine stretch and ignore translation', () => {
    assert.equal(resolutionScale([40, 0, 0, 100, 0, 0]), 128)
    assert.equal(resolutionScale([40, 0, 0, 100, 1e9, -1e9]), 128)
    assert.equal(
        resolutionScale([1.5, 0, 1.5, 1]),
        4,
        'shear requires the singular value, not the largest column norm',
    )
    assert.equal(resolutionScale([0, 1, -1, 0]), 1)
    assert.equal(resolutionScale([-2, 0, 0, 0.5]), 2)
    assert.equal(resolutionScale([1e-6, 0, 0, 1e-6]), 2 ** -8)
    assert.equal(resolutionScale([1e9, 0, 0, 1e9]), 2 ** 16)
    assert.equal(resolutionScale([0, 0, 0, 0]), 1)
    assert.equal(resolutionScale([NaN, 0, 0, 1]), 1)
})

test('native quadratic and cubic polylines stay within 0.12 device pixels at editor scales', () => {
    for (const kind of ['quadratic', 'cubic']) {
        const path = new DrawPath()
        path.moveTo(0, 0)
        if (kind === 'quadratic') path.quadraticCurveTo(2, 4, 4, 0)
        else path.bezierCurveTo(5, 5, -2, 4, 4, 0)
        for (const [label, sx, sy] of [
            ['DPR 1', 40, 100],
            ['DPR 2', 80, 200],
            ['DPR 3', 120, 300],
            ['maximum pps / narrow width', 16, 10000],
        ] as const) {
            const resolution = resolutionScale([sx, 0, 0, sy])
            const shape = compilePath(path, resolution).shapePath.shapePrimitives[0]?.shape
            assert.equal(shape?.type, 'polygon')
            const coordinates = (shape as Polygon).points
            const points: Point[] = []
            for (let i = 0; i < coordinates.length; i += 2)
                points.push([
                    (coordinates[i]! / resolution) * sx,
                    (coordinates[i + 1]! / resolution) * sy,
                ])
            let maximum = 0
            for (let i = 0; i <= 1000; i++) {
                const t = i / 1000,
                    u = 1 - t
                const expected: Point =
                    kind === 'quadratic'
                        ? [(4 * u * t + 4 * t * t) * sx, 8 * u * t * sy]
                        : [
                              (15 * u * u * t - 6 * u * t * t + 4 * t * t * t) * sx,
                              (15 * u * u * t + 12 * u * t * t) * sy,
                          ]
                let nearest = Infinity
                for (let j = 1; j < points.length; j++)
                    nearest = Math.min(
                        nearest,
                        distanceToSegment(expected, points[j - 1]!, points[j]!),
                    )
                maximum = Math.max(maximum, nearest)
            }
            assert.ok(maximum <= 0.12, `${kind}, ${label}: ${maximum} device pixels`)
        }
    }
})

test('very long straight quadratic and cubic curves do not acquire excessive subdivision', () => {
    for (const kind of ['quadratic', 'cubic']) {
        const path = new DrawPath()
        path.moveTo(0, 0)
        if (kind === 'quadratic') path.quadraticCurveTo(6144, 6144, 12288, 12288)
        else path.bezierCurveTo(4096, 4096, 8192, 8192, 12288, 12288)
        const resolution = 2 ** 16
        const shape = compilePath(path, resolution).shapePath.shapePrimitives[0]?.shape
        assert.equal(shape?.type, 'polygon')
        const points = (shape as Polygon).points
        assert.ok(points.length <= 10, `${kind}: ${points.length / 2} points for a straight curve`)
        assert.deepEqual(points.slice(0, 2), [0, 0])
        assert.deepEqual(points.slice(-2), [12288 * resolution, 12288 * resolution])
        for (let i = 0; i < points.length; i += 2) assert.equal(points[i], points[i + 1])
    }
})

test('round stroke caps gain detail at higher resolution without changing world-space width', () => {
    const cache = new PathGraphicsCache()
    const path = new DrawPath('M0 0 L2 0')
    const style = { color: 0, width: 0.2, cap: 'round' as const }
    try {
        const coarse = geometry(cache.get(path, style, true, 'nonzero', 'round', undefined, 1))
        for (const dpr of [1, 2, 3]) {
            const deviceScale = 40 * dpr
            const resolution = resolutionScale([deviceScale, 0, 0, deviceScale])
            const context = cache.get(path, style, true, 'nonzero', 'round', undefined, resolution)
            const result = geometry(context)
            assert.ok(result.vertices.length > coarse.vertices.length)
            const xs = result.vertices.filter((_, i) => !(i % 2)).map((v) => v / resolution)
            const ys = result.vertices.filter((_, i) => i % 2).map((v) => v / resolution)
            assert.ok(Math.abs(Math.min(...ys) + 0.1) < 1e-10)
            assert.ok(Math.abs(Math.max(...ys) - 0.1) < 1e-10)
            assert.ok(Math.abs(Math.min(...xs) + 0.1) < 0.001)
            assert.ok(Math.abs(Math.max(...xs) - 2.1) < 0.001)
            const angles = new Set<number>()
            for (let i = 0; i < xs.length; i++) {
                const x = xs[i]!,
                    y = ys[i]!
                if (x > 1e-8 || Math.abs(Math.hypot(x, y) - 0.1) > 1e-8) continue
                let angle = Math.atan2(y, x)
                if (angle < 0) angle += Math.PI * 2
                angles.add(angle)
            }
            const sorted = [...angles].sort((a, b) => a - b)
            assert.ok(sorted.length > 10)
            for (let i = 1; i < sorted.length; i++) {
                const error = 0.1 * deviceScale * (1 - Math.cos((sorted[i]! - sorted[i - 1]!) / 2))
                assert.ok(error < 0.03, `DPR ${dpr}: cap edge error ${error}`)
            }
        }
        assert.equal(style.width, 0.2)
    } finally {
        cache.destroy()
    }
})

test('compound curved fills retain world coverage and alpha union across resolution buckets', () => {
    const path = new DrawPath('M0 0 Q2 4 4 0 Z')
    path.rect(3, 0.2, -2, 1)
    const cache = new PathGraphicsCache()
    try {
        for (const rule of ['nonzero', 'evenodd'] as const) {
            for (const resolution of [1, 64, 256]) {
                const context = cache.get(
                    path,
                    { color: 0, alpha: 0.5 },
                    false,
                    rule,
                    'black',
                    undefined,
                    resolution,
                )
                assert.equal(
                    coverage(context, resolution, 0.43, 0.37),
                    1,
                    `${rule}/${resolution}: curve only`,
                )
                assert.equal(
                    coverage(context, resolution, 2.17, 0.53),
                    rule === 'nonzero' ? 1 : 0,
                    `${rule}/${resolution}: overlap`,
                )
                assert.equal(
                    coverage(context, resolution, 2.13, 1.47),
                    1,
                    `${rule}/${resolution}: above rectangle`,
                )
                assert.equal(
                    coverage(context, resolution, 2.11, 2.53),
                    0,
                    `${rule}/${resolution}: outside`,
                )
            }
        }
    } finally {
        cache.destroy()
    }
})

test('dashed curved strokes retain their world-space phase, width and overlap coverage', () => {
    const path = new DrawPath('M0 0 Q2 4 4 0')
    const cache = new PathGraphicsCache()
    const style = { color: 0, alpha: 0.5, width: 0.2, cap: 'butt' as const }
    const extras = { dash: [0.8, 0.6], dashOffset: 0.25 }
    try {
        const reference = cache.get(path, style, true, 'nonzero', 'dash', extras, 1024)
        const samples = Array.from({ length: 10 }, (_, i): Point => {
            const t = 0.05 + i * 0.1
            return [4 * t + 0.01, 8 * t * (1 - t) + 0.02]
        })
        const expected = samples.map(([x, y]) => coverage(reference, 1024, x, y))
        assert.ok(expected.includes(0) && expected.includes(1))
        for (const resolution of [32, 128]) {
            const context = cache.get(path, style, true, 'nonzero', 'dash', extras, resolution)
            assert.deepEqual(
                samples.map(([x, y]) => coverage(context, resolution, x, y)),
                expected,
            )
        }
        assert.deepEqual(extras, { dash: [0.8, 0.6], dashOffset: 0.25 })
        assert.equal(style.width, 0.2)
    } finally {
        cache.destroy()
    }
})

test('resolution cache variants reuse equal buckets and isolate mutations and snapshots', () => {
    const path = new DrawPath('M0 0 Q2 4 4 0')
    const cache = new PathGraphicsCache()
    const get = (source: DrawPath, factor: number) =>
        cache.get(source, { color: 0, width: 0.1 }, true, 'nonzero', 'black', undefined, factor)
    try {
        const first = get(path, resolutionScale([40, 0, 0, 40]))
        assert.equal(get(path, resolutionScale([50, 0, 0, 50, 1e8, -1e8])), first)
        const higher = get(path, 128)
        assert.notEqual(higher, first)
        const snapshot = path.clone()
        path.lineTo(8, 8)
        const appended = get(path, 64)
        assert.notEqual(appended, first)
        assert.equal(get(snapshot, 64), first)
        assert.equal(get(snapshot, 128), higher)
        const appendedHigher = get(path, 128)
        const commands = path.commands
        path.lineTo(10, 10)
        assert.equal(path.commands, commands)
        assert.notEqual(get(path, 64), appended)
        assert.notEqual(get(path, 128), appendedHigher)
        assert.equal(get(snapshot, 64), first)
    } finally {
        cache.destroy()
    }
})

test('scaled fill and stroke gradients map every GPU vertex to the original user-space gradient', () => {
    const cache = new PathGraphicsCache()
    const paints = new PaintStyles()
    const gradient = new DrawGradient([10, 20], [110, 70])
    gradient.addColorStop(0, '#ff0000')
    gradient.addColorStop(1, '#0000ff')
    const rectangle = new DrawPath()
    rectangle.rect(10, 20, 100, 80)
    const line = new DrawPath('M10 20 L110 70')
    const circle = new DrawPath()
    circle.arc(25, 30, 10, 0, Math.PI * 2)
    const ellipse = new DrawPath()
    ellipse.ellipse(25, 30, 10, 5, Math.PI / 4, 0, Math.PI * 2)
    try {
        for (const [path, stroke] of [
            [rectangle, false],
            [line, true],
            [circle, false],
            [ellipse, false],
        ] as const) {
            const paint = stroke
                ? paints.stroke(gradient, 4, 'butt', 'miter', 10)
                : paints.fill(gradient)
            for (const resolution of [1, 64, 256]) {
                const context = cache.get(
                    path,
                    paint.style,
                    stroke,
                    'nonzero',
                    paint.key,
                    undefined,
                    resolution,
                )
                const data = geometry(context)
                const texture = (() => {
                    if (context instanceof PathMeshGeometry) return context.texture
                    const instruction = context.instructions.find(
                        (value) => value.action === 'fill' || value.action === 'stroke',
                    )
                    assert.ok(
                        instruction &&
                            (instruction.action === 'fill' || instruction.action === 'stroke'),
                    )
                    return instruction.data.style.texture
                })()
                assert.ok(texture)
                const width = texture.width
                assert.ok(data.vertices.length > 0)
                for (let i = 0; i < data.vertices.length; i += 2) {
                    const x = data.vertices[i]! / resolution,
                        y = data.vertices[i + 1]! / resolution
                    const t = ((x - 10) * 100 + (y - 20) * 50) / (100 ** 2 + 50 ** 2)
                    const expected = (t * (width - 1) + 0.5) / width
                    // Native geometry keeps doubles. Mesh UVs and rebased positions
                    // are Float32, so permit only their explicit rounding bounds.
                    const tolerance =
                        context instanceof PathMeshGeometry
                            ? context.positionError / (resolution * Math.hypot(100, 50)) +
                              Math.max(1, Math.abs(expected)) * 2 ** -24 +
                              1e-12
                            : 1e-8
                    assert.ok(
                        Math.abs(data.uvs[i]! - expected) < tolerance,
                        `resolution ${resolution}, ${x},${y}: ${data.uvs[i]} != ${expected}`,
                    )
                }
            }
        }
    } finally {
        cache.destroy()
        paints.destroy()
    }
})
