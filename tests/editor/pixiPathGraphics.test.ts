import assert from 'node:assert/strict'
import test from 'node:test'
import { GraphicsContext, type GraphicsPath, type Polygon, type StrokeStyle } from 'pixi.js'
import { DrawPath } from '../../src/rendering/path'
import { compilePath, PathGraphicsCache } from '../../src/rendering/pathGraphics'
import { PathMeshGeometry } from '../../src/rendering/pathMesh'
import { pathResourceGeometry } from './pixiGeometryTestUtils'

function polygons(path: GraphicsPath) {
    return path.shapePath.shapePrimitives.flatMap(({ shape }) =>
        shape.type === 'polygon' ? [(shape as Polygon).points] : [],
    )
}

function contains(path: GraphicsPath, x: number, y: number) {
    return path.shapePath.shapePrimitives.some(({ shape, transform }) => {
        const point = transform?.applyInverse({ x, y }) ?? { x, y }
        return shape.contains(point.x, point.y)
    })
}

function area(points: number[]) {
    let total = 0
    for (let i = 0; i < points.length; i += 2) {
        const next = (i + 2) % points.length
        total += points[i]! * points[next + 1]! - points[next]! * points[i + 1]!
    }
    return total / 2
}

test('an empty appended child preserves the parent open contour', () => {
    const child = new DrawPath()
    child.closePath()
    const path = new DrawPath()
    path.moveTo(5, 6)
    path.lineTo(20, 6)
    path.addPath(child)
    path.lineTo(20, 20)
    assert.deepEqual(polygons(compilePath(path)), [[5, 6, 20, 6, 20, 20]])
})

function coverage(context: GraphicsContext | PathMeshGeometry, x: number, y: number, label = '') {
    const geometryData = pathResourceGeometry(context)
    let covered = 0
    const { vertices, indices } = geometryData
    assert.ok(
        vertices.every(Number.isFinite),
        `${label} GPU geometry must contain finite coordinates`,
    )
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i]! * 2
        const b = indices[i + 1]! * 2
        const c = indices[i + 2]! * 2
        const cross = (first: number, second: number) =>
            (vertices[second]! - vertices[first]!) * (y - vertices[first + 1]!) -
            (vertices[second + 1]! - vertices[first + 1]!) * (x - vertices[first]!)
        const edges = [cross(a, b), cross(b, c), cross(c, a)]
        if (edges.every((edge) => edge > 1e-8) || edges.every((edge) => edge < -1e-8)) covered++
    }
    return covered
}

test('Pixi adapter initializes line, quadratic, cubic and arcTo at their Canvas first point', () => {
    const line = new DrawPath()
    line.lineTo(20, 30)
    line.lineTo(40, 50)
    assert.deepEqual(polygons(compilePath(line)), [[20, 30, 40, 50]])
    for (const kind of ['quadratic', 'cubic', 'arcTo']) {
        const path = new DrawPath()
        if (kind === 'quadratic') path.quadraticCurveTo(20, 30, 40, 50)
        else if (kind === 'cubic') path.bezierCurveTo(20, 30, 30, 40, 40, 50)
        else {
            path.arcTo(20, 30, 30, 40, 5)
            path.lineTo(40, 50)
        }
        assert.deepEqual(polygons(compilePath(path))[0]?.slice(0, 2), [20, 30])
    }
})

test('Pixi adapter resumes a closed contour from its first point', () => {
    const path = new DrawPath()
    path.moveTo(5, 6)
    path.lineTo(20, 6)
    path.lineTo(20, 20)
    path.closePath()
    path.lineTo(30, 30)
    assert.deepEqual(polygons(compilePath(path)).at(-1), [5, 6, 30, 30])
})

test('negative rectangles retain their winding, size and current point', () => {
    const path = new DrawPath()
    path.rect(10, 10, 30, 30)
    path.rect(35, 15, -20, 20)
    path.lineTo(45, 50)
    const shapes = polygons(compilePath(path))
    assert.equal(area(shapes[0]!), 900)
    assert.equal(area(shapes[1]!), -400)
    assert.deepEqual(shapes[2], [35, 15, 45, 50])
})

test('rounded rectangles preserve elliptical corner radii and scale oversized radii', () => {
    const path = new DrawPath()
    path.roundRect(10, 20, 40, 10, { x: 10, y: 2 })
    const compiled = compilePath(path)
    assert.equal(contains(compiled, 10.1, 20.1), false)
    assert.equal(contains(compiled, 20, 20.1), true)
    assert.equal(contains(compiled, 10.1, 22), true)
    const oversized = new DrawPath()
    oversized.roundRect(0, 0, 20, 10, { x: 20, y: 20 })
    const normalized = compilePath(oversized)
    assert.equal(contains(normalized, 1, 1), false)
    assert.equal(contains(normalized, 5, 0.1), true)
    const reversed = new DrawPath()
    reversed.roundRect(20, 0, -20, 10, [2, 4])
    assert.ok(area(polygons(compilePath(reversed))[0]!) < 0)
})

test('full arcs include opposite-direction exact turns', () => {
    for (const ccw of [false, true]) {
        for (const end of [-Math.PI * 2, Math.PI * 2]) {
            const path = new DrawPath()
            path.arc(20, 20, 10, 0, end, ccw)
            assert.equal(contains(compilePath(path), 20, 20), true, `${end}, ccw=${ccw}`)
        }
    }
})

test('rotated and degenerate ellipses produce finite geometry with their original extents', () => {
    const rotated = new DrawPath()
    rotated.ellipse(20, 30, 10, 5, Math.PI / 2, 0, Math.PI * 2)
    const compiled = compilePath(rotated)
    assert.equal(contains(compiled, 20, 39.9), true)
    assert.equal(contains(compiled, 29, 30), false)
    const flat = new DrawPath()
    flat.ellipse(20, 30, 0, 5, 0, 0, Math.PI * 2)
    const points = polygons(compilePath(flat)).flat()
    assert.ok(points.every(Number.isFinite))
    assert.ok(points.length > 4)
    assert.ok(points.filter((_, i) => !(i % 2)).every((x) => x === 20))
    const ys = points.filter((_, i) => i % 2)
    assert.ok(Math.abs(Math.min(...ys) - 25) < 1e-7)
    assert.ok(Math.abs(Math.max(...ys) - 35) < 1e-7)
})

test('exact zero-length contours remain empty for every line cap as in native Chromium', () => {
    const cache = new PathGraphicsCache()
    const paths: { kind: string; path: DrawPath }[] = []
    for (const kind of ['move', 'line', 'quadratic', 'arc', 'sweep', 'arcTo']) {
        const path = new DrawPath()
        path.moveTo(20, 20)
        if (kind === 'line') path.lineTo(20, 20)
        if (kind === 'quadratic') path.quadraticCurveTo(20, 20, 20, 20)
        if (kind === 'arc') path.arc(20, 20, 0, 0, Math.PI * 2)
        if (kind === 'sweep') path.arc(10, 20, 10, 0, 0)
        if (kind === 'arcTo') path.arcTo(20, 20, 30, 30, 5)
        paths.push({ kind, path })
    }
    try {
        for (const cap of ['butt', 'round', 'square'] as const) {
            for (const { kind, path } of paths) {
                const context = cache.get(path, { color: 0, width: 10, cap }, true, 'nonzero', cap)
                assert.equal(coverage(context, 20.2, 20.7, `${kind}:${cap}`), 0)
            }
        }
    } finally {
        cache.destroy()
    }
})

test('added full circles remain open when subsequent lines continue the contour', () => {
    const circle = new DrawPath()
    circle.arc(20, 20, 10, Math.PI / 2, Math.PI * 2.5)
    const path = new DrawPath()
    path.addPath(circle)
    path.lineTo(45, 50)
    const shapes = compilePath(path).shapePath.shapePrimitives
    assert.equal(shapes.length, 1)
    const shape = shapes[0]?.shape
    assert.ok(shape?.type === 'polygon')
    assert.deepEqual(polygons(compilePath(path))[0]?.slice(-2), [45, 50])
    assert.equal((shape as Polygon).closePath, false)
})

test('transformed added paths snapshot their source and leave later commands unaffected', () => {
    const source = new DrawPath('M0 0 L10 0 L10 10 L0 10Z')
    const path = new DrawPath()
    path.addPath(source, { a: 2, d: 3, e: 20, f: 30 })
    source.rect(100, 100, 10, 10)
    path.transform({ e: 10, f: 20 })
    path.rect(0, 0, 5, 5)
    const compiled = compilePath(path)
    assert.equal(contains(compiled, 2, 2), true)
    assert.equal(contains(compiled, 35, 55), true)
    assert.equal(contains(compiled, 25, 35), false)
    assert.equal(contains(compiled, 250, 350), false)
})

test('compound fills apply nonzero/evenodd coverage once and retain winding cancellation', () => {
    const cache = new PathGraphicsCache()
    cache.beginFrame()
    try {
        for (const negative of [false, true]) {
            const path = new DrawPath()
            path.rect(0, 0, 20, 20)
            path.rect(negative ? 15 : 5, 5, negative ? -10 : 10, 10)
            for (const rule of ['nonzero', 'evenodd'] as const) {
                const context = cache.get(path, { color: 0xff0000, alpha: 0.5 }, false, rule, 'red')
                assert.equal(coverage(context, 2.1, 4.7), 1)
                assert.equal(coverage(context, 9.2, 10.1), negative || rule === 'evenodd' ? 0 : 1)
            }
        }
    } finally {
        cache.destroy()
    }
})

test('partially overlapping contours apply alpha once and respect both fill rules', () => {
    const cache = new PathGraphicsCache()
    try {
        for (const negative of [false, true]) {
            const path = new DrawPath()
            path.rect(0, 0, 20, 20)
            path.rect(negative ? 30 : 10, 5, negative ? -20 : 20, 20)
            for (const rule of ['nonzero', 'evenodd'] as const) {
                const context = cache.get(path, { color: 0, alpha: 0.5 }, false, rule, 'black')
                assert.equal(coverage(context, 13.2, 12.7), negative || rule === 'evenodd' ? 0 : 1)
                assert.equal(coverage(context, 24.2, 12.7), 1)
            }
        }
    } finally {
        cache.destroy()
    }
})

test('self-crossing polygons use valid fill coverage', () => {
    const path = new DrawPath('M0 0 L20 20 L0 20 L20 0 Z')
    const cache = new PathGraphicsCache()
    try {
        const context = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
        assert.equal(coverage(context, 10.2, 3.1), 1)
        assert.equal(coverage(context, 10.2, 16.1), 1)
        assert.equal(coverage(context, 3.2, 10.1), 0)
    } finally {
        cache.destroy()
    }
})

test('crossing stroked subpaths union coverage instead of darkening their intersection', () => {
    const path = new DrawPath('M0 10 L20 10 M10 0 L10 20')
    const cache = new PathGraphicsCache()
    try {
        const context = cache.get(
            path,
            { color: 0, alpha: 0.5, width: 4 },
            true,
            'nonzero',
            'black4',
        )
        assert.equal(coverage(context, 10.2, 10.7), 1)
        assert.equal(coverage(context, 2.2, 10.7), 1)
    } finally {
        cache.destroy()
    }
})

for (const fixture of [
    {
        name: 'miter extensions between separate contours',
        svg: 'M-10 -10 L0 0 L-10 10 M2.3 -3 L2.3 3',
        cap: 'butt',
        overlap: [1.337, 0.027],
        single: [-5.13, -4.77],
        outside: [4.31, 0.117],
    },
    {
        name: 'diagonal square caps between separate contours',
        svg: 'M-10 -10 L0 0 M2.3 -3 L2.3 3',
        cap: 'square',
        overlap: [1.337, 0.027],
        single: [-5.13, -4.77],
        outside: [4.31, 0.117],
    },
    {
        name: 'nonadjacent bodies of an open U contour',
        svg: 'M0 0 V3 H1 V0',
        cap: 'butt',
        overlap: [0.373, 1.271],
        single: [-0.371, 1.193],
        outside: [2.31, 1.11],
    },
    {
        name: 'a miter extension reaching a nonadjacent segment of the same contour',
        svg: 'M-10 -10 L0 0 L-10 10 L-30 10 L-30 30 L30 30 L30 -20 L2.3 -20 L2.3 3',
        cap: 'butt',
        overlap: [1.337, 0.027],
        single: [-5.13, -4.77],
        outside: [4.31, 0.117],
    },
] as const) {
    test(`stroke union applies alpha once for ${fixture.name}`, () => {
        const path = new DrawPath(fixture.svg)
        const cache = new PathGraphicsCache()
        const style: StrokeStyle = {
            color: 0x123456,
            alpha: 0.5,
            width: 2,
            cap: fixture.cap,
            join: 'miter',
            miterLimit: 10,
        }
        try {
            for (const resolution of [1, 64, 256]) {
                const rawNative = new GraphicsContext()
                    .path(compilePath(path, resolution))
                    .stroke({ ...style, width: 2 * resolution })
                try {
                    assert.ok(
                        coverage(
                            rawNative,
                            fixture.overlap[0] * resolution,
                            fixture.overlap[1] * resolution,
                        ) > 1,
                        'fixture must exercise overlapping native triangles before coverage union',
                    )
                } finally {
                    rawNative.destroy()
                }
                const resource = cache.get(
                    path,
                    style,
                    true,
                    'nonzero',
                    'half-opacity',
                    undefined,
                    resolution,
                )
                assert.ok(
                    resource instanceof PathMeshGeometry,
                    'overlap must use the union fallback',
                )
                assert.equal(resource.styleAlpha, 0.5)
                for (const point of [fixture.overlap, fixture.single]) {
                    assert.equal(
                        coverage(resource, point[0] * resolution, point[1] * resolution),
                        1,
                    )
                }
                assert.equal(
                    coverage(
                        resource,
                        fixture.outside[0] * resolution,
                        fixture.outside[1] * resolution,
                    ),
                    0,
                )
            }
            assert.equal(cache.stats.fallback, 3)
        } finally {
            cache.destroy()
        }
    })
}

test('retraced single contours preserve nonzero and evenodd fill coverage', () => {
    const path = new DrawPath('M0 0 L20 0 L20 20 L0 20 L0 0 L20 0 L20 20 L0 20 Z')
    const cache = new PathGraphicsCache()
    try {
        for (const rule of ['nonzero', 'evenodd'] as const) {
            const context = cache.get(path, { color: 0, alpha: 0.5 }, false, rule, 'black')
            assert.equal(coverage(context, 9.2, 10.1), rule === 'nonzero' ? 1 : 0)
        }
    } finally {
        cache.destroy()
    }
})

test('wide hairpin strokes apply alpha once where segment bodies overlap', () => {
    const path = new DrawPath('M0 0 L20 0 L0 1')
    const cache = new PathGraphicsCache()
    try {
        const context = cache.get(
            path,
            { color: 0, alpha: 0.5, width: 10 },
            true,
            'nonzero',
            'black10',
        )
        assert.equal(coverage(context, 9.2, 1.1), 1)
    } finally {
        cache.destroy()
    }
})

test('open S curves remain native when only an artificial closing edge would cross them', () => {
    const path = new DrawPath('M0 0 C100 0 -50 100 50 100')
    const cache = new PathGraphicsCache()
    try {
        cache.get(path, { color: 0, width: 1 }, true, 'nonzero', 'black1')
        assert.equal(cache.stats.fallback, 0)
        assert.equal(cache.stats.native, 1)
    } finally {
        cache.destroy()
    }
})

test('a full open circle retains square caps at its real starting angle', () => {
    const path = new DrawPath()
    path.arc(20, 20, 10, 0, Math.PI * 2)
    const cache = new PathGraphicsCache()
    try {
        const context = cache.get(
            path,
            { color: 0, width: 10, cap: 'square' },
            true,
            'nonzero',
            'square10',
        )
        assert.equal(coverage(context, 34.6, 24.4), 1)
    } finally {
        cache.destroy()
    }
})

test('compound SVG fallback shares compact arc-flag parsing with native paths', () => {
    const compact = new DrawPath('M0 0 A10 20 30 0110 20 L0 20Z')
    const spaced = new DrawPath('M0 0 A10 20 30 0 1 10 20 L0 20Z')
    compact.rect(0, 5, 5, 5)
    spaced.rect(0, 5, 5, 5)
    const cache = new PathGraphicsCache()
    try {
        const a = cache.get(compact, { color: 0 }, false, 'evenodd', 'black')
        const b = cache.get(spaced, { color: 0 }, false, 'evenodd', 'black')
        for (const x of [0.3, 2.4, 5.6, 8.7, 11.8]) {
            for (const y of [1.2, 6.3, 9.4, 13.5, 19.6]) {
                assert.equal(coverage(a, x, y), coverage(b, x, y), `${x}, ${y}`)
            }
        }
    } finally {
        cache.destroy()
    }
})

test('retained caches share clone geometry and invalidate unshared appends', () => {
    const cache = new PathGraphicsCache()
    try {
        const path = new DrawPath()
        path.rect(0, 0, 10, 10)
        const original = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
        assert.equal(cache.get(path.clone(), { color: 0 }, false, 'nonzero', 'black'), original)
        path.rect(20, 20, 10, 10)
        const appended = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
        assert.notEqual(appended, original)
        assert.equal(coverage(original, 22.2, 24.1), 0)
        assert.equal(coverage(appended, 22.2, 24.1), 1)
        const commands = path.commands
        path.rect(40, 40, 10, 10)
        assert.equal(path.commands, commands)
        const unshared = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
        assert.notEqual(unshared, appended)
        assert.equal(coverage(unshared, 42.2, 44.1), 1)
    } finally {
        cache.destroy()
    }
})

test('cache frame pins retain live draws and evict only unused contexts', () => {
    const cache = new PathGraphicsCache(3000)
    const first = new DrawPath()
    first.rect(0, 0, 10, 10)
    const second = new DrawPath()
    second.rect(20, 20, 10, 10)
    const third = new DrawPath()
    third.rect(40, 40, 10, 10)
    cache.beginFrame()
    const a = cache.get(first, { color: 0 }, false, 'nonzero', 'black')
    const b = cache.get(second, { color: 0 }, false, 'nonzero', 'black')
    cache.endFrame()
    assert.equal(a.destroyed, false)
    assert.equal(b.destroyed, false)
    assert.ok(cache.retainedBytes > 0 && cache.retainedBytes <= 3000)
    cache.beginFrame()
    assert.equal(cache.get(first, { color: 0 }, false, 'nonzero', 'black'), a)
    const c = cache.get(third, { color: 0 }, false, 'nonzero', 'black')
    cache.endFrame()
    assert.equal(a.destroyed, false)
    assert.equal(b.destroyed, true)
    assert.equal(c.destroyed, false)
    assert.ok(cache.retainedBytes <= 3000)
    cache.beginFrame()
    const rebuilt = cache.get(second, { color: 0 }, false, 'nonzero', 'black')
    assert.notEqual(rebuilt, b)
    cache.destroy()
    assert.equal(a.destroyed, true)
    assert.equal(c.destroyed, true)
    assert.equal(rebuilt.destroyed, true)
})

test('over-budget contexts survive their frame and repeated hits without entering retained accounting', () => {
    const cache = new PathGraphicsCache(1024)
    const path = new DrawPath()
    path.rect(0, 0, 10, 10)
    cache.beginFrame()
    const first = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
    assert.equal(cache.get(path, { color: 0 }, false, 'nonzero', 'black'), first)
    cache.endFrame()
    assert.equal(first.destroyed, false)
    assert.equal(cache.retainedBytes, 0)
    cache.beginFrame()
    assert.equal(first.destroyed, true)
    const second = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
    assert.notEqual(second, first)
    assert.equal(cache.retainedBytes, 0)
    cache.beginFrame()
    assert.equal(second.destroyed, true)
    assert.equal(cache.retainedBytes, 0)
    cache.destroy()
})

test('retained accounting follows native ellipse tessellation growth instead of a fixed point count', () => {
    const cache = new PathGraphicsCache()
    try {
        const small = new DrawPath()
        small.arc(0, 0, 16, 0, Math.PI * 2)
        cache.get(small, { color: 0 }, false, 'nonzero', 'black')
        const smallBytes = cache.retainedBytes
        const large = new DrawPath()
        large.arc(0, 0, 1024, 0, Math.PI * 2)
        cache.get(large, { color: 0 }, false, 'nonzero', 'black')
        const largeBytes = cache.retainedBytes - smallBytes
        assert.ok(smallBytes > 0)
        assert.ok(largeBytes > smallBytes * 4)
    } finally {
        cache.destroy()
    }
})

test('retained accounting includes the extra geometry of large round stroke caps', () => {
    const cache = new PathGraphicsCache()
    const path = new DrawPath('M0 0 L100 0')
    try {
        cache.get(path, { color: 0, width: 1, cap: 'butt' }, true, 'nonzero', 'butt1')
        const buttBytes = cache.retainedBytes
        cache.get(path, { color: 0, width: 1, cap: 'round' }, true, 'nonzero', 'round1')
        const roundBytes = cache.retainedBytes - buttBytes
        const beforeLarge = cache.retainedBytes
        cache.get(path, { color: 0, width: 100, cap: 'round' }, true, 'nonzero', 'round100')
        const largeBytes = cache.retainedBytes - beforeLarge
        assert.ok(roundBytes > buttBytes)
        assert.ok(largeBytes > roundBytes * 2)
    } finally {
        cache.destroy()
    }
})

test('scene pins deduplicate contexts and count overlapping pin groups only once', () => {
    const cache = new PathGraphicsCache()
    const first = new DrawPath('M0 0 H10 V10 H0Z')
    const second = new DrawPath('M20 20 H30 V30 H20Z')
    try {
        const a = cache.get(first, { color: 0 }, false, 'nonzero', 'black')
        const aBytes = cache.retainedBytes
        const b = cache.get(second, { color: 0 }, false, 'nonzero', 'black')
        const allBytes = cache.retainedBytes
        const releaseA = cache.pin([a, a, a])
        assert.ok(releaseA)
        assert.equal(cache.pinnedBytes, aBytes)
        const releaseBoth = cache.pin([a, b, b])
        assert.ok(releaseBoth)
        assert.equal(cache.pinnedBytes, allBytes)
        releaseA()
        releaseA()
        assert.equal(cache.pinnedBytes, allBytes)
        releaseBoth()
        releaseBoth()
        assert.equal(cache.pinnedBytes, 0)
        assert.equal(a.destroyed, false)
        assert.equal(b.destroyed, false)
    } finally {
        cache.destroy()
    }
})

test('declining a foreign context leaves both existing and proposed scene pins unchanged', () => {
    const cache = new PathGraphicsCache()
    const foreignCache = new PathGraphicsCache()
    const first = new DrawPath('M0 0 H10 V10 H0Z')
    const second = new DrawPath('M20 20 H30 V30 H20Z')
    try {
        const a = cache.get(first, { color: 0 }, false, 'nonzero', 'black')
        const aBytes = cache.retainedBytes
        const b = cache.get(second, { color: 0 }, false, 'nonzero', 'black')
        const foreign = foreignCache.get(first, { color: 0 }, false, 'nonzero', 'black')
        const releaseA = cache.pin([a])
        assert.ok(releaseA)
        const candidate = function* () {
            yield b
            yield a
            yield foreign
        }
        assert.equal(cache.pin(candidate()), undefined)
        assert.equal(cache.pinnedBytes, aBytes)
        releaseA()
        assert.equal(
            cache.pinnedBytes,
            0,
            'a rejected group must not increment an existing pin count',
        )
        assert.equal(foreignCache.pinnedBytes, 0)
    } finally {
        cache.destroy()
        foreignCache.destroy()
    }
})

test('scene pins protect unused geometry across frames and release it for later eviction', () => {
    const cache = new PathGraphicsCache(3000)
    const paths = Array.from({ length: 4 }, (_, i) => {
        const path = new DrawPath()
        path.rect(i * 20, 0, 10, 10)
        return path
    })
    try {
        cache.beginFrame()
        const a = cache.get(paths[0]!, { color: 0 }, false, 'nonzero', 'black')
        const aBytes = cache.retainedBytes
        const b = cache.get(paths[1]!, { color: 0 }, false, 'nonzero', 'black')
        const releaseA = cache.pin([a])
        assert.ok(releaseA)
        cache.endFrame()
        cache.beginFrame()
        const c = cache.get(paths[2]!, { color: 0 }, false, 'nonzero', 'black')
        cache.endFrame()
        assert.equal(a.destroyed, false)
        assert.equal(b.destroyed, true)
        assert.equal(c.destroyed, false)
        assert.equal(cache.pinnedBytes, aBytes)
        assert.ok(cache.retainedBytes <= 3000)
        releaseA()
        assert.equal(cache.pinnedBytes, 0)
        cache.beginFrame()
        cache.get(paths[3]!, { color: 0 }, false, 'nonzero', 'black')
        assert.equal(a.destroyed, true)
        assert.equal(c.destroyed, false)
        assert.equal(cache.pin([a]), undefined, 'evicted geometry cannot be captured')
    } finally {
        cache.destroy()
    }
})

test('overflow contexts cannot join a scene capture or partially pin its resident contexts', () => {
    const cache = new PathGraphicsCache(3000)
    const paths = Array.from({ length: 4 }, (_, i) => {
        const path = new DrawPath()
        path.rect(i * 20, 0, 10, 10)
        return path
    })
    try {
        cache.beginFrame()
        const a = cache.get(paths[0]!, { color: 0 }, false, 'nonzero', 'black')
        cache.get(paths[1]!, { color: 0 }, false, 'nonzero', 'black')
        const retained = cache.retainedBytes
        const overflow = cache.get(paths[2]!, { color: 0 }, false, 'nonzero', 'black')
        assert.equal(cache.retainedBytes, retained)
        assert.equal(cache.pin([a, overflow]), undefined)
        assert.equal(cache.pinnedBytes, 0)
        assert.equal(overflow.destroyed, false)
        cache.beginFrame()
        assert.equal(overflow.destroyed, true)
        cache.get(paths[3]!, { color: 0 }, false, 'nonzero', 'black')
        assert.equal(a.destroyed, true, 'failed capture must leave its resident entry evictable')
    } finally {
        cache.destroy()
    }
})

test('a fully scene-pinned cache preserves its budget and gives new draws only frame lifetime', () => {
    const cache = new PathGraphicsCache(3000)
    const paths = Array.from({ length: 3 }, (_, i) => {
        const path = new DrawPath()
        path.rect(i * 20, 0, 10, 10)
        return path
    })
    try {
        cache.beginFrame()
        const a = cache.get(paths[0]!, { color: 0 }, false, 'nonzero', 'black')
        const b = cache.get(paths[1]!, { color: 0 }, false, 'nonzero', 'black')
        const release = cache.pin([a, b])
        assert.ok(release)
        const protectedBytes = cache.pinnedBytes
        assert.equal(protectedBytes, cache.retainedBytes)
        cache.beginFrame()
        const c = cache.get(paths[2]!, { color: 0 }, false, 'nonzero', 'black')
        cache.endFrame()
        assert.equal(cache.retainedBytes, protectedBytes)
        assert.equal(cache.pinnedBytes, protectedBytes)
        assert.equal(cache.pin([c]), undefined)
        assert.equal(a.destroyed, false)
        assert.equal(b.destroyed, false)
        assert.equal(c.destroyed, false)
        cache.beginFrame()
        assert.equal(c.destroyed, true)
        release()
        assert.equal(cache.pinnedBytes, 0)
    } finally {
        cache.destroy()
    }
})

test('destroyed scene pins release idempotently without corrupting later cache accounting', () => {
    const cache = new PathGraphicsCache()
    const path = new DrawPath('M0 0 H10 V10 H0Z')
    const old = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
    const releaseOld = cache.pin([old])
    const releaseOldAgain = cache.pin([old])
    assert.ok(releaseOld && releaseOldAgain)
    assert.ok(cache.pinnedBytes > 0)
    cache.destroy()
    assert.equal(old.destroyed, true)
    assert.equal(cache.retainedBytes, 0)
    assert.equal(cache.pinnedBytes, 0)
    assert.equal(cache.pin([old]), undefined)
    const next = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
    const releaseNext = cache.pin([next])
    assert.ok(releaseNext)
    const nextBytes = cache.pinnedBytes
    releaseOld()
    releaseOldAgain()
    releaseOld()
    assert.equal(cache.pinnedBytes, nextBytes)
    releaseNext()
    assert.equal(cache.pinnedBytes, 0)
    cache.destroy()
})

test('an empty scene capture succeeds with an idempotent no-op release', () => {
    const cache = new PathGraphicsCache()
    const release = cache.pin([])
    assert.ok(release)
    assert.equal(cache.pinnedBytes, 0)
    release()
    release()
    cache.destroy()
    release()
    assert.equal(cache.pinnedBytes, 0)
})

// The retained chart can be much larger than the current frame. Observe that
// lifecycle boundaries and hits do not enumerate that entire resident set.
function observeResidentVisits(cache: PathGraphicsCache) {
    const internals = cache as unknown as {
        frame: number
        entries: Set<unknown>
        evictable: unknown[]
        touched: unknown[]
    }
    const iterate = internals.entries[Symbol.iterator].bind(internals.entries)
    let visits = 0
    internals.entries[Symbol.iterator] = function* () {
        for (const entry of iterate()) {
            visits++
            yield entry
        }
        return undefined
    }
    return {
        get visits() {
            return visits
        },
        get frame() {
            return internals.frame
        },
        get eligible() {
            return [...internals.evictable]
        },
        get touched() {
            return internals.touched.length
        },
    }
}

test('idle frames advance without visiting residents after overflow presentation cleanup', () => {
    const cache = new PathGraphicsCache(3000)
    const observed = observeResidentVisits(cache)
    const paths = Array.from({ length: 3 }, (_, i) => {
        const path = new DrawPath()
        path.rect(i * 20, 0, 10, 10)
        return path
    })
    try {
        cache.beginFrame()
        const a = cache.get(paths[0]!, { color: 0 }, false, 'nonzero', 'black')
        const b = cache.get(paths[1]!, { color: 0 }, false, 'nonzero', 'black')
        const retained = cache.retainedBytes
        const overflow = cache.get(paths[2]!, { color: 0 }, false, 'nonzero', 'black')
        let destructions = 0
        overflow.on('destroy', () => destructions++)
        assert.equal(cache.retainedBytes, retained)
        cache.endFrame()
        assert.equal(overflow.destroyed, false, 'queued geometry survives presentation')
        cache.beginFrame()
        assert.equal(overflow.destroyed, true)
        assert.equal(destructions, 1)
        const frame = observed.frame,
            eligible = observed.eligible
        assert.equal(eligible.length, 2)
        for (let i = 0; i < 8; i++) {
            cache.endFrame()
            cache.beginFrame()
            assert.equal(observed.frame, frame + i + 1)
            assert.equal(observed.visits, 0)
            assert.deepEqual(observed.eligible, eligible)
            assert.equal(cache.retainedBytes, retained)
            assert.equal(a.destroyed, false)
            assert.equal(b.destroyed, false)
            assert.equal(destructions, 1)
        }
    } finally {
        cache.destroy()
    }
})

test('frame work follows touched resources instead of the retained scene working set', () => {
    const cache = new PathGraphicsCache()
    const observed = observeResidentVisits(cache)
    const paths = Array.from({ length: 128 }, (_, i) => new DrawPath(`M${i} 0 h10 v10 h-10Z`))
    try {
        const resources = paths.map((path) =>
            cache.get(path, { color: 0 }, false, 'nonzero', 'black'),
        )
        const releaseAll = cache.pin(resources)
        assert.ok(releaseAll)
        cache.beginFrame()
        assert.equal(observed.touched, 0)
        assert.equal(observed.eligible.length, 0)
        for (let frame = 0; frame < 8; frame++) {
            for (let hit = 0; hit < 64; hit++)
                assert.equal(
                    cache.get(paths[0]!, { color: 0 }, false, 'nonzero', 'black'),
                    resources[0],
                )
            assert.equal(observed.touched, 1, 'repeated hits enqueue just once per frame')
            cache.beginFrame()
            assert.equal(observed.touched, 0)
            assert.equal(observed.eligible.length, 0)
            assert.equal(observed.visits, 0, 'offscreen scene pins need no per-frame visit')
        }
        releaseAll()
        cache.beginFrame()
        assert.equal(observed.eligible.length, resources.length)
        assert.equal(observed.visits, 0)
        assert.equal(cache.pinnedBytes, 0)
    } finally {
        cache.destroy()
    }
})

test('idle frames preserve hit recency and restore exact LRU order after a scene unpins', () => {
    const paths = Array.from({ length: 5 }, (_, i) => {
        const path = new DrawPath()
        path.rect(i * 20, 0, 10, 10)
        return path
    })
    const sizing = new PathGraphicsCache()
    sizing.get(paths[0]!, { color: 0 }, false, 'nonzero', 'black')
    const budget = sizing.retainedBytes * 3
    sizing.destroy()
    const cache = new PathGraphicsCache(budget)
    const get = (index: number) => cache.get(paths[index]!, { color: 0 }, false, 'nonzero', 'black')
    try {
        const a = get(0),
            b = get(1),
            c = get(2)
        cache.beginFrame()
        cache.beginFrame()
        assert.equal(get(0), a)
        const releaseB = cache.pin([b])
        assert.ok(releaseB)
        cache.beginFrame()
        cache.beginFrame()
        const d = get(3)
        assert.equal(c.destroyed, true, 'recent hit and scene pin both survive pressure')
        assert.equal(a.destroyed, false)
        assert.equal(b.destroyed, false)
        cache.beginFrame()
        cache.beginFrame()
        releaseB()
        // B regains its original last-access order as soon as its pin expires.
        cache.beginFrame()
        cache.beginFrame()
        const e = get(4)
        assert.equal(b.destroyed, true, 'old scene geometry must evict before the recent hit')
        assert.equal(a.destroyed, false)
        assert.equal(d.destroyed, false)
        assert.equal(e.destroyed, false)
        assert.equal(cache.retainedBytes, budget)
        const release = cache.pin([a, d, e])
        assert.ok(release, 'all replacement geometry remains resident rather than overflow')
        release()
    } finally {
        cache.destroy()
    }
})

function residentFixture(capacity: number, count = capacity + 3) {
    const paths = Array.from({ length: count }, (_, i) => {
        const path = new DrawPath()
        path.rect(i * 20, 0, 10, 10)
        return path
    })
    const sizing = new PathGraphicsCache()
    sizing.get(paths[0]!, { color: 0 }, false, 'nonzero', 'black')
    const entryBytes = sizing.retainedBytes
    sizing.destroy()
    const cache = new PathGraphicsCache(entryBytes * capacity)
    return {
        cache,
        entryBytes,
        get: (index: number) => cache.get(paths[index]!, { color: 0 }, false, 'nonzero', 'black'),
    }
}

test('eviction follows final hit order even when a frame touches the same resource repeatedly', () => {
    const { cache, get } = residentFixture(3)
    try {
        const a = get(0),
            b = get(1),
            c = get(2)
        cache.beginFrame()
        assert.equal(get(0), a)
        assert.equal(get(1), b)
        assert.equal(get(0), a)
        cache.beginFrame()
        get(3)
        assert.equal(c.destroyed, true)
        assert.equal(a.destroyed, false)
        assert.equal(b.destroyed, false)
        get(4)
        assert.equal(b.destroyed, true, 'the first-touch queue must not replace last-hit recency')
        assert.equal(a.destroyed, false)
    } finally {
        cache.destroy()
    }
})

test('a late scene release restores original LRU order before an immediate miss', () => {
    const { cache, get } = residentFixture(3)
    try {
        const a = get(0),
            b = get(1),
            c = get(2)
        const release = cache.pin([a])
        assert.ok(release)
        cache.beginFrame()
        assert.equal(get(1), b)
        cache.beginFrame()
        release()
        get(3)
        assert.equal(a.destroyed, true, 'unpinning does not count as a draw or refresh recency')
        assert.equal(b.destroyed, false)
        assert.equal(c.destroyed, false)
    } finally {
        cache.destroy()
    }
})

test('releasing the last overlapping scene pin preserves current-frame geometry', () => {
    const { cache, get } = residentFixture(3)
    try {
        const a = get(0),
            b = get(1),
            c = get(2)
        const releaseFirst = cache.pin([a])
        const releaseSecond = cache.pin([a])
        assert.ok(releaseFirst && releaseSecond)
        cache.beginFrame()
        assert.equal(get(0), a)
        releaseFirst()
        releaseSecond()
        get(3)
        assert.equal(a.destroyed, false, 'a released scene can still be in the submitted frame')
        assert.equal(b.destroyed, true)
        assert.equal(c.destroyed, false)
        cache.beginFrame()
        get(4)
        assert.equal(c.destroyed, true)
        get(5)
        assert.equal(a.destroyed, true, 'the previous frame pin expires at the next boundary')
    } finally {
        cache.destroy()
    }
})

test('destroy clears frame and eviction queues before reuse and delayed scene releases', () => {
    const { cache, get, entryBytes } = residentFixture(3)
    try {
        const a = get(0),
            b = get(1),
            c = get(2),
            overflow = get(3)
        const release = cache.pin([a])
        assert.ok(release)
        cache.beginFrame()
        assert.equal(overflow.destroyed, true)
        get(0) // Both the current-frame queue and older eviction queue are populated.
        cache.destroy()
        for (const resource of [a, b, c, overflow]) assert.equal(resource.destroyed, true)
        const next = get(3),
            another = get(4)
        cache.beginFrame()
        release()
        release()
        assert.equal(cache.pinnedBytes, 0)
        get(5)
        get(0)
        assert.equal(next.destroyed, true)
        assert.equal(another.destroyed, false)
        assert.equal(cache.retainedBytes, 3 * entryBytes)
    } finally {
        cache.destroy()
    }
})

test('evicting a pinned old path version preserves its replacement compiled owner', () => {
    const path = new DrawPath()
    path.rect(0, 0, 10, 10)
    const sizing = new PathGraphicsCache()
    sizing.get(path, { color: 0 }, false, 'nonzero', 'black')
    path.rect(20, 0, 10, 10)
    sizing.get(path, { color: 0 }, false, 'nonzero', 'black')
    const cache = new PathGraphicsCache(sizing.retainedBytes)
    sizing.destroy()
    const mutable = new DrawPath()
    mutable.rect(0, 0, 10, 10)
    const get = () => cache.get(mutable, { color: 0 }, false, 'nonzero', 'black')
    try {
        const old = get()
        const release = cache.pin([old])
        assert.ok(release)
        cache.beginFrame()
        mutable.rect(20, 0, 10, 10)
        const next = get()
        assert.notEqual(next, old)
        cache.beginFrame()
        release()
        cache.get(new DrawPath('M40 0 h10 v10 h-10Z'), { color: 0 }, false, 'nonzero', 'black')
        assert.equal(old.destroyed, true)
        assert.equal(next.destroyed, false)
        assert.equal(get(), next)
    } finally {
        cache.destroy()
    }
})

test('mixed frame hits, pin releases and pressure follow an independent last-access model', () => {
    const capacity = 7
    const { cache, get, entryBytes } = residentFixture(capacity, 24)
    type Model = {
        resource: ReturnType<typeof get>
        key: number
        access: number
        frame: number
        pins: number
        resident: boolean
        alive: boolean
    }
    const current = new Map<number, Model>()
    const history: Model[] = []
    const groups: { models: Model[]; release: () => void; active: boolean }[] = []
    let frame = 0,
        access = 0,
        seed = 8297
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
    const remove = (model: Model) => {
        model.alive = false
        current.delete(model.key)
    }
    const residents = () => [...current.values()].filter((model) => model.resident)
    try {
        for (let step = 0; step < 600; step++) {
            const action = random() % 10
            if (action < 2) {
                for (const model of current.values()) if (!model.resident) remove(model)
                frame++
                cache.beginFrame()
            } else if (action === 2) {
                const models = residents().filter(() => random() % 3 === 0)
                const release = cache.pin(models.map(({ resource }) => resource))
                assert.ok(release)
                for (const model of models) model.pins++
                groups.push({ models, release, active: true })
            } else if (action === 3 && groups.length) {
                const group = groups[random() % groups.length]!
                group.release()
                if (group.active) for (const model of group.models) model.pins--
                group.active = false
            } else {
                const key = random() % 24
                const existing = current.get(key)
                if (existing) {
                    existing.access = ++access
                    existing.frame = frame
                    assert.equal(get(key), existing.resource)
                } else {
                    if (residents().length === capacity) {
                        const oldest = residents()
                            .filter((model) => !model.pins && model.frame !== frame)
                            .sort((a, b) => a.access - b.access)[0]
                        if (oldest) remove(oldest)
                    }
                    const resident = residents().length < capacity
                    const model: Model = {
                        resource: get(key),
                        key,
                        access: ++access,
                        frame,
                        pins: 0,
                        resident,
                        alive: true,
                    }
                    current.set(key, model)
                    history.push(model)
                }
            }
            cache.endFrame()
            for (const model of history)
                assert.equal(
                    model.resource.destroyed,
                    !model.alive,
                    `resource ${model.key}, step ${step}`,
                )
            assert.equal(
                cache.retainedBytes,
                residents().length * entryBytes,
                `bytes, step ${step}`,
            )
            assert.equal(
                cache.pinnedBytes,
                residents().filter((model) => model.pins).length * entryBytes,
                `pins, step ${step}`,
            )
        }
    } finally {
        cache.destroy()
    }
})
