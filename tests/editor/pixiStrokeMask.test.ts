import assert from 'node:assert/strict'
import test from 'node:test'
import { GpuGraphicsContext, GraphicsContext, Texture, type StrokeStyle } from 'pixi.js'
import { DrawPath } from '../../src/rendering/path'
import { PathGraphicsCache } from '../../src/rendering/pathGraphics'
import { PathMeshGeometry } from '../../src/rendering/pathMesh'
import { pathTriangles } from '../../src/rendering/pathTriangles'

const style = { width: 2, cap: 'butt', join: 'miter', miterLimit: 10 } as const
const line = () => new DrawPath('M0 0 L10 0')
const mask = (resource: ReturnType<PathGraphicsCache['getStrokeMask']>) => {
    assert.ok(resource instanceof GraphicsContext)
    return resource
}
// These interior samples deliberately avoid shared triangle edges.
const coverage = (triangles: Float64Array, x: number, y: number) => {
    let count = 0
    for (let i = 0; i < triangles.length; i += 6) {
        const edges = [0, 1, 2].map((edge) => {
            const a = i + edge * 2,
                b = i + ((edge + 1) % 3) * 2
            return (
                (triangles[b]! - triangles[a]!) * (y - triangles[a + 1]!) -
                (triangles[b + 1]! - triangles[a + 1]!) * (x - triangles[a]!)
            )
        })
        if (edges.every((value) => value > 1e-8) || edges.every((value) => value < -1e-8)) count++
    }
    return count
}

test('stroke masks retain raw overlapping native coverage for later stencil union', () => {
    const cache = new PathGraphicsCache()
    const path = new DrawPath('M0 0 V3 H1 V0')
    const raw = new GraphicsContext()
        .moveTo(0, 0)
        .lineTo(0, 3)
        .lineTo(1, 3)
        .lineTo(1, 0)
        .stroke(style)
    try {
        const result = mask(cache.getStrokeMask(path, style))
        const triangles = pathTriangles(result)
        assert.deepEqual(triangles, pathTriangles(raw))
        assert.ok(
            coverage(triangles, 0.373, 1.271) > 1,
            'mask deliberately preserves overlapping triangles',
        )
        const ordinary = cache.get(
            path,
            { ...style, color: 0xffffff, alpha: 0.37 },
            true,
            'nonzero',
            'ordinary',
        )
        assert.ok(ordinary instanceof PathMeshGeometry)
        assert.equal(
            coverage(pathTriangles(ordinary), 0.373, 1.271),
            1,
            'ordinary painted strokes must still union opacity',
        )
        assert.notEqual(result, ordinary)
        assert.equal(cache.stats.maskBuilt, 1)
        assert.equal(cache.stats.maskDeclined, 0)
    } finally {
        raw.destroy()
        cache.destroy()
    }
})

test('stroke-mask cache ignores paint and undashed phase while normal painted resources stay separate', () => {
    const cache = new PathGraphicsCache()
    const path = line()
    const red: StrokeStyle = { ...style, color: 0xff0000, alpha: 0.2 }
    const blue: StrokeStyle = { ...style, color: 0x0000ff, alpha: 0.8 }
    try {
        const result = mask(cache.getStrokeMask(path, red))
        assert.equal(cache.getStrokeMask(path, blue, { dash: [], dashOffset: 37 }), result)
        const instruction = result.instructions[0]
        assert.ok(instruction?.action === 'stroke')
        assert.equal(instruction.data.style.color, 0xffffff)
        assert.equal(instruction.data.style.alpha, 1)
        assert.equal(instruction.data.style.texture, Texture.WHITE)
        assert.notEqual(cache.get(path, red, true, 'nonzero', 'red'), result)
        assert.notEqual(cache.get(path, blue, true, 'nonzero', 'blue'), result)
        assert.equal(cache.stats.maskBuilt, 1)
        assert.equal(cache.stats.maskHits, 1)
    } finally {
        cache.destroy()
    }
})

test('stroke-mask appends invalidate geometry while clones share immutable snapshots', () => {
    const cache = new PathGraphicsCache()
    const path = line()
    const commands = path.commands
    try {
        const before = mask(cache.getStrokeMask(path, style))
        assert.equal(coverage(pathTriangles(before), 9.71, 2.13), 0)
        path.lineTo(10, 4)
        assert.equal(path.commands, commands)
        const after = mask(cache.getStrokeMask(path, style))
        assert.notEqual(after, before)
        assert.equal(coverage(pathTriangles(after), 9.71, 2.13), 1)
        const snapshot = path.clone()
        assert.equal(cache.getStrokeMask(snapshot, style), after)
        path.lineTo(20, 4)
        assert.notEqual(path.commands, commands)
        assert.equal(cache.getStrokeMask(snapshot, style), after)
        assert.notEqual(cache.getStrokeMask(path, style), after)
    } finally {
        cache.destroy()
    }
})

test('stroke-mask width and cap variants preserve coverage and default styles share identities', () => {
    const cache = new PathGraphicsCache()
    const path = line()
    try {
        const ordinary = mask(cache.getStrokeMask(path, style))
        const wide = mask(cache.getStrokeMask(path, { ...style, width: 4 }))
        const round = mask(cache.getStrokeMask(path, { ...style, cap: 'round' }))
        const square = mask(cache.getStrokeMask(path, { ...style, cap: 'square' }))
        assert.equal(new Set([ordinary, wide, round, square]).size, 4)
        assert.equal(coverage(pathTriangles(ordinary), 4.137, 1.373), 0)
        assert.equal(coverage(pathTriangles(wide), 4.137, 1.373), 1)
        assert.equal(coverage(pathTriangles(ordinary), -0.71, 0.13), 0)
        assert.ok(coverage(pathTriangles(round), -0.71, 0.13) > 0)
        assert.ok(coverage(pathTriangles(square), -0.71, 0.13) > 0)
        assert.equal(
            cache.getStrokeMask(path, {}),
            cache.getStrokeMask(path, { width: 1, cap: 'butt', join: 'miter', miterLimit: 10 }),
        )
    } finally {
        cache.destroy()
    }
})

test('stroke-mask joins and miter limits remain distinct coverage variants', () => {
    const cache = new PathGraphicsCache()
    const path = new DrawPath('M-10 -10 L0 0 L-10 10')
    try {
        const miter = mask(cache.getStrokeMask(path, style))
        const bevel = mask(cache.getStrokeMask(path, { ...style, join: 'bevel' }))
        const shortMiter = mask(cache.getStrokeMask(path, { ...style, miterLimit: 1 }))
        const round = mask(cache.getStrokeMask(path, { ...style, join: 'round' }))
        assert.equal(new Set([miter, bevel, shortMiter, round]).size, 4)
        assert.ok(coverage(pathTriangles(miter), 1.13, 0.113) > 0)
        assert.equal(coverage(pathTriangles(bevel), 1.13, 0.113), 0)
        assert.equal(coverage(pathTriangles(shortMiter), 1.13, 0.113), 0)
        assert.equal(coverage(pathTriangles(round), 1.13, 0.113), 0)
    } finally {
        cache.destroy()
    }
})

test('stroke-mask resolution buckets scale geometry and width together', () => {
    const cache = new PathGraphicsCache()
    const path = new DrawPath('M0 0 L10 0 L10 4')
    try {
        const ordinary = mask(cache.getStrokeMask(path, style))
        const reference = pathTriangles(ordinary)
        for (const resolution of [64, 256]) {
            const scaled = mask(cache.getStrokeMask(path, style, undefined, resolution))
            assert.notEqual(scaled, ordinary)
            assert.equal(cache.getStrokeMask(path, style, undefined, resolution), scaled)
            assert.deepEqual(
                pathTriangles(scaled).map((value) => value / resolution),
                reference,
            )
        }
    } finally {
        cache.destroy()
    }
})

test('unsupported dashes, square lone ellipses, and entirely point-like paths decline without resources', () => {
    const cache = new PathGraphicsCache()
    const ellipse = new DrawPath()
    ellipse.ellipse(0, 0, 4, 2, 0, 0, Math.PI * 2)
    const zeroEllipse = new DrawPath()
    zeroEllipse.arc(0, 0, 0, 0, Math.PI * 2)
    try {
        for (const dash of [[2, 2], [0], [0, 0]])
            assert.equal(cache.getStrokeMask(line(), style, { dash, dashOffset: 0 }), undefined)
        assert.equal(cache.getStrokeMask(ellipse, { ...style, cap: 'square' }), undefined)
        for (const path of [
            new DrawPath(),
            new DrawPath('M1 2'),
            new DrawPath('M1 2L1 2'),
            zeroEllipse,
        ])
            assert.equal(cache.getStrokeMask(path, { ...style, cap: 'round' }), undefined)
        assert.equal(cache.stats.maskDeclined, 8)
        assert.equal(cache.stats.maskBuilt, 0)
        assert.equal(cache.retainedBytes, 0)
        assert.ok(
            cache.getStrokeMask(ellipse, style) instanceof GraphicsContext,
            'ordinary ellipses remain eligible',
        )
    } finally {
        cache.destroy()
    }
})

test('tiny zero-index masks are cached empty after exactly one native geometry check', (t) => {
    const cache = new PathGraphicsCache()
    const path = new DrawPath('M0 0 L1e-10 0')
    let builds = 0
    const destroy = GpuGraphicsContext.prototype.destroy
    t.mock.method(GpuGraphicsContext.prototype, 'destroy', function (this: GpuGraphicsContext) {
        builds++
        destroy.call(this)
    })
    try {
        const empty = mask(cache.getStrokeMask(path, { ...style, width: 1 }))
        assert.equal(builds, 1)
        assert.equal(cache.isEmpty(empty), true)
        const release = cache.pin([empty])
        assert.ok(release)
        cache.endFrame()
        cache.beginFrame()
        assert.equal(cache.getStrokeMask(path.clone(), { ...style, width: 1 }), empty)
        assert.equal(builds, 1, 'hits and scene pins do not duplicate native tessellation')
        assert.equal(cache.stats.maskEmpty, 1)
        assert.equal(cache.stats.maskBuilt, 1)
        assert.equal(cache.stats.maskHits, 1)
        release()
        path.lineTo(10, 0)
        const populated = mask(cache.getStrokeMask(path, { ...style, width: 1 }))
        assert.equal(builds, 2)
        assert.equal(cache.isEmpty(populated), false)
        assert.notEqual(populated, empty)
        assert.equal(pathTriangles(empty).length, 0)
        assert.ok(pathTriangles(populated).length > 0)
    } finally {
        cache.destroy()
    }
})

test('nonempty tiny round-cap masks are preserved by the exact index check', () => {
    const cache = new PathGraphicsCache()
    try {
        const result = mask(
            cache.getStrokeMask(new DrawPath('M0 0L1e-10 0'), { ...style, width: 6, cap: 'round' }),
        )
        assert.ok(pathTriangles(result).length > 0)
        assert.equal(cache.isEmpty(result), false)
        assert.equal(cache.stats.maskEmpty, 0)
    } finally {
        cache.destroy()
    }
})

test('recent stroke-mask hits survive LRU eviction under the shared cache budget', () => {
    const sizing = new PathGraphicsCache()
    sizing.getStrokeMask(line(), style)
    const entryBytes = sizing.retainedBytes
    sizing.destroy()
    const cache = new PathGraphicsCache(entryBytes * 2)
    const a = line(),
        b = line(),
        c = line()
    try {
        const first = mask(cache.getStrokeMask(a, style))
        const second = mask(cache.getStrokeMask(b, style))
        cache.beginFrame()
        assert.equal(cache.getStrokeMask(a, style), first)
        cache.beginFrame()
        const third = mask(cache.getStrokeMask(c, style))
        assert.equal(second.destroyed, true)
        assert.equal(first.destroyed, false)
        assert.equal(third.destroyed, false)
        assert.equal(cache.getStrokeMask(a, style), first)
        assert.ok(cache.retainedBytes <= entryBytes * 2)
    } finally {
        cache.destroy()
    }
})

test('scene-pinned masks survive trim and released obsolete masks evict before capture', () => {
    const sizing = new PathGraphicsCache()
    sizing.getStrokeMask(line(), style)
    const budget = sizing.retainedBytes
    sizing.destroy()
    const cache = new PathGraphicsCache(budget)
    const path = line()
    let release: (() => void) | undefined
    try {
        const result = mask(cache.getStrokeMask(path, style))
        release = cache.pin([result, result])
        assert.ok(release)
        assert.equal(cache.pinnedBytes, budget)
        cache.beginFrame()
        const overflow = mask(cache.getStrokeMask(line(), style))
        assert.equal(result.destroyed, false)
        assert.equal(cache.pin([overflow]), undefined)
        cache.beginFrame()
        assert.equal(overflow.destroyed, true)
        release()
        assert.equal(cache.pinnedBytes, 0)
        const replacement = mask(cache.getStrokeMask(line(), style))
        assert.equal(
            result.destroyed,
            true,
            'released prior-frame mask must free budget immediately',
        )
        const nextRelease = cache.pin([replacement])
        assert.ok(nextRelease, 'replacement fits without a needless declined scene capture')
        cache.destroy()
        release()
        nextRelease()
        assert.equal(cache.pinnedBytes, 0)
        assert.equal(replacement.destroyed, true)
    } finally {
        cache.destroy()
        release?.()
    }
})

test('overflow masks survive presentation, expire on the next frame, and rebuild after destroy', () => {
    const cache = new PathGraphicsCache(0)
    const path = line()
    try {
        const result = mask(cache.getStrokeMask(path, style))
        assert.equal(cache.getStrokeMask(path, style), result)
        assert.equal(cache.pin([result]), undefined)
        assert.equal(cache.retainedBytes, 0)
        cache.endFrame()
        assert.equal(result.destroyed, false)
        cache.beginFrame()
        assert.equal(result.destroyed, true)
        const next = mask(cache.getStrokeMask(path, style))
        assert.notEqual(next, result)
        cache.destroy()
        assert.equal(next.destroyed, true)
        const rebuilt = mask(cache.getStrokeMask(path, style))
        assert.notEqual(rebuilt, next)
        assert.equal(rebuilt.destroyed, false)
    } finally {
        cache.destroy()
    }
})
