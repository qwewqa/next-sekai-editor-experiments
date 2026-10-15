import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BatchableGraphics,
    BigPool,
    GpuGraphicsContext,
    GraphicsContext,
    type StrokeStyle,
} from 'pixi.js'
import { DrawGradient } from '../../src/rendering/paint'
import { DrawPath } from '../../src/rendering/path'
import { PathGraphicsCache } from '../../src/rendering/pathGraphics'
import { PathMeshGeometry } from '../../src/rendering/pathMesh'
import { nativeStrokeBoundary, pathTriangles } from '../../src/rendering/pathTriangles'
import { PaintStyles } from '../../src/rendering/pixiPaint'

type Point = [number, number]
const style: StrokeStyle = {
    color: 0xff4444,
    alpha: 0.37,
    width: 2,
    cap: 'butt',
    join: 'miter',
    miterLimit: 10,
}
const makePath = (...contours: Point[][]) => {
    const path = new DrawPath()
    for (const points of contours)
        for (const [index, point] of points.entries()) {
            if (index) path.lineTo(...point)
            else path.moveTo(...point)
        }
    return path
}
const cross = (reverseFirst = false, reverseSecond = false) => {
    const first: Point[] = [
            [-3, 0],
            [3, 0],
        ],
        second: Point[] = [
            [0, -3],
            [0, 3],
        ]
    return makePath(
        reverseFirst ? first.reverse() : first,
        reverseSecond ? second.reverse() : second,
    )
}
const mesh = (resource: ReturnType<PathGraphicsCache['getFakeMarkerStroke']>) => {
    assert.ok(resource instanceof PathMeshGeometry)
    return resource
}
const area = (triangles: Float64Array) => {
    let result = 0
    for (let i = 0; i < triangles.length; i += 6) {
        const [ax, ay, bx, by, cx, cy] = Array.from(triangles.subarray(i, i + 6)) as [
            number,
            number,
            number,
            number,
            number,
            number,
        ]
        result += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2
    }
    return result
}
// Strict interior sampling avoids attributing a shared tessellation edge twice.
const coverage = (triangles: Float64Array, x: number, y: number) => {
    let result = 0
    for (let i = 0; i < triangles.length; i += 6) {
        const [ax, ay, bx, by, cx, cy] = Array.from(triangles.subarray(i, i + 6)) as [
            number,
            number,
            number,
            number,
            number,
            number,
        ]
        const signs = [
            (bx - ax) * (y - ay) - (by - ay) * (x - ax),
            (cx - bx) * (y - by) - (cy - by) * (x - bx),
            (ax - cx) * (y - cy) - (ay - cy) * (x - cx),
        ]
        if (signs.every((value) => value > 1e-8) || signs.every((value) => value < -1e-8)) result++
    }
    return result
}
const bytes = (values: Float64Array) =>
    Buffer.from(values.buffer, values.byteOffset, values.byteLength)
const signedArea = (points: Point[]) => {
    const [ox, oy] = points[0]!
    return (
        points.reduce((sum, [x, y], i) => {
            const [nx, ny] = points[(i + 1) % points.length]!
            return sum + (x - ox) * (ny - oy) - (y - oy) * (nx - ox)
        }, 0) / 2
    )
}

test('native boundaries normalize direction and reflection without mutating or retaining source points', () => {
    for (const reverse of [false, true])
        for (const sx of [-1, 1]) {
            const points: Point[] = [
                [0, 0],
                [3, 1],
                [6, 1.5],
            ]
            if (reverse) points.reverse()
            const native = new GraphicsContext()
                .poly(
                    points.flatMap(([x, y]) => [sx * x + 2 ** 20, y - 2 ** 19]),
                    false,
                )
                .stroke(style)
            try {
                const instructions = [...native.instructions],
                    dirty = native.dirty
                const sourceTriangles = pathTriangles(native)
                const boundary = nativeStrokeBoundary(native, points.length)
                assert.ok(boundary)
                assert.equal(boundary.length, points.length * 2)
                assert.ok(signedArea(boundary) > 0)
                assert.ok(Math.abs(signedArea(boundary) - area(sourceTriangles)) < 1e-5)
                assert.deepEqual(native.instructions, instructions)
                assert.equal(native.dirty, dirty)
                assert.equal(native.destroyed, false)
                const saved = boundary.map((point) => [...point])
                boundary[0]![0] = 0
                assert.deepEqual(nativeStrokeBoundary(native, points.length), saved)
                assert.deepEqual(bytes(pathTriangles(native)), bytes(sourceTriangles))
            } finally {
                native.destroy()
            }
        }
})

test('unstable far-coordinate native joins refuse and retain the existing union fallback', () => {
    const offset = 2 ** 30
    const first: Point[] = [
        [0, 0],
        [3, 1],
        [6, 1.5],
    ]
    const second: Point[] = [
        [0, 1.5],
        [3, 0.5],
        [6, 0],
    ]
    const path = makePath(
        ...[first, second].map((points) =>
            points.map(([x, y]): Point => [x + offset, y - offset / 2]),
        ),
    )
    const native = new GraphicsContext()
        .poly(
            first.flatMap(([x, y]) => [x + offset, y - offset / 2]),
            false,
        )
        .stroke(style)
    const cache = new PathGraphicsCache(),
        reference = new PathGraphicsCache()
    try {
        // Pixi8.22's absolute-coordinate miter arithmetic loses the complete
        // strip topology here. The proof must refuse rather than union it.
        assert.equal(nativeStrokeBoundary(native, first.length), undefined)
        const actual = cache.getFakeMarkerStroke(path, style, 'far')
        const old = reference.get(path, style, true, 'nonzero', 'far')
        assert.deepEqual(bytes(pathTriangles(actual)), bytes(pathTriangles(old)))
        assert.equal(cache.getFakeMarkerStroke(path, style, 'far'), actual)
    } finally {
        native.destroy()
        cache.destroy()
        reference.destroy()
    }
})

test('large local extents preserve the existing precision fallback instead of keeping lossy mesh positions', () => {
    const end = 100_000_000.25
    const path = makePath(
        [
            [-end, 0],
            [end, 0],
        ],
        [
            [0, -end],
            [0, end],
        ],
    )
    const cache = new PathGraphicsCache(),
        reference = new PathGraphicsCache()
    try {
        const actual = cache.getFakeMarkerStroke(path, style, 'extent')
        const old = reference.get(path, style, true, 'nonzero', 'extent')
        assert.ok(actual instanceof GraphicsContext)
        assert.deepEqual(bytes(pathTriangles(actual)), bytes(pathTriangles(old)))
        assert.equal(cache.getFakeMarkerStroke(path, style, 'extent'), actual)
    } finally {
        cache.destroy()
        reference.destroy()
    }
})

test('two crossing contours produce one painted union for all input windings and resolution buckets', () => {
    const cache = new PathGraphicsCache()
    try {
        for (const reverseFirst of [false, true])
            for (const reverseSecond of [false, true])
                for (const resolution of [1, 64, 256]) {
                    const resource = mesh(
                        cache.getFakeMarkerStroke(
                            cross(reverseFirst, reverseSecond),
                            style,
                            'marker',
                            undefined,
                            resolution,
                        ),
                    )
                    const triangles = pathTriangles(resource).map((value) => value / resolution)
                    assert.ok(
                        Math.abs(area(triangles) - 20) < 1e-5,
                        'two 6×2 rectangles overlap in exactly one 2×2 square',
                    )
                    for (const [x, y] of [
                        [0.13, 0.27],
                        [2.51, 0.29],
                        [0.23, 2.57],
                    ])
                        assert.equal(coverage(triangles, x!, y!), 1)
                    assert.equal(coverage(triangles, 1.23, 1.37), 0)
                    assert.equal(resource.tint, style.color)
                    assert.equal(
                        resource.styleAlpha,
                        0.37,
                        'the crossing receives the stroke alpha once',
                    )
                }
    } finally {
        cache.destroy()
    }
})

test('coincident and touching contours retain their union area without doubled interior coverage', () => {
    const cache = new PathGraphicsCache()
    try {
        for (const [offset, expected] of [
            [0, 12],
            [2, 24],
        ]) {
            const path = makePath(
                [
                    [-3, 0],
                    [3, 0],
                ],
                [
                    [3, offset!],
                    [-3, offset!],
                ],
            )
            const triangles = pathTriangles(cache.getFakeMarkerStroke(path, style, 'marker'))
            assert.ok(Math.abs(area(triangles) - expected!) < 1e-5)
            assert.equal(coverage(triangles, 0.13, 0.27), 1)
            if (offset) assert.equal(coverage(triangles, 0.19, 2.37), 1)
        }
    } finally {
        cache.destroy()
    }
})

// Reconstruct the two 33-point polylines of actual corpus record39 near the
// origin: cubic lane interpolation, 18/17 world-unit vertical span, width0.06.
const sampledMarker = () =>
    makePath(
        Array.from({ length: 33 }, (_, i): Point => {
            const t = i / 32
            return [-2 + 14 * t - 7 * t * t + t * t * t, (-18 * t) / 17]
        }),
        Array.from({ length: 33 }, (_, i): Point => {
            const t = i / 32
            return [2 + 4 * t - 2 * t * t - t * t * t, (-18 * t) / 17]
        }),
    )

test('the sampled real marker family substantially reduces geometry while retaining union area', () => {
    const cache = new PathGraphicsCache(),
        reference = new PathGraphicsCache()
    const paint = { ...style, width: 0.06 }
    try {
        const path = sampledMarker()
        const actual = mesh(cache.getFakeMarkerStroke(path, paint, 'sampled', undefined, 64))
        const old = mesh(reference.get(path, paint, true, 'nonzero', 'sampled', undefined, 64))
        const triangles = pathTriangles(actual),
            oldTriangles = pathTriangles(old)
        assert.ok(
            triangles.length < oldTriangles.length / 2,
            `${triangles.length / 6} versus ${oldTriangles.length / 6} triangles`,
        )
        // These coordinates already include the resolution64 compilation scale.
        // The real fixture's Lyon union differs by 0.00645 compiled pixel²;
        // phase/scale raster checks preserve coverage, with only isolated MSAA
        // junction differences. Keep this absolute allowance local to this case.
        assert.ok(Math.abs(area(triangles) - area(oldTriangles)) < 0.01)
        assert.equal(cache.get(path, paint, true, 'nonzero', 'sampled', undefined, 64), actual)
        assert.equal(
            cache.getFakeMarkerStroke(path.clone(), paint, 'sampled', undefined, 64),
            actual,
        )
        const oldFirstPath = sampledMarker()
        const oldFirst = cache.get(oldFirstPath, paint, true, 'nonzero', 'old-first', undefined, 64)
        assert.equal(
            cache.getFakeMarkerStroke(oldFirstPath, paint, 'old-first', undefined, 64),
            oldFirst,
            'ordinary and feature calls share the exact cache entry in either order',
        )
    } finally {
        cache.destroy()
        reference.destroy()
    }
})

test('folded second contours fall back once, preserving geometry and cleaning both native candidates', (t) => {
    const cache = new PathGraphicsCache(),
        reference = new PathGraphicsCache()
    const path = makePath(
        [
            [-4, -1],
            [4, -1],
        ],
        [
            [0, 0],
            [0, 3],
            [1, 3],
            [1, 0],
        ],
    )
    const old = reference.get(path, style, true, 'nonzero', 'folded')
    const destroyed: GraphicsContext[] = []
    const original = GraphicsContext.prototype.destroy
    t.mock.method(GraphicsContext.prototype, 'destroy', function (this: GraphicsContext) {
        destroyed.push(this)
        original.call(this)
    })
    try {
        const result = cache.getFakeMarkerStroke(path, style, 'folded')
        assert.deepEqual(bytes(pathTriangles(result)), bytes(pathTriangles(old)))
        assert.equal(destroyed.length, 2)
        assert.ok(destroyed.every((context) => context.destroyed))
        for (let i = 0; i < 3; i++)
            assert.equal(cache.getFakeMarkerStroke(path.clone(), style, 'folded'), result)
        assert.equal(cache.get(path, style, true, 'nonzero', 'folded'), result)
        assert.equal(destroyed.length, 2, 'a cached refusal must not rebuild the proof')
    } finally {
        cache.destroy()
        reference.destroy()
    }
})

test('unsupported styles and command families preserve the existing route without a native proof', (t) => {
    const cache = new PathGraphicsCache(),
        paints = new PaintStyles()
    const gradient = new DrawGradient([-3, 0], [3, 0])
    gradient.addColorStop(0, '#f00')
    gradient.addColorStop(1, '#00f')
    const gradientPaint = paints.stroke(gradient, 2, 'butt', 'miter', 10)
    let inspections = 0
    const destroy = GpuGraphicsContext.prototype.destroy
    t.mock.method(GpuGraphicsContext.prototype, 'destroy', function (this: GpuGraphicsContext) {
        inspections++
        destroy.call(this)
    })
    try {
        const variants: {
            name: string
            path?: DrawPath
            paint?: StrokeStyle
            extras?: { dash: number[]; dashOffset: number }
        }[] = [
            { name: 'round', paint: { ...style, cap: 'round' } },
            { name: 'square', paint: { ...style, cap: 'square' } },
            { name: 'bevel', paint: { ...style, join: 'bevel' } },
            { name: 'pixel', paint: { ...style, pixelLine: true } },
            { name: 'aligned', paint: { ...style, alignment: 0 } },
            { name: 'gradient', paint: gradientPaint.style },
            { name: 'dash', extras: { dash: [0.5, 0.5], dashOffset: 0.25 } },
            {
                name: 'three',
                path: makePath(
                    [
                        [-3, 0],
                        [3, 0],
                    ],
                    [
                        [0, -3],
                        [0, 3],
                    ],
                    [
                        [-3, -3],
                        [3, 3],
                    ],
                ),
            },
            { name: 'svg', path: new DrawPath('M-3 0L3 0M0 -3L0 3') },
        ]
        for (const variant of variants) {
            const path = variant.path ?? cross(),
                paint = variant.paint ?? style
            const before = inspections
            const result = cache.getFakeMarkerStroke(path, paint, variant.name, variant.extras)
            assert.equal(
                inspections,
                before,
                `${variant.name} must not enter native boundary extraction`,
            )
            assert.equal(
                cache.get(path, paint, true, 'nonzero', variant.name, variant.extras),
                result,
            )
        }
    } finally {
        cache.destroy()
        paints.destroy()
    }
})

test('command snapshots, style changes and resolution variants remain isolated', () => {
    const cache = new PathGraphicsCache(),
        path = cross()
    try {
        const first = mesh(cache.getFakeMarkerStroke(path, style, 'marker'))
        const old = path.clone()
        path.lineTo(0, 5)
        const changed = cache.getFakeMarkerStroke(path, style, 'marker')
        assert.notEqual(changed, first)
        assert.equal(cache.getFakeMarkerStroke(old, style, 'marker'), first)
        const scaled = cache.getFakeMarkerStroke(old, style, 'marker', undefined, 64)
        assert.notEqual(scaled, first)
        assert.ok(
            Math.abs(area(pathTriangles(scaled)) / 64 ** 2 - area(pathTriangles(first))) < 1e-5,
        )
        const wider = mesh(
            cache.getFakeMarkerStroke(
                old,
                { ...style, width: 3, color: 0x123456, alpha: 0.5 },
                'wider',
            ),
        )
        assert.notEqual(wider, first)
        assert.equal(
            wider.tint,
            0x123456,
            'the explicit feature API does not infer identity from red paint',
        )
        assert.equal(wider.styleAlpha, 0.5)
        assert.ok(Math.abs(area(pathTriangles(wider)) - 27) < 1e-5)
        const offset = cache.getFakeMarkerStroke(old, style, 'marker', { dash: [], dashOffset: 1 })
        assert.notEqual(offset, first)
        assert.deepEqual(bytes(pathTriangles(offset)), bytes(pathTriangles(first)))
    } finally {
        cache.destroy()
    }
})

test('accepted meshes use ordinary pin, overflow, eviction and destruction lifetimes', () => {
    const sizing = new PathGraphicsCache()
    sizing.getFakeMarkerStroke(cross(), style, 'marker')
    const budget = sizing.retainedBytes
    sizing.destroy()
    const cache = new PathGraphicsCache(budget)
    const get = () => mesh(cache.getFakeMarkerStroke(cross(), style, 'marker'))
    let lateRelease: (() => void) | undefined
    try {
        const first = get(),
            buffers = [...first.buffers],
            release = cache.pin([first, first])
        assert.ok(release)
        assert.equal(cache.pinnedBytes, budget)
        cache.beginFrame()
        const overflow = get()
        assert.equal(cache.pin([overflow]), undefined)
        cache.endFrame()
        assert.equal(overflow.destroyed, false)
        assert.equal(first.destroyed, false)
        cache.beginFrame()
        assert.equal(overflow.destroyed, true)
        release()
        release()
        assert.equal(cache.pinnedBytes, 0)
        const next = get()
        assert.equal(first.destroyed, true)
        assert.ok(buffers.every((buffer) => buffer.destroyed))
        assert.equal(next.destroyed, false)
        assert.ok(cache.retainedBytes <= budget)
        lateRelease = cache.pin([next])
        assert.ok(lateRelease)
        cache.destroy()
        lateRelease()
        assert.equal(cache.pinnedBytes, 0)
        assert.equal(next.destroyed, true)
    } finally {
        cache.destroy()
        lateRelease?.()
    }
})

test('boundary inspection clears borrowed pooled paint/geometry on success and refusal', () => {
    const paints = new PaintStyles(),
        gradient = new DrawGradient([0, 0], [6, 0])
    gradient.addColorStop(0, '#f00')
    gradient.addColorStop(1, '#00f')
    const paint = paints.stroke(gradient, 2, 'butt', 'miter', 10)
    const context = new GraphicsContext().poly([0, 0, 3, 1, 6, 1.5], false).stroke(paint.style)
    const instruction = context.instructions[0]
    assert.ok(instruction?.action === 'stroke')
    const texture = instruction.data.style.texture
    assert.ok(texture)
    const pool = BigPool.getPool(BatchableGraphics),
        used = pool.totalUsed
    try {
        assert.ok(nativeStrokeBoundary(context, 3))
        assert.equal(pool.totalUsed, used)
        assert.equal(nativeStrokeBoundary(context, 4), undefined)
        assert.equal(pool.totalUsed, used)
        const returned = pool.get()
        assert.equal(returned.texture, null)
        assert.equal(returned.geometryData, null)
        pool.return(returned)
        assert.equal(texture.destroyed, false)
        assert.equal(context.destroyed, false)
        assert.ok(nativeStrokeBoundary(context, 3), 'cleared batches can be reused')
    } finally {
        context.destroy()
        paints.destroy()
    }
})

test('failure while inspecting the second strip returns all scratch and temporary resources', (t) => {
    const cache = new PathGraphicsCache(),
        pool = BigPool.getPool(BatchableGraphics),
        used = pool.totalUsed
    const failure = new Error('deliberate second native build failure')
    const stroke = GraphicsContext.prototype.stroke,
        destroy = GraphicsContext.prototype.destroy
    let built = 0
    const destroyed: GraphicsContext[] = []
    t.mock.method(
        GraphicsContext.prototype,
        'stroke',
        function (this: GraphicsContext, ...args: Parameters<typeof stroke>) {
            const result = stroke.apply(this, args)
            if (++built === 2)
                Object.defineProperty(this.instructions[0]!.data, 'path', {
                    get() {
                        throw failure
                    },
                })
            return result
        },
    )
    t.mock.method(GraphicsContext.prototype, 'destroy', function (this: GraphicsContext) {
        destroyed.push(this)
        destroy.call(this)
    })
    try {
        assert.throws(
            () => cache.getFakeMarkerStroke(cross(), style, 'broken'),
            (error) => error === failure,
        )
        assert.equal(pool.totalUsed, used)
        assert.equal(destroyed.length, 2)
        assert.ok(destroyed.every((context) => context.destroyed))
        assert.equal(cache.retainedBytes, 0)
        assert.equal(cache.stats.fallback, 0)
    } finally {
        cache.destroy()
    }
})
