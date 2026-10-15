import assert from 'node:assert/strict'
import test from 'node:test'
import { BufferImageSource, GraphicsContext, GraphicsPath, Mesh, Rectangle, Texture } from 'pixi.js'
import { WebGLDrawContext } from '../../src/rendering/context'
import { tessellateFill } from '../../src/rendering/geometry'
import { DrawGradient } from '../../src/rendering/paint'
import { DrawPath } from '../../src/rendering/path'
import { PathGraphicsCache, resolutionScale } from '../../src/rendering/pathGraphics'
import { PathMeshGeometry } from '../../src/rendering/pathMesh'
import { PaintStyles, scalePaint } from '../../src/rendering/pixiPaint'
import { pathResourceGeometry } from './pixiGeometryTestUtils'

const triangle = () => new Float64Array([10.25, 20.5, 12.75, 20.5, 10.25, 24.5])

function compound(x = 0) {
    const path = new DrawPath()
    path.rect(x, 0, 10, 10)
    path.rect(x + 5, 5, 10, 10)
    return path
}

function meshEntryBytes() {
    const cache = new PathGraphicsCache()
    const resource = cache.get(compound(), { color: 0x123456 }, false, 'nonzero', 'solid')
    assert.ok(resource instanceof PathMeshGeometry)
    const bytes = cache.retainedBytes
    cache.destroy()
    return bytes
}

test('direct mesh preserves triangle order, winding, source data and explicit empty topology', () => {
    const triangles = new Float64Array([
        10.25, 20.5, 12.75, 20.5, 10.25, 24.5, 12.75, 20.5, 12.75, 24.5, 10.25, 24.5,
    ])
    const original = triangles.slice()
    for (const resolution of [1, 64, 256]) {
        const mesh = new PathMeshGeometry(triangles, { color: 0x123456 }, resolution)
        try {
            const geometry = pathResourceGeometry(mesh)
            assert.deepEqual(
                geometry.vertices,
                Array.from(triangles, (value) => value * resolution),
            )
            assert.deepEqual(geometry.indices, [0, 1, 2, 3, 4, 5])
            assert.ok(mesh.positions instanceof Float32Array)
            assert.ok(mesh.uvs instanceof Float32Array)
            assert.ok(mesh.indices instanceof Uint32Array)
            assert.equal(mesh.batchMode, 'batch')
            assert.equal(mesh.topology, 'triangle-list')
            assert.deepEqual(triangles, original)
        } finally {
            mesh.destroy()
        }
    }
    const empty = new PathMeshGeometry(new Float64Array(), { color: 0 }, 64)
    try {
        assert.deepEqual(pathResourceGeometry(empty), { vertices: [], indices: [], uvs: [] })
        assert.equal(empty.originX, 0)
        assert.equal(empty.originY, 0)
    } finally {
        empty.destroy()
    }
})

test('mesh local origins preserve tiny details at large chart coordinates and maximum pps', () => {
    const x = 100_000_000.125,
        y = 1_000_000.123456
    const triangles = new Float64Array([x, y, x + 0.25, y + 0.000013, x + 0.03125, y + 0.00321])
    for (const dpr of [1, 2, 3]) {
        const sx = 40 * dpr,
            sy = 10_000 * dpr
        const resolution = resolutionScale([sx, 0, 0, -sy])
        const mesh = new PathMeshGeometry(triangles, { color: 0 }, resolution)
        try {
            assert.ok(mesh.positionError <= 0.025)
            for (let i = 0; i < triangles.length; i += 2) {
                const screenX = ((mesh.positions[i]! + mesh.originX) / resolution) * sx - x * sx
                const screenY =
                    (-(mesh.positions[i + 1]! + mesh.originY) / resolution) * sy + y * sy
                const expectedX = (triangles[i]! - x) * sx
                const expectedY = -(triangles[i + 1]! - y) * sy
                assert.ok(Math.abs(screenX - expectedX) < 0.005, `DPR${dpr} x error`)
                assert.ok(Math.abs(screenY - expectedY) < 0.005, `DPR${dpr} y error`)
            }
            const unrebasedError = Math.abs(Math.fround(y * resolution) / resolution - y) * sy
            assert.ok(unrebasedError > 1, 'stress coordinates must expose early Float32 rounding')
        } finally {
            mesh.destroy()
        }
    }
})

test('large local extents retain double-coordinate Graphics when mesh rounding exceeds its error budget', () => {
    const path = new DrawPath()
    path.rect(0.1, 0.2, 1000.123456, 2.345678)
    path.rect(500.3, 0.5, 800.765432, 1.234567)
    const resolution = 65536
    const triangles = tessellateFill(path, 'nonzero', 0.1 / resolution, resolution)
    const candidate = new PathMeshGeometry(triangles, { color: 0 }, resolution)
    assert.ok(
        candidate.positionError > 0.025,
        `expected precision escape, got ${candidate.positionError}`,
    )
    candidate.destroy()
    const cache = new PathGraphicsCache()
    try {
        const result = cache.get(
            path,
            { color: 0 },
            false,
            'nonzero',
            'solid',
            undefined,
            resolution,
        )
        assert.ok(result instanceof GraphicsContext)
        const actual = pathResourceGeometry(result).vertices
        for (let i = 0; i < actual.length; i += 2) {
            assert.ok(
                Array.from({ length: triangles.length / 2 }, (_, j) => j * 2).some(
                    (j) =>
                        actual[i] === triangles[j]! * resolution &&
                        actual[i + 1] === triangles[j + 1]! * resolution,
                ),
                'native precision escape retains the original tessellator vertices',
            )
        }
        assert.ok(actual.length > 0)
    } finally {
        cache.destroy()
    }
})

test('mesh gradient UVs match native Graphics including endpoint extrapolation and resolution scaling', () => {
    const paints = new PaintStyles()
    const triangles = new Float64Array([-200, -100, 400, 200, 20, 100, 400, 200, 120, 90, 20, 100])
    try {
        for (const alphaRamp of [false, true]) {
            const gradient = new DrawGradient([10, 20], [110, 70])
            gradient.addColorStop(0, alphaRamp ? '#ff000000' : '#ff0000')
            gradient.addColorStop(1, alphaRamp ? '#ff0000' : '#0000ff')
            const paint = paints.fill(gradient)
            for (const resolution of [1, 64, 256]) {
                const scaled = scalePaint(paint.style, resolution)
                const mesh = new PathMeshGeometry(triangles, scaled, resolution)
                const path = new GraphicsPath()
                for (let i = 0; i < triangles.length; i += 6)
                    path.poly(
                        Array.from(triangles.subarray(i, i + 6), (value) => value * resolution),
                        true,
                    )
                const native = new GraphicsContext().path(path).fill(scaled)
                try {
                    const reference = pathResourceGeometry(native)
                    assert.equal(mesh.texture.width, alphaRamp ? 2 : 1024)
                    assert.equal(mesh.texture.textureMatrix.isSimple, true)
                    for (let i = 0; i < triangles.length; i += 2) {
                        const at = reference.vertices.findIndex(
                            (value, j) =>
                                !(j % 2) &&
                                value === triangles[i]! * resolution &&
                                reference.vertices[j + 1] === triangles[i + 1]! * resolution,
                        )
                        assert.ok(at >= 0)
                        assert.equal(mesh.uvs[i], Math.fround(reference.uvs[at]!))
                        assert.equal(mesh.uvs[i + 1], Math.fround(reference.uvs[at + 1]!))
                    }
                    assert.ok(Array.from(mesh.uvs).some((value, i) => !(i % 2) && value < 0))
                    assert.ok(Array.from(mesh.uvs).some((value, i) => !(i % 2) && value > 1))
                } finally {
                    native.destroy()
                    mesh.destroy()
                }
            }
        }
    } finally {
        paints.destroy()
    }
})

test('mesh paint retains tint and style alpha while node destruction leaves shared geometry alive', () => {
    const paints = new PaintStyles()
    const paint = paints.fill('#12345680')
    const mesh = new PathMeshGeometry(triangle(), paint.style, 64)
    const buffers = [...mesh.buffers]
    const counts = buffers.map(() => 0)
    let geometryDestructions = 0
    mesh.on('destroy', () => geometryDestructions++)
    buffers.forEach((buffer, i) =>
        buffer.on('destroy', () => {
            counts[i] = (counts[i] ?? 0) + 1
        }),
    )
    const first = new Mesh({
        geometry: mesh,
        texture: mesh.texture,
        tint: mesh.tint,
        alpha: mesh.styleAlpha * 0.35,
    })
    const second = new Mesh({ geometry: mesh, texture: mesh.texture })
    try {
        assert.equal(mesh.texture, Texture.WHITE)
        assert.equal(mesh.tint, 0x123456)
        assert.equal(mesh.styleAlpha, 128 / 255)
        assert.equal(first.alpha, (128 / 255) * 0.35)
        first.destroy()
        assert.equal(mesh.destroyed, false)
        assert.equal(second.geometry, mesh)
        assert.ok(buffers.every((buffer) => !buffer.destroyed))
        second.destroy()
        mesh.destroy()
        mesh.destroy()
        assert.equal(geometryDestructions, 1)
        assert.deepEqual(counts, [1, 1, 1])
        assert.ok(buffers.every((buffer) => buffer.destroyed))
        assert.equal(Texture.WHITE.destroyed, false)
    } finally {
        first.destroy()
        second.destroy()
        mesh.destroy()
        paints.destroy()
    }
})

test('public fill composes mesh origin, reflected affine transform, style alpha and erase blending', () => {
    const cache = new PathGraphicsCache(),
        paints = new PaintStyles()
    const matrix = [-2, 0.5, 0.25, 3, 500, -20] as const
    const state = {
        matrix: [...matrix],
        fillStyle: '#12345680',
        globalAlpha: 0.35,
        globalCompositeOperation: 'destination-out',
        dash: [],
        lineDashOffset: 0,
    }
    const before = structuredClone(state)
    const nodes: Mesh<PathMeshGeometry>[] = []
    const context = Object.assign(Object.create(WebGLDrawContext.prototype) as object, {
        state,
        ensure: () => true,
        mutate: () => true,
        paths: cache,
        paints,
        meshesByGeometry: new Map(),
        pathMeshPool: [],
        pooledPathMeshes: 0,
        parent: () => ({ addChild: (node: Mesh<PathMeshGeometry>) => nodes.push(node) }),
    }) as unknown as WebGLDrawContext
    try {
        context.fill(compound(20))
        const node = nodes[0]!
        assert.ok(node instanceof Mesh && node.geometry instanceof PathMeshGeometry)
        assert.equal(node.tint, 0x123456)
        assert.equal(node.alpha, (128 / 255) * 0.35)
        assert.equal(node.blendMode, 'erase')
        node.updateLocalTransform()
        const mesh = node.geometry,
            resolution = resolutionScale(matrix)
        for (let i = 0; i < mesh.positions.length; i += 2) {
            const point = node.localTransform.apply({
                x: mesh.positions[i]!,
                y: mesh.positions[i + 1]!,
            })
            const worldX = (mesh.positions[i]! + mesh.originX) / resolution
            const worldY = (mesh.positions[i + 1]! + mesh.originY) / resolution
            assert.ok(
                Math.abs(point.x - (matrix[0] * worldX + matrix[2] * worldY + matrix[4])) < 1e-8,
            )
            assert.ok(
                Math.abs(point.y - (matrix[1] * worldX + matrix[3] * worldY + matrix[5])) < 1e-8,
            )
        }
        assert.deepEqual(state, before)
    } finally {
        for (const node of nodes) node.destroy()
        cache.destroy()
        paints.destroy()
    }
})

test('unsupported framed paints stay on native Graphics instead of applying Mesh texture mapping twice', () => {
    const texture = new Texture({
        source: new BufferImageSource({ resource: new Uint8Array(16 * 4), width: 4, height: 4 }),
        frame: new Rectangle(1, 1, 2, 2),
    })
    const style = { texture, textureSpace: 'global' as const }
    const cache = new PathGraphicsCache()
    try {
        assert.equal(PathMeshGeometry.supports(style), false)
        assert.throws(() => new PathMeshGeometry(triangle(), style, 1), /Unsupported/)
        const resource = cache.get(compound(), style, false, 'nonzero', 'framed')
        assert.ok(resource instanceof GraphicsContext)
        assert.ok(pathResourceGeometry(resource).vertices.length > 0)
    } finally {
        cache.destroy()
        texture.destroy(true)
    }
})

test('releasing an obsolete mesh scene pin permits replacement capture in the same frame', () => {
    const budget = meshEntryBytes()
    const cache = new PathGraphicsCache(budget)
    const first = compound(),
        second = compound(20)
    try {
        cache.beginFrame()
        const a = cache.get(first, { color: 0x123456 }, false, 'nonzero', 'solid')
        assert.ok(a instanceof PathMeshGeometry)
        const releaseA = cache.pin([a])
        assert.ok(releaseA)
        cache.endFrame()
        cache.beginFrame()
        releaseA()
        // No beginFrame here: release itself must make an old pinned entry evictable.
        const b = cache.get(second, { color: 0x123456 }, false, 'nonzero', 'solid')
        assert.ok(b instanceof PathMeshGeometry)
        assert.equal(a.destroyed, true)
        const releaseB = cache.pin([b])
        assert.ok(releaseB, 'replacement must be resident, not frame overflow')
        assert.ok(cache.retainedBytes <= budget)
        cache.endFrame()
        cache.beginFrame()
        assert.equal(b.destroyed, false)
        releaseB()
        cache.get(first, { color: 0x123456 }, false, 'nonzero', 'solid')
        assert.equal(b.destroyed, true)
        releaseA()
        releaseB()
        assert.equal(cache.pinnedBytes, 0)
    } finally {
        cache.destroy()
    }
})

test('mesh overflow owns its buffers through presentation and releases them at the next frame', () => {
    const cache = new PathGraphicsCache(meshEntryBytes() - 1)
    try {
        cache.beginFrame()
        const path = compound()
        const mesh = cache.get(path, { color: 0x123456 }, false, 'nonzero', 'solid')
        assert.ok(mesh instanceof PathMeshGeometry)
        const buffers = [...mesh.buffers]
        assert.equal(cache.get(path, { color: 0x123456 }, false, 'nonzero', 'solid'), mesh)
        assert.equal(cache.pin([mesh]), undefined)
        cache.endFrame()
        assert.equal(mesh.destroyed, false)
        assert.ok(buffers.every((buffer) => !buffer.destroyed))
        assert.equal(cache.retainedBytes, 0)
        cache.beginFrame()
        assert.equal(mesh.destroyed, true)
        assert.ok(buffers.every((buffer) => buffer.destroyed))
    } finally {
        cache.destroy()
    }
})

test('shared gradient ramps outlive pinned mesh resources and release after their last owner', () => {
    const cache = new PathGraphicsCache(),
        paints = new PaintStyles()
    const gradient = new DrawGradient([0, 0], [10, 10])
    gradient.addColorStop(0, '#ff0000')
    gradient.addColorStop(1, '#0000ff')
    const paint = paints.fill(gradient)
    const a = cache.get(compound(), paint.style, false, 'nonzero', paint.key)
    const b = cache.get(compound(20), paint.style, false, 'nonzero', paint.key)
    assert.ok(a instanceof PathMeshGeometry && b instanceof PathMeshGeometry)
    const texture = a.texture
    assert.equal(b.texture, texture)
    const release = cache.pin([a, b])
    assert.ok(release)
    let destructions = 0
    texture.on('destroy', () => destructions++)
    const pressure = (from: number) => {
        for (let i = from; i < from + 25; i++) {
            const other = new DrawGradient([0, 0], [1, 1])
            other.addColorStop(0, `#${(0x010000 + i).toString(16).padStart(6, '0')}`)
            other.addColorStop(1, '#ffffff')
            paints.fill(other)
        }
    }
    try {
        pressure(1)
        assert.equal(texture.destroyed, false)
        assert.equal(destructions, 0)
        cache.destroy()
        release()
        release()
        pressure(30)
        assert.equal(texture.destroyed, true)
        assert.equal(destructions, 1)
    } finally {
        cache.destroy()
        paints.destroy()
    }
})
