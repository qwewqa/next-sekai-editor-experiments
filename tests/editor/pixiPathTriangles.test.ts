import assert from 'node:assert/strict'
import test from 'node:test'
import { BatchableGraphics, BigPool, GpuGraphicsContext, GraphicsContext } from 'pixi.js'
import { DrawGradient } from '../../src/rendering/paint'
import { PathMeshGeometry } from '../../src/rendering/pathMesh'
import { isNativeStrokeStrip, pathTriangles } from '../../src/rendering/pathTriangles'
import { PaintStyles } from '../../src/rendering/pixiPaint'

test('native extraction preserves exact double vertices, indexed winding and instruction order', () => {
    const x = 100_000_000.125,
        y = -50_000_000.375
    const context = new GraphicsContext()
        .rect(x, y, 0.25, 0.5)
        .fill(0x123456)
        .rect(-2, -3, 4, 5)
        .fill(0xabcdef)
    const instructions = [...context.instructions]
    const dirty = context.dirty
    const expected = new Float64Array([
        x,
        y,
        x + 0.25,
        y,
        x,
        y + 0.5,
        x + 0.25,
        y,
        x + 0.25,
        y + 0.5,
        x,
        y + 0.5,
        -2,
        -3,
        2,
        -3,
        -2,
        2,
        2,
        -3,
        2,
        2,
        -2,
        2,
    ])
    try {
        const triangles = pathTriangles(context)
        assert.deepEqual(triangles, expected)
        assert.notEqual(Math.fround(triangles[0]!), triangles[0], 'fixture exposes Float32 loss')
        assert.deepEqual(context.instructions, instructions)
        assert.equal(context.dirty, dirty)
        assert.equal(context.destroyed, false)
        triangles[0] = 0
        assert.deepEqual(pathTriangles(context), expected, 'results cannot mutate source geometry')
    } finally {
        context.destroy()
    }
})

test('mesh extraction follows repeated and reordered indices and restores its compiled origin', () => {
    const x = 100_000_000.125,
        y = 1_000_000.375
    const source = new Float64Array([
        x,
        y,
        x + 0.25,
        y,
        x,
        y + 0.5,
        x + 0.25,
        y,
        x + 0.25,
        y + 0.5,
        x,
        y + 0.5,
    ])
    const mesh = new PathMeshGeometry(source, { color: 0 }, 64)
    mesh.indices = new Uint32Array([5, 2, 1, 5, 1, 0])
    const positions = mesh.positions.slice(),
        indices = mesh.indices.slice(),
        buffers = [...mesh.buffers]
    try {
        const expected = new Float64Array([
            x * 64,
            (y + 0.5) * 64,
            x * 64,
            (y + 0.5) * 64,
            (x + 0.25) * 64,
            y * 64,
            x * 64,
            (y + 0.5) * 64,
            (x + 0.25) * 64,
            y * 64,
            x * 64,
            y * 64,
        ])
        const triangles = pathTriangles(mesh)
        assert.deepEqual(triangles, expected)
        assert.deepEqual(mesh.positions, positions)
        assert.deepEqual(mesh.indices, indices)
        assert.equal(mesh.destroyed, false)
        assert.ok(buffers.every((buffer) => !buffer.destroyed))
        triangles.fill(0)
        assert.deepEqual(pathTriangles(mesh), expected)
    } finally {
        mesh.destroy()
    }
})

test('empty native and mesh resources produce independent empty triangle arrays', () => {
    const context = new GraphicsContext()
    const mesh = new PathMeshGeometry(new Float64Array(), { color: 0 }, 64)
    try {
        assert.deepEqual(pathTriangles(context), new Float64Array())
        assert.deepEqual(pathTriangles(mesh), new Float64Array())
        assert.notEqual(pathTriangles(context), pathTriangles(context))
        assert.equal(context.destroyed, false)
        assert.equal(mesh.destroyed, false)
    } finally {
        context.destroy()
        mesh.destroy()
    }
})

test('native extraction returns every temporary batch on success and after partial build failure', (t) => {
    const pool = BigPool.getPool(BatchableGraphics)
    const used = pool.totalUsed
    const context = new GraphicsContext().rect(0, 0, 10, 10).fill(0).rect(20, 0, 10, 10).fill(0)
    const original = GpuGraphicsContext.prototype.destroy
    const destroyedBatchCounts: number[] = []
    t.mock.method(GpuGraphicsContext.prototype, 'destroy', function (this: GpuGraphicsContext) {
        destroyedBatchCounts.push(this.batches.length)
        assert.equal(pool.totalUsed, used + this.batches.length)
        original.call(this)
        assert.equal(pool.totalUsed, used)
    })
    try {
        for (let i = 0; i < 5; i++) {
            assert.equal(pathTriangles(context).length, 24)
            assert.equal(pool.totalUsed, used)
        }
        const failure = new Error('deliberate second path build failure')
        Object.defineProperty(context.instructions[1]!.data, 'path', {
            get() {
                throw failure
            },
        })
        assert.throws(
            () => pathTriangles(context),
            (error) => error === failure,
        )
        assert.deepEqual(destroyedBatchCounts, [2, 2, 2, 2, 2, 1])
        assert.equal(pool.totalUsed, used)
        assert.equal(context.destroyed, false)
    } finally {
        context.destroy()
    }
})

test('pixel-line extraction rejects non-triangle topology and still releases temporary batches', () => {
    const context = new GraphicsContext().moveTo(0, 0).lineTo(10, 10).stroke({ pixelLine: true })
    const pool = BigPool.getPool(BatchableGraphics),
        used = pool.totalUsed
    try {
        assert.throws(() => pathTriangles(context), /triangle-list topology/)
        assert.equal(pool.totalUsed, used)
        assert.equal(context.destroyed, false)
    } finally {
        context.destroy()
    }
})

test('coordinate caps decline before Float64 allocation and return native scratch batches', (t) => {
    const context = new GraphicsContext().rect(0, 0, 10, 10).fill(0)
    const source = new Float64Array([0, 0, 10, 0, 0, 10])
    const mesh = new PathMeshGeometry(source, { color: 0 }, 1)
    const Original = Float64Array
    const allocations: number[] = []
    const pool = BigPool.getPool(BatchableGraphics),
        used = pool.totalUsed
    t.mock.method(globalThis, 'Float64Array', function (length: number) {
        allocations.push(length)
        return new Original(length)
    })
    try {
        assert.equal(pathTriangles(context, 11), undefined)
        assert.equal(pathTriangles(mesh, 5), undefined)
        assert.deepEqual(
            allocations,
            [],
            'declined extraction must not allocate its triangle array',
        )
        assert.equal(pool.totalUsed, used)
        assert.equal(pathTriangles(context, 12)?.length, 12)
        assert.equal(pathTriangles(mesh, 6)?.length, 6)
        assert.deepEqual(allocations, [12, 6])
        assert.equal(pool.totalUsed, used)
        assert.equal(context.destroyed, false)
        assert.equal(mesh.destroyed, false)
    } finally {
        context.destroy()
        mesh.destroy()
    }
})

test('pooled extraction batches clear borrowed gradient and geometry references before reuse', () => {
    const paints = new PaintStyles()
    const gradient = new DrawGradient([0, 0], [10, 10])
    gradient.addColorStop(0, '#ff0000')
    gradient.addColorStop(1, '#0000ff')
    const paint = paints.fill(gradient)
    const context = new GraphicsContext().rect(0, 0, 10, 10).fill(paint.style)
    const instruction = context.instructions[0]
    assert.ok(instruction?.action === 'fill')
    const texture = instruction.data.style.texture
    assert.ok(texture)
    const pool = BigPool.getPool(BatchableGraphics),
        used = pool.totalUsed
    try {
        const first = pathTriangles(context)
        assert.equal(pool.totalUsed, used)
        const returned = pool.get()
        assert.equal(returned.texture, null)
        assert.equal(returned.geometryData, null)
        pool.return(returned)
        assert.equal(texture.destroyed, false, 'scratch cleanup must not destroy borrowed paint')
        assert.deepEqual(
            pathTriangles(context),
            first,
            'cleared pooled batches must remain reusable',
        )
        const reused = pool.get()
        assert.equal(reused, returned)
        assert.equal(reused.texture, null)
        assert.equal(reused.geometryData, null)
        pool.return(reused)
        assert.equal(pool.totalUsed, used)
        assert.equal(texture.destroyed, false)
        assert.equal(context.destroyed, false)
    } finally {
        context.destroy()
        paints.destroy()
    }
})

test('native strip inspection releases scratch batches after success, refusal and topology rejection', () => {
    const pool = BigPool.getPool(BatchableGraphics),
        used = pool.totalUsed
    const accepted = new GraphicsContext()
        .moveTo(0, 0)
        .lineTo(10, 0)
        .stroke({ width: 2, cap: 'butt', join: 'miter' })
    const rounded = new GraphicsContext()
        .moveTo(0, 0)
        .lineTo(10, 0)
        .stroke({ width: 2, cap: 'round' })
    const pixel = new GraphicsContext().moveTo(0, 0).lineTo(10, 0).stroke({ pixelLine: true })
    try {
        const triangles = pathTriangles(accepted)
        const instructions = [...accepted.instructions],
            dirty = accepted.dirty
        for (let i = 0; i < 3; i++) {
            assert.equal(isNativeStrokeStrip(accepted, 2), true)
            assert.equal(isNativeStrokeStrip(rounded, 2), false)
            assert.equal(isNativeStrokeStrip(pixel, 2), false)
            assert.equal(pool.totalUsed, used)
        }
        assert.deepEqual(pathTriangles(accepted), triangles)
        assert.deepEqual(accepted.instructions, instructions)
        assert.equal(accepted.dirty, dirty)
        assert.equal(accepted.destroyed, false)
        const returned = pool.get()
        assert.equal(returned.texture, null)
        assert.equal(returned.geometryData, null)
        pool.return(returned)
        assert.equal(pool.totalUsed, used)
    } finally {
        accepted.destroy()
        rounded.destroy()
        pixel.destroy()
    }
})

test('native strip inspection clears borrowed paint and returns scratch batches after partial build failure', (t) => {
    const paints = new PaintStyles()
    const gradient = new DrawGradient([0, 0], [10, 0])
    gradient.addColorStop(0, '#ff0000')
    gradient.addColorStop(1, '#0000ff')
    const paint = paints.stroke(gradient, 2, 'butt', 'miter', 10)
    const context = new GraphicsContext()
        .moveTo(0, 0)
        .lineTo(10, 0)
        .stroke(paint.style)
        .moveTo(20, 0)
        .lineTo(30, 0)
        .stroke(paint.style)
    const instruction = context.instructions[0]
    assert.ok(instruction?.action === 'stroke')
    const texture = instruction.data.style.texture
    assert.ok(texture)
    const pool = BigPool.getPool(BatchableGraphics),
        used = pool.totalUsed
    const destroy = GpuGraphicsContext.prototype.destroy
    let cleared = 0
    t.mock.method(GpuGraphicsContext.prototype, 'destroy', function (this: GpuGraphicsContext) {
        cleared += this.batches.length
        assert.ok(
            this.batches.every((batch) => batch.texture === null && batch.geometryData === null),
        )
        destroy.call(this)
        assert.equal(pool.totalUsed, used)
    })
    try {
        const failure = new Error('deliberate second stroke build failure')
        Object.defineProperty(context.instructions[1]!.data, 'path', {
            get() {
                throw failure
            },
        })
        assert.throws(
            () => isNativeStrokeStrip(context, 4),
            (error) => error === failure,
        )
        assert.equal(cleared, 1)
        assert.equal(pool.totalUsed, used)
        assert.equal(texture.destroyed, false)
        assert.equal(context.destroyed, false)
    } finally {
        context.destroy()
        paints.destroy()
    }
})
