import assert from 'node:assert/strict'
import test from 'node:test'
import { GpuGraphicsContext, GraphicsContext, type Polygon, type StrokeStyle } from 'pixi.js'
import {
    certifyNativeStrokeStrip,
    maxStrokeStripPoints,
} from '../../src/rendering/nativeStrokeStrip'
import { DrawGradient } from '../../src/rendering/paint'
import { DrawPath } from '../../src/rendering/path'
import { PathGraphicsCache } from '../../src/rendering/pathGraphics'
import { PathMeshGeometry } from '../../src/rendering/pathMesh'
import { isNativeStrokeStrip, pathTriangles } from '../../src/rendering/pathTriangles'
import { PaintStyles } from '../../src/rendering/pixiPaint'
import { pathResourceGeometry } from './pixiGeometryTestUtils'

type Point = [number, number]
type Pair = [Point, Point]
const mesh = (pairs: Pair[]) => {
    const vertices = pairs.flat(2)
    const indices: number[] = []
    for (let i = 0; i < vertices.length / 2 - 2; i++) indices.push(i, i + 1, i + 2)
    return { vertices, indices, count: pairs.length }
}
const certify = ({ vertices, indices, count }: ReturnType<typeof mesh>) =>
    certifyNativeStrokeStrip(vertices, indices, count)
const straight = (count: number) =>
    mesh(
        Array.from({ length: count }, (_, i) => [
            [i * 3, 0],
            [i * 3, 2],
        ]),
    )

test('ordinary straight and curved strips certify under reflection, anisotropic scale and far translation', () => {
    const cases: Pair[][] = [
        [
            [
                [0, 0],
                [0, 2],
            ],
            [
                [3, 0],
                [3, 2],
            ],
            [
                [6, 0],
                [6, 2],
            ],
        ],
        [
            [
                [0, 0],
                [0, 2],
            ],
            [
                [3, 1],
                [2, 3],
            ],
            [
                [5, 4],
                [3, 5],
            ],
        ],
    ]
    for (const pairs of cases)
        for (const sx of [-4, 1])
            for (const sy of [0.5, 2])
                for (const offset of [0, 2 ** 35]) {
                    assert.equal(
                        certify(
                            mesh(
                                pairs.map(
                                    (pair) =>
                                        pair.map(([x, y]) => [
                                            sx * x + offset,
                                            sy * y - offset,
                                        ]) as Pair,
                                ),
                            ),
                        ),
                        true,
                    )
                }
})

test('local folds and a collinear boundary reversal cannot certify', () => {
    assert.equal(
        certify(
            mesh([
                [
                    [0, 0],
                    [0, 2],
                ],
                [
                    [3, 0],
                    [3, 2],
                ],
                [
                    [1, 0],
                    [1, 2],
                ],
            ]),
        ),
        false,
    )
    assert.equal(
        certify(
            mesh([
                [
                    [0, 0],
                    [0, 2],
                ],
                [
                    [3, 0],
                    [3, 2],
                ],
                [
                    [2, 0],
                    [6, 2],
                ],
            ]),
        ),
        false,
    )
})

test('globally overlapping loops and touching closures refuse despite locally consistent strip triangles', () => {
    const arc = (count: number): Pair[] =>
        Array.from({ length: count + 1 }, (_, i) => {
            const angle = (i * Math.PI) / 8
            return [
                [Math.cos(angle) * 4, Math.sin(angle) * 4],
                [Math.cos(angle) * 6, Math.sin(angle) * 6],
            ]
        })
    assert.equal(certify(mesh(arc(24))), false)
    const closed = arc(16)
    closed[closed.length - 1] = closed[0]!.map((point) => [...point]) as Pair
    assert.equal(certify(mesh(closed)), false)
    assert.equal(certify(mesh(arc(12))), true, 'the open nonoverlapping arc remains admissible')
})

test('degenerate, tiny, nonfinite and cancellation-uncertain triangles conservatively refuse', () => {
    for (const width of [0, 1e-10])
        assert.equal(
            certify(
                mesh([
                    [
                        [0, 0],
                        [0, width],
                    ],
                    [
                        [1, 0],
                        [1, width],
                    ],
                ]),
            ),
            false,
        )
    const valid = straight(3)
    for (const value of [NaN, Infinity, -Infinity]) {
        const vertices = [...valid.vertices]
        vertices[0] = value
        assert.equal(certify({ ...valid, vertices }), false)
    }
    // Large cancelling determinant products make this positive area unreliable.
    assert.equal(
        certify(
            mesh([
                [
                    [0, 0],
                    [1e12, 1e12],
                ],
                [
                    [2e12, 2e12 + 0.001],
                    [3e12, 3e12 + 0.001],
                ],
            ]),
        ),
        false,
    )
})

test('only complete consecutive strip indices and the declared point count are accepted', () => {
    const valid = straight(3)
    for (const count of [0, 1, 2, 4, 2.5, NaN, Infinity])
        assert.equal(certify({ ...valid, count }), false)
    for (const indices of [
        valid.indices.slice(3),
        [...valid.indices, 0, 1, 2],
        [...valid.indices.slice(3), ...valid.indices.slice(0, 3)],
        valid.indices.map((index, i) => (i === 0 ? -1 : index)),
        valid.indices.map((index, i) => (i === 0 ? 0.5 : index)),
        valid.indices.map((index, i) => (i === 0 ? NaN : index)),
    ])
        assert.equal(certify({ ...valid, indices }), false)
    assert.equal(certify({ ...valid, vertices: [...valid.vertices, 99, 99] }), false)
    assert.equal(certify({ ...valid, vertices: valid.vertices.slice(0, -1) }), false)
})

test('all four actual native-opacity regression geometries refuse the certificate', () => {
    const fixtures = [
        {
            contours: [
                [-10, -10, 0, 0, -10, 10],
                [2.3, -3, 2.3, 3],
            ],
            cap: 'butt',
        },
        {
            contours: [
                [-10, -10, 0, 0],
                [2.3, -3, 2.3, 3],
            ],
            cap: 'square',
        },
        { contours: [[0, 0, 0, 3, 1, 3, 1, 0]], cap: 'butt' },
        {
            contours: [[-10, -10, 0, 0, -10, 10, -10, 20, 10, 20, 10, -20, 2.3, -20, 2.3, 3]],
            cap: 'butt',
        },
    ] as const
    for (const fixture of fixtures) {
        const context = new GraphicsContext()
        for (const contour of fixture.contours) context.poly([...contour], false)
        context.stroke({
            color: 0xffffff,
            width: 2,
            cap: fixture.cap,
            join: 'miter',
            miterLimit: 10,
        })
        try {
            const { vertices, indices } = pathResourceGeometry(context)
            assert.equal(
                certifyNativeStrokeStrip(
                    vertices,
                    indices,
                    fixture.contours.reduce((sum, points) => sum + points.length / 2, 0),
                ),
                false,
            )
        } finally {
            context.destroy()
        }
    }
})

test('typed and frozen array-like inputs stay byte-identical and decisions reflect later caller mutations', () => {
    const valid = straight(3)
    const vertices = new Float64Array(valid.vertices),
        indices = new Uint32Array(valid.indices)
    vertices[0] = -0
    const beforeVertices = Buffer.from(vertices.buffer).toString('hex')
    const beforeIndices = Buffer.from(indices.buffer).toString('hex')
    for (let i = 0; i < 3; i++)
        assert.equal(certifyNativeStrokeStrip(vertices, indices, valid.count), true)
    assert.equal(Buffer.from(vertices.buffer).toString('hex'), beforeVertices)
    assert.equal(Buffer.from(indices.buffer).toString('hex'), beforeIndices)
    assert.equal(
        certifyNativeStrokeStrip(
            Object.freeze({ ...valid.vertices, length: valid.vertices.length }),
            Object.freeze({ ...valid.indices, length: valid.indices.length }),
            valid.count,
        ),
        true,
    )
    indices[0] = 1
    assert.equal(certifyNativeStrokeStrip(vertices, indices, valid.count), false)
    indices[0] = 0
    vertices[1] = NaN
    assert.equal(certifyNativeStrokeStrip(vertices, indices, valid.count), false)
    vertices[1] = valid.vertices[1]!
    assert.equal(certifyNativeStrokeStrip(vertices, indices, valid.count), true)
})

test('point and sweep-work caps bound valid geometry without relaxing the overlap proof', () => {
    assert.equal(maxStrokeStripPoints, 512)
    const rotate = (strip: ReturnType<typeof mesh>) => ({
        ...strip,
        vertices: strip.vertices.map((_, index) =>
            index % 2 ? strip.vertices[index - 1]! : -strip.vertices[index + 1]!,
        ),
    })
    assert.equal(certify(straight(100)), true)
    assert.equal(
        certify(rotate(straight(512))),
        true,
        'exact point limit is permitted when the sweep stays bounded',
    )
    assert.equal(
        certify(straight(512)),
        false,
        'horizontal collinear rails exceed the fixed active-pair budget',
    )
    assert.equal(certify(rotate(straight(513))), false)
    const unreadable = {
        length: 513 * 4,
        get 0(): number {
            throw new Error('point cap must precede vertex reads')
        },
    }
    assert.equal(certifyNativeStrokeStrip(unreadable, { length: (513 * 2 - 2) * 3 }, 513), false)
})

// The measured event connector family, translated near the origin. An SVG
// equivalent bypasses the new command gate and preserves the old union oracle.
const curve = (two = false) => {
    const result = new DrawPath()
    result.moveTo(0, 0)
    result.quadraticCurveTo(0.5, 0.4, 0.5, 0.8)
    if (two) result.quadraticCurveTo(0.5, 1.2, 1, 1.6)
    return result
}
const stroke: StrokeStyle = {
    color: 0x123456,
    alpha: 0.37,
    width: 2 / 13,
    cap: 'butt',
    join: 'miter',
    miterLimit: 10,
}
const native = (resource: ReturnType<PathGraphicsCache['get']>) => {
    assert.ok(resource instanceof GraphicsContext)
    return resource
}

test('one and two explicit quadratics gain certified native geometry while the old union oracle stays available', () => {
    const cache = new PathGraphicsCache()
    try {
        for (const two of [false, true]) {
            const path = curve(two)
            const result = native(cache.get(path, stroke, true, 'nonzero', 'solid', undefined, 32))
            const old = cache.get(
                new DrawPath(`M0 0Q.5 .4 .5 .8${two ? 'Q.5 1.2 1 1.6' : ''}`),
                stroke,
                true,
                'nonzero',
                'solid',
                undefined,
                32,
            )
            assert.ok(
                old instanceof PathMeshGeometry,
                'fixture must have required the conservative union route',
            )
            const instruction = result.instructions[0]
            assert.ok(instruction?.action === 'stroke')
            const shape = instruction.data.path.shapePath.shapePrimitives[0]?.shape
            assert.ok(shape?.type === 'polygon')
            assert.equal(isNativeStrokeStrip(result, (shape as Polygon).points.length / 2), true)
            assert.equal(instruction.data.style.color, 0x123456)
            assert.equal(instruction.data.style.alpha, 0.37)
            assert.ok(pathTriangles(result).length > 0)
            assert.equal(
                cache.get(path.clone(), stroke, true, 'nonzero', 'solid', undefined, 32),
                result,
            )
        }
        assert.equal(cache.stats.native, 2)
        assert.equal(cache.stats.fallback, 2)
    } finally {
        cache.destroy()
    }
})

test('gradient, dash, cap, join, pixel-line and compound variants never enter the strip proof', (t) => {
    const cache = new PathGraphicsCache(),
        paints = new PaintStyles()
    const gradient = new DrawGradient([0, 0], [1, 2])
    gradient.addColorStop(0, '#ff0000')
    gradient.addColorStop(1, '#0000ff')
    const gradientPaint = paints.stroke(gradient, stroke.width!, 'butt', 'miter', 10)
    let inspected = 0
    const destroy = GpuGraphicsContext.prototype.destroy
    t.mock.method(GpuGraphicsContext.prototype, 'destroy', function (this: GpuGraphicsContext) {
        inspected++
        destroy.call(this)
    })
    try {
        cache.get(curve(), stroke, true, 'nonzero', 'eligible', undefined, 32)
        assert.equal(inspected, 1)
        for (const [key, paint, extras] of [
            ['gradient', gradientPaint.style, undefined],
            ['dash', stroke, { dash: [0.1, 0.1], dashOffset: 0 }],
            ['round', { ...stroke, cap: 'round' }, undefined],
            ['bevel', { ...stroke, join: 'bevel' }, undefined],
            ['pixel', { ...stroke, pixelLine: true }, undefined],
            ['alignment', { ...stroke, alignment: 0 }, undefined],
        ] as const)
            cache.get(curve(), paint, true, 'nonzero', key, extras, 32)
        const compound = curve()
        compound.moveTo(0, 0.2)
        compound.quadraticCurveTo(0.5, 0.6, 0.5, 1)
        cache.get(compound, stroke, true, 'nonzero', 'compound', undefined, 32)
        assert.equal(
            inspected,
            1,
            'excluded paths/styles must not speculatively build a native strip',
        )
    } finally {
        cache.destroy()
        paints.destroy()
    }
})

test('certified cache entries isolate appends and resolution variants while preserving snapshot hits', () => {
    const cache = new PathGraphicsCache(),
        path = curve()
    try {
        const first = native(cache.get(path, stroke, true, 'nonzero', 'solid', undefined, 32))
        const commands = path.commands
        path.quadraticCurveTo(0.5, 1.2, 1, 1.6)
        assert.equal(path.commands, commands)
        const second = native(cache.get(path, stroke, true, 'nonzero', 'solid', undefined, 32))
        assert.notEqual(second, first)
        const snapshot = path.clone()
        const scaled = native(cache.get(path, stroke, true, 'nonzero', 'solid', undefined, 64))
        assert.notEqual(scaled, second)
        assert.equal(cache.get(snapshot, stroke, true, 'nonzero', 'solid', undefined, 32), second)
        path.lineTo(3, 2)
        assert.notEqual(path.commands, commands)
        assert.notEqual(cache.get(path, stroke, true, 'nonzero', 'solid', undefined, 32), second)
        assert.equal(cache.get(snapshot, stroke, true, 'nonzero', 'solid', undefined, 64), scaled)
    } finally {
        cache.destroy()
    }
})

test('a retracing quadratic destroys its refused native candidate and retains coverage union', (t) => {
    const cache = new PathGraphicsCache()
    const path = new DrawPath()
    path.moveTo(0, 0)
    path.quadraticCurveTo(10, 0, 0, 0)
    const rejected: GraphicsContext[] = []
    const destroy = GraphicsContext.prototype.destroy
    t.mock.method(GraphicsContext.prototype, 'destroy', function (this: GraphicsContext) {
        rejected.push(this)
        destroy.call(this)
    })
    try {
        const result = cache.get(path, stroke, true, 'nonzero', 'retracing', undefined, 32)
        assert.ok(result instanceof PathMeshGeometry)
        assert.equal(rejected.length, 1)
        assert.equal(rejected[0]?.destroyed, true)
        assert.equal(result.destroyed, false)
        assert.equal(result.styleAlpha, stroke.alpha)
        assert.ok(pathTriangles(result).length > 0)
        assert.equal(cache.stats.native, 0)
        assert.equal(cache.stats.fallback, 1)
    } finally {
        cache.destroy()
    }
})

test('certified native entries retain ordinary pin, eviction and overflow presentation lifetimes', () => {
    const sizing = new PathGraphicsCache()
    sizing.get(curve(), stroke, true, 'nonzero', 'solid', undefined, 32)
    const budget = sizing.retainedBytes
    sizing.destroy()
    const cache = new PathGraphicsCache(budget)
    const get = () => native(cache.get(curve(), stroke, true, 'nonzero', 'solid', undefined, 32))
    try {
        const first = get(),
            release = cache.pin([first])
        assert.ok(release)
        cache.beginFrame()
        const overflow = get()
        assert.equal(cache.pin([overflow]), undefined)
        cache.endFrame()
        assert.equal(overflow.destroyed, false)
        assert.equal(first.destroyed, false)
        cache.beginFrame()
        assert.equal(overflow.destroyed, true)
        release()
        const next = get()
        assert.equal(first.destroyed, true)
        assert.equal(next.destroyed, false)
        assert.ok(cache.retainedBytes <= budget)
        assert.equal(cache.pinnedBytes, 0)
    } finally {
        cache.destroy()
    }
})
