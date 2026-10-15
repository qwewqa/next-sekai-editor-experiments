import assert from 'node:assert/strict'
import test from 'node:test'
import { GraphicsContext, Texture } from 'pixi.js'
import { DrawPath } from '../../src/rendering/path'
import { PathGraphicsCache } from '../../src/rendering/pathGraphics'
import { PathMeshGeometry } from '../../src/rendering/pathMesh'
import { pathTriangles } from '../../src/rendering/pathTriangles'

const rectangle = (x = 0, y = 0, width = 10, height = 10) => {
    const path = new DrawPath()
    path.rect(x, y, width, height)
    return path
}
const triangleArea = (triangles: Float64Array) => {
    let area = 0
    for (let i = 0; i < triangles.length; i += 6) {
        const x = triangles[i]!,
            y = triangles[i + 1]!
        area +=
            Math.abs(
                (triangles[i + 2]! - x) * (triangles[i + 5]! - y) -
                    (triangles[i + 3]! - y) * (triangles[i + 4]! - x),
            ) / 2
    }
    return area
}

test('empty fill metadata agrees with actual triangle extraction after nonempty geometry', () => {
    const cache = new PathGraphicsCache()
    const cases: [string, DrawPath][] = [
        ['empty', new DrawPath()],
        ['move only', new DrawPath('M7 8')],
        ['line', new DrawPath('M0 0 L10 10')],
        ['collinear quad', new DrawPath('M0 0 L2 4 L4 8 L6 12Z')],
    ]
    for (const [name, width, height] of [
        ['zero-width roundRect', 0, 8],
        ['zero-height roundRect', 8, 0],
    ] as const) {
        const path = new DrawPath()
        path.roundRect(0, 0, width, height, 2)
        cases.push([name, path])
    }
    const zeroRadius = new DrawPath(),
        zeroSweep = new DrawPath()
    zeroRadius.arc(7, 8, 0, 0, Math.PI * 2)
    zeroSweep.arc(7, 8, 3, 1, 1)
    cases.push(['zero-radius arc', zeroRadius], ['zero-sweep arc', zeroSweep])
    try {
        let nativeEmpty = 0
        for (const [name, path] of cases) {
            const prior = cache.get(rectangle(20, 20), { color: 0 }, false, 'nonzero', 'black')
            assert.equal(cache.isEmpty(prior), false)
            assert.ok(pathTriangles(prior).length > 0)
            const resource = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
            assert.equal(cache.isEmpty(resource), true, name)
            assert.equal(pathTriangles(resource).length, 0, name)
            if (resource instanceof GraphicsContext) nativeEmpty++
            assert.equal(cache.get(path.clone(), { color: 0 }, false, 'nonzero', 'black'), resource)
            assert.equal(cache.isEmpty(resource), true)
            assert.equal(
                cache.isEmpty(prior),
                false,
                'empty metadata cannot contaminate prior geometry',
            )
        }
        assert.ok(
            nativeEmpty >= 5,
            'fixtures must exercise native resources, not only empty meshes',
        )
    } finally {
        cache.destroy()
    }
})

test('large-origin narrow fills retain nonzero area despite absolute-coordinate cancellation', () => {
    const x = 2 ** 40,
        y = 2 ** 40,
        width = 2 ** -10,
        height = 2 ** -8
    const coordinates = [x, y, x + width, y, x + width, y + height, x, y + height]
    let absoluteArea = 0
    for (let i = 0; i < coordinates.length; i += 2) {
        const next = (i + 2) % coordinates.length
        absoluteArea +=
            coordinates[i]! * coordinates[next + 1]! - coordinates[next]! * coordinates[i + 1]!
    }
    assert.equal(absoluteArea, 0, 'fixture must expose naive signed-area cancellation')
    const cache = new PathGraphicsCache()
    try {
        for (const resolution of [1, 64, 256]) {
            const resource = cache.get(
                rectangle(x, y, width, height),
                { color: 0 },
                false,
                'nonzero',
                'black',
                undefined,
                resolution,
            )
            assert.ok(resource instanceof GraphicsContext)
            assert.equal(cache.isEmpty(resource), false)
            assert.equal(triangleArea(pathTriangles(resource)) / resolution ** 2, width * height)
        }
    } finally {
        cache.destroy()
    }
})

test('reflected and collapsed transformed fills keep distinct nonempty and empty classifications', () => {
    const source = rectangle(0, 0, 0.25, 0.5)
    const reflected = new DrawPath(),
        collapsed = new DrawPath()
    reflected.addPath(source, { a: -2, d: 0.5, e: 2 ** 30, f: -(2 ** 30) })
    collapsed.addPath(source, { a: 1, b: 2, c: 0.5, d: 1 })
    const cache = new PathGraphicsCache()
    try {
        const nonempty = cache.get(reflected, { color: 0 }, false, 'nonzero', 'black')
        assert.equal(cache.isEmpty(nonempty), false)
        assert.equal(triangleArea(pathTriangles(nonempty)), 0.125)
        const empty = cache.get(collapsed, { color: 0 }, false, 'nonzero', 'black')
        assert.equal(cache.isEmpty(empty), true)
        assert.equal(pathTriangles(empty).length, 0)
    } finally {
        cache.destroy()
    }
})

test('opposite winding disjoint contours stay visible while true compound cancellation is empty', () => {
    const disjoint = rectangle(0, 0, 4, 4)
    disjoint.rect(14, 0, -4, 4)
    const cancelled = rectangle(0, 0, 4, 4)
    cancelled.rect(4, 0, -4, 4)
    const repeated = rectangle(0, 0, 4, 4)
    repeated.rect(0, 0, 4, 4)
    const cache = new PathGraphicsCache()
    try {
        const separated = cache.get(disjoint, { color: 0 }, false, 'nonzero', 'black')
        assert.ok(separated instanceof GraphicsContext)
        assert.equal(
            cache.isEmpty(separated),
            false,
            'signed area cannot be summed across separate contours',
        )
        assert.equal(triangleArea(pathTriangles(separated)), 32)
        for (const [path, rule] of [
            [cancelled, 'nonzero'],
            [repeated, 'evenodd'],
        ] as const) {
            const emptyMesh = cache.get(path, { color: 0 }, false, rule, 'black')
            assert.ok(emptyMesh instanceof PathMeshGeometry)
            assert.equal(cache.isEmpty(emptyMesh), true)
            assert.equal(pathTriangles(emptyMesh).length, 0)
            const emptyNative = cache.get(
                path,
                { texture: Texture.WHITE },
                false,
                rule,
                'generic-texture',
            )
            assert.ok(emptyNative instanceof GraphicsContext)
            assert.equal(cache.isEmpty(emptyNative), true)
            assert.equal(pathTriangles(emptyNative).length, 0)
        }
        const union = cache.get(repeated, { color: 0 }, false, 'nonzero', 'black')
        assert.equal(cache.isEmpty(union), false)
        assert.equal(triangleArea(pathTriangles(union)), 16)
    } finally {
        cache.destroy()
    }
})

test('an empty line fill does not suppress its stroke or a later nonempty path append', () => {
    const cache = new PathGraphicsCache()
    const path = new DrawPath('M0 0 L10 0')
    try {
        const empty = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
        const stroke = cache.get(path, { color: 0, width: 2 }, true, 'nonzero', 'stroke')
        assert.equal(cache.isEmpty(empty), true)
        assert.equal(cache.isEmpty(stroke), false)
        assert.ok(pathTriangles(stroke).length > 0)
        const snapshot = path.clone()
        path.lineTo(10, 10)
        const nonempty = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
        assert.equal(cache.isEmpty(nonempty), false)
        assert.equal(triangleArea(pathTriangles(nonempty)), 50)
        assert.equal(cache.get(snapshot, { color: 0 }, false, 'nonzero', 'black'), empty)
        assert.equal(cache.isEmpty(empty), true)
    } finally {
        cache.destroy()
    }
})

test('zero-length native strokes use actual triangle emptiness for every cap', () => {
    const cache = new PathGraphicsCache()
    const zeroRadius = new DrawPath()
    zeroRadius.arc(4, 7, 0, 0, 2 * Math.PI)
    const cases = [
        new DrawPath(),
        new DrawPath('M4 7'),
        new DrawPath('M4 7 L4 7'),
        new DrawPath('M4 7 Q4 7 4 7'),
        new DrawPath('M4 7 C4 7 4 7 4 7'),
        zeroRadius,
    ]
    try {
        for (const cap of ['butt', 'round', 'square'] as const) {
            for (const path of cases) {
                const resource = cache.get(path, { color: 0, width: 4, cap }, true, 'nonzero', cap)
                const triangles = pathTriangles(resource)
                assert.equal(
                    cache.isEmpty(resource),
                    triangles.length === 0,
                    `${cap}: ${JSON.stringify(path.commands)}`,
                )
            }
            const real = cache.get(
                new DrawPath('M4 7 L8 7'),
                { color: 0, width: 4, cap },
                true,
                'nonzero',
                cap,
            )
            assert.equal(cache.isEmpty(real), false)
            assert.ok(pathTriangles(real).length > 0)
        }
    } finally {
        cache.destroy()
    }
})

test('empty metadata follows resource identity through scene pins, eviction and cache reuse', () => {
    const path = new DrawPath('M0 0 L10 10')
    const sizing = new PathGraphicsCache()
    sizing.get(path, { color: 0 }, false, 'nonzero', 'black')
    sizing.get(rectangle(), { color: 0 }, false, 'nonzero', 'black')
    const budget = sizing.retainedBytes
    sizing.destroy()
    const cache = new PathGraphicsCache(budget)
    try {
        const empty = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
        const release = cache.pin([empty])
        assert.ok(release)
        for (let i = 0; i < 3; i++) {
            cache.beginFrame()
            const filled = cache.get(rectangle(i * 20, 0), { color: 0 }, false, 'nonzero', 'black')
            assert.equal(cache.isEmpty(filled), false)
            assert.equal(cache.isEmpty(empty), true)
            assert.equal(empty.destroyed, false)
        }
        cache.beginFrame()
        release()
        cache.get(rectangle(80, 0), { color: 0 }, false, 'nonzero', 'black')
        cache.get(rectangle(100, 0), { color: 0 }, false, 'nonzero', 'black')
        assert.equal(empty.destroyed, true)
        const rebuilt = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
        assert.notEqual(rebuilt, empty)
        assert.equal(cache.isEmpty(rebuilt), true)
        assert.equal(pathTriangles(rebuilt).length, 0)
        cache.destroy()
        assert.equal(rebuilt.destroyed, true)
        release()
        const filled = cache.get(rectangle(), { color: 0 }, false, 'nonzero', 'black')
        const nextEmpty = cache.get(path, { color: 0 }, false, 'nonzero', 'black')
        assert.equal(cache.isEmpty(filled), false)
        assert.equal(cache.isEmpty(nextEmpty), true)
        assert.notEqual(nextEmpty, rebuilt)
        assert.ok(cache.retainedBytes <= budget)
    } finally {
        cache.destroy()
    }
})
