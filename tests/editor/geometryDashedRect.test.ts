import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { tessellateStroke, type StrokeOptions } from '../../src/rendering/geometry'
import { initializeLyon, LyonTessellator } from '../../src/rendering/lyon'
import { DrawPath } from '../../src/rendering/path'

type Rect = readonly [x: number, y: number, width: number, height: number]
type Point = readonly [number, number]
const at = (values: ArrayLike<number>, index: number) => values[index] as number
const options: StrokeOptions = {
    width: 2,
    cap: 'butt',
    join: 'miter',
    miterLimit: 10,
    dash: [6, 4],
    dashOffset: 0,
}
const pathOf = ([x, y, w, h]: Rect, explicit = false) => {
    const path = new DrawPath()
    if (!explicit) path.rect(x, y, w, h)
    else {
        // The same directed rectangle, deliberately outside the single-rect
        // fast path: this always retains the complete existing stroke union.
        path.moveTo(x, y)
        path.lineTo(x + w, y)
        path.lineTo(x + w, y + h)
        path.lineTo(x, y + h)
        path.closePath()
    }
    return path
}
const area = (triangles: Float64Array) => {
    let sum = 0
    for (let i = 0; i < triangles.length; i += 6)
        sum +=
            Math.abs(
                (at(triangles, i + 2) - at(triangles, i)) *
                    (at(triangles, i + 5) - at(triangles, i + 1)) -
                    (at(triangles, i + 3) - at(triangles, i + 1)) *
                        (at(triangles, i + 4) - at(triangles, i)),
            ) / 2
    return sum
}
const coverage = (triangles: Float64Array, [x, y]: Point) => {
    let covered = false,
        interiors = 0
    for (let i = 0; i < triangles.length; i += 6) {
        const ax = at(triangles, i),
            ay = at(triangles, i + 1),
            bx = at(triangles, i + 2),
            by = at(triangles, i + 3),
            cx = at(triangles, i + 4),
            cy = at(triangles, i + 5),
            a = (bx - ax) * (y - ay) - (by - ay) * (x - ax),
            b = (cx - bx) * (y - by) - (cy - by) * (x - bx),
            c = (ax - cx) * (y - cy) - (ay - cy) * (x - cx)
        if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) === 0) continue
        if ((a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0)) covered = true
        if ((a > 0 && b > 0 && c > 0) || (a < 0 && b < 0 && c < 0)) interiors++
    }
    return { covered, interiors }
}

// Independent exact IEEE-double oracle. A shared edge/vertex is allowed;
// positive-area intersections would apply translucent stroke alpha twice.
type ExactPoint = readonly [bigint, bigint]
const cross = (a: ExactPoint, b: ExactPoint, p: ExactPoint) =>
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
const exactCoordinates = (values: Float64Array) => {
    const view = new DataView(new ArrayBuffer(8))
    let minimumExponent = Infinity
    const parts = Array.from(values, (value) => {
        assert.ok(Number.isFinite(value))
        view.setFloat64(0, value)
        const bits = view.getBigUint64(0),
            exponentBits = Number((bits >> 52n) & 2047n),
            fraction = bits & ((1n << 52n) - 1n),
            mantissa =
                (bits >> 63n ? -1n : 1n) * (exponentBits ? (1n << 52n) | fraction : fraction),
            exponent = exponentBits ? exponentBits - 1075 : -1074
        if (mantissa) minimumExponent = Math.min(minimumExponent, exponent)
        return { mantissa, exponent }
    })
    return parts.map(({ mantissa, exponent }) =>
        mantissa ? mantissa << BigInt(exponent - minimumExponent) : 0n,
    )
}
const positiveOverlap = (a: readonly ExactPoint[], b: readonly ExactPoint[]) => {
    for (const triangle of [a, b])
        for (let edge = 0; edge < 3; edge++) {
            const p = triangle[edge]!,
                q = triangle[(edge + 1) % 3]!,
                pa = a.map((v) => cross(p, q, v)),
                pb = b.map((v) => cross(p, q, v)),
                min = (values: bigint[]) => values.reduce((x, y) => (x < y ? x : y)),
                max = (values: bigint[]) => values.reduce((x, y) => (x > y ? x : y))
            if (max(pa) <= min(pb) || max(pb) <= min(pa)) return false
        }
    return true
}
const noOverlappingInteriors = (triangles: Float64Array) => {
    const exact = exactCoordinates(triangles)
    const items = Array.from({ length: triangles.length / 6 }, (_, index) => {
        const offset = 6 * index
        const points = [0, 2, 4].map((i): ExactPoint => [
            exact[offset + i]!,
            exact[offset + i + 1]!,
        ])
        const xs = [0, 2, 4].map((i) => at(triangles, offset + i)),
            ys = [1, 3, 5].map((i) => at(triangles, offset + i))
        return {
            index,
            points,
            left: Math.min(...xs),
            right: Math.max(...xs),
            top: Math.min(...ys),
            bottom: Math.max(...ys),
        }
    })
        .filter(({ points }) => cross(points[0]!, points[1]!, points[2]!) !== 0n)
        .sort((a, b) => a.left - b.left)
    let active: typeof items = []
    for (const current of items) {
        // Strict AABB overlap is necessary for positive-area intersection and
        // bounds the huge thin-rectangle witness without an all-pairs scan.
        active = active.filter((item) => item.right > current.left)
        for (const previous of active) {
            if (previous.bottom <= current.top || current.bottom <= previous.top) continue
            assert.equal(
                positiveOverlap(previous.points, current.points),
                false,
                `triangles ${previous.index}/${current.index} overlap and would darken alpha`,
            )
        }
        active.push(current)
    }
}
const samplePoints = ([x, y, w, h]: Rect, width: number) => {
    const vertices: Point[] = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
    ]
    const samples: Point[] = []
    for (let edge = 0; edge < 4; edge++) {
        const a = vertices[edge]!,
            b = vertices[(edge + 1) % 4]!
        const length = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (!length) continue
        const nx = -(b[1] - a[1]) / length,
            ny = (b[0] - a[0]) / length
        for (let i = 0; i < 33; i++)
            for (const across of [-0.713, -0.217, 0.319, 0.791]) {
                const t = (i + 0.371) / 33
                samples.push([
                    a[0] + (b[0] - a[0]) * t + nx * width * across,
                    a[1] + (b[1] - a[1]) * t + ny * width * across,
                ])
            }
        for (const dx of [-0.83, -0.37, 0.19, 0.61])
            for (const dy of [-0.71, -0.29, 0.23, 0.79])
                samples.push([a[0] + width * dx, a[1] + width * dy])
    }
    return samples
}
const compare = (rect: Rect, style: StrokeOptions, tolerance = 0.1, resolution?: number) => {
    const optimized = tessellateStroke(pathOf(rect), style, tolerance, resolution)
    const generic = tessellateStroke(pathOf(rect, true), style, tolerance, resolution)
    assert.equal(optimized.length % 6, 0)
    assert.ok(optimized.every(Number.isFinite))
    const expectedArea = area(generic)
    assert.ok(
        Math.abs(area(optimized) - expectedArea) <= 1e-9 * Math.max(1, expectedArea),
        `stroke area changed: ${area(optimized)} vs ${expectedArea}`,
    )
    noOverlappingInteriors(optimized)
    for (const point of samplePoints(rect, style.width)) {
        const actual = coverage(optimized, point)
        assert.equal(actual.covered, coverage(generic, point).covered, `coverage at ${point}`)
        assert.ok(actual.interiors <= 1, `alpha applied more than once at ${point}`)
    }
    return { optimized, generic }
}

test('exact triangle oracle permits shared edges but rejects positive-area overlap', () => {
    noOverlappingInteriors(new Float64Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]))
    noOverlappingInteriors(new Float64Array([0, 0, 1, 0, 0, 1, 1, 0, 2, 0, 1, 1]))
    noOverlappingInteriors(new Float64Array([0, 0, 1, 0, 0, 1, 0, 0, 0.5, 0.5, 1, 1]))
    assert.throws(
        () => noOverlappingInteriors(new Float64Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])),
        /darken alpha/,
    )
    assert.throws(
        () =>
            noOverlappingInteriors(
                new Float64Array([0, 0, 1, 0, 0, 1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.2]),
            ),
        /darken alpha/,
    )
    const x = 1 - Number.EPSILON
    assert.throws(
        () => noOverlappingInteriors(new Float64Array([0, 0, 1, 0, 0, 1, x, 0, 2, 0, x, 1])),
        /darken alpha/,
    )
})

test('separated rectangle dashes preserve signed traversal, corner phases and the closing seam', () => {
    for (const w of [100, -100])
        for (const h of [8, -8])
            for (const dashOffset of [0, 1.25, 5.5, 6, 6 - 1e-10, 6 + 1e-10, 9.5, -3.75, 216])
                compare([13.125, -7.25, w, h], { ...options, dashOffset })
    // The offset-zero perimeter ends on an on-interval boundary. The final
    // vertical body intersects the first horizontal body near the seam.
    const { optimized } = compare([0, 0, 100, 8], options)
    assert.equal(coverage(optimized, [0.4, 0.3]).interiors, 1)
    compare([0, 0, 12, 8], { ...options, dash: [25, 4], dashOffset: 1.5 })
})

test('small extents, close dash gaps, non-butt caps and other joins preserve the general path', () => {
    const cases: { rect: Rect; style: StrokeOptions }[] = [
        { rect: [0, 0, 100, 4], style: options },
        { rect: [0, 0, 3, 8], style: options },
        { rect: [0, 0, 100, 8], style: { ...options, dash: [6, 3.99] } },
        { rect: [0, 0, 100, 8], style: { ...options, cap: 'round' } },
        { rect: [0, 0, 100, 8], style: { ...options, cap: 'square' } },
        { rect: [0, 0, 100, 8], style: { ...options, join: 'bevel' } },
        { rect: [0, 0, 100, 8], style: { ...options, join: 'round' } },
        { rect: [0, 0, 100, 8], style: { ...options, dash: [6, 4, 2] } },
        { rect: [0, 0, 100, 8], style: { ...options, dash: [0, 4] } },
        { rect: [0, 0, 100, 8], style: { ...options, dash: [] } },
    ]
    for (const { rect, style } of cases)
        assert.deepEqual(
            tessellateStroke(pathOf(rect), style, 0.1),
            tessellateStroke(pathOf(rect, true), style, 0.1),
        )
})

test('compound rectangles keep one union so crossing translucent strokes apply alpha once', () => {
    const candidate = pathOf([0, 0, 100, 8]),
        oracle = pathOf([0, 0, 100, 8], true)
    candidate.rect(3, -4, 10, 20)
    oracle.moveTo(3, -4)
    oracle.lineTo(13, -4)
    oracle.lineTo(13, 16)
    oracle.lineTo(3, 16)
    oracle.closePath()
    const triangles = tessellateStroke(candidate, options, 0.1)
    assert.deepEqual(triangles, tessellateStroke(oracle, options, 0.1))
    noOverlappingInteriors(triangles)
})

test('a rectangle collapsed by flattening keeps its out-and-back stroke in one union', () => {
    const rect: Rect = [0, 0, 1, 1e-10]
    const style = { ...options, width: 1e-11, dash: [0.1, 0.01] }
    const optimized = tessellateStroke(pathOf(rect), style, 0.1)
    assert.deepEqual(optimized, tessellateStroke(pathOf(rect, true), style, 0.1))
    noOverlappingInteriors(optimized)
    assert.equal(coverage(optimized, [0.051, 1e-12]).interiors, 1)
})

const capturedRect: Rect = [-120.1, -24.63920265780731, 240.2, 0.8]
const capturedOptions: StrokeOptions = {
    ...options,
    width: 0.018604651162790697,
    dash: [0.05581395348837209, 0.037209302325581395],
}
test('captured 240-lane hovered rectangle retains JS union coverage without overlapping dash triangles', () => {
    compare(capturedRect, capturedOptions, 0.1 / 256)
})

test('captured rectangle sends only the bounded seam/corner union to the actual Lyon kernel', async (t) => {
    const bytes = readFileSync(new URL('../../src/rendering/vendor/lyon.wasm', import.meta.url))
    const originalFetch = globalThis.fetch
    try {
        globalThis.fetch = async () => new Response(bytes)
        await initializeLyon()
    } finally {
        globalThis.fetch = originalFetch
    }
    const native = LyonTessellator.prototype.triangulate
    const contoursPerCall: number[] = []
    t.mock.method(
        LyonTessellator.prototype,
        'triangulate',
        function (this: LyonTessellator, ...args: Parameters<LyonTessellator['triangulate']>) {
            contoursPerCall.push(args[0].length)
            const triangles = native.apply(this, args)
            assert.ok(triangles, 'captured geometry must reach the actual pinned Lyon kernel')
            return triangles
        },
    )
    const optimized = tessellateStroke(pathOf(capturedRect), capturedOptions, 0.1 / 256, 256)
    assert.equal(contoursPerCall.length, 1)
    assert.ok(
        contoursPerCall[0]! > 0 && contoursPerCall[0]! <= 16,
        `only first/last and at most four corner components need union: ${contoursPerCall[0]}`,
    )
    noOverlappingInteriors(optimized)
    tessellateStroke(pathOf(capturedRect, true), capturedOptions, 0.1 / 256, 256)
    assert.equal(contoursPerCall.length, 2)
    assert.ok(
        contoursPerCall[1]! > 5000,
        'unchanged generic route still unions the complete dash outlines',
    )
})
