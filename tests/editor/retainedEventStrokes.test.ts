import assert from 'node:assert/strict'
import test from 'node:test'
import { Container, Graphics, type GraphicsContext } from 'pixi.js'
import { createNameLayer } from '../../src/editor/canvas/names'
import type { DrawStep } from '../../src/editor/canvas/ordering'
import type { DrawSection } from '../../src/editor/canvas/sections'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import { VectorRanges } from '../../src/editor/canvas/vectorRanges'
import { WebGLDrawContext, type RetainedVectors } from '../../src/rendering/context'
import { prepareEventStroke, type PreparedEventStroke } from '../../src/rendering/eventStrokeMesh'
import type { Matrix } from '../../src/rendering/matrix'
import { DrawPath } from '../../src/rendering/path'
import type { State } from '../../src/state'
import type { Entity } from '../../src/state/entities'
import { calculateBpms } from '../../src/state/integrals/bpms'

const prepared = (offset = 0, timeError = 0): PreparedEventStroke => {
    const path = new DrawPath()
    path.moveTo(-1, 10 + offset)
    path.lineTo(2, 12 + offset)
    const stroke = prepareEventStroke(path, 2.5)
    assert.ok(stroke)
    // A conservative nonzero error bound exercises later UPS certification refusal.
    return { ...stroke, timeError }
}

function fixture(matrix: Matrix = [2.5, 0, 0, -2.5, 11.125, 47.375]) {
    const scene = new Container()
    const state = {
        matrix,
        clips: [] as unknown[],
        globalAlpha: 0.625,
        globalCompositeOperation: 'source-over',
        strokeStyle: '#12345680',
        lineWidth: 0.125,
        lineCap: 'butt',
        lineJoin: 'miter',
        miterLimit: 10,
        dash: [] as number[],
    }
    const calls = { pins: 0, unpins: 0, flushes: 0, declinePin: false }
    const graphics: Graphics[] = []
    const internals = {
        canvas: { width: 1000, height: 900 },
        scene,
        state,
        states: [state],
        path: new DrawPath(),
        pathMatrix: [...matrix],
        activeClip: undefined as unknown,
        activeParent: undefined as Container | undefined,
        layers: [] as unknown[],
        containerPool: [] as Container[],
        graphicPool: [] as Graphics[],
        graphicsByContext: new Map<GraphicsContext, Graphics[]>(),
        pooledGraphics: 0,
        retained: new Map<Container, RetainedVectors>(),
        retainedNoteBodies: new Map(),
        disposed: false,
        resources: { resourceOwner: {}, lost: false },
        eventStrokeStats: {
            created: 0,
            updated: 0,
            declined: 0,
            released: 0,
            bytes: 0,
            peakBytes: 0,
        },
        paths: {
            pin: () => {
                calls.pins++
                return calls.declinePin ? undefined : () => calls.unpins++
            },
        },
        ensure: () => !internals.disposed && !internals.resources.lost,
        mutate: () => internals.ensure(),
        parent: (): Container => read().scene,
        getTransform: () => {
            const [a, b, c, d, e, f] = read().state.matrix
            return { a, b, c, d, e, f }
        },
        flush: () => {
            calls.flushes++
            // Model presentation detaching retained groups, including one-shot disposal.
            for (const child of scene.removeChildren()) {
                const range = internals.retained.get(child)
                if (range && !range.reusable) context.releaseVectors(range)
            }
        },
    }
    const context = Object.assign(
        Object.create(WebGLDrawContext.prototype) as object,
        internals,
    ) as unknown as WebGLDrawContext
    const read = () => context as unknown as typeof internals
    const paintFallback = () => {
        const graphic = new Graphics().rect(0, 0, 1, 1).fill(0x123456)
        read().scene.addChild(graphic)
        graphics.push(graphic)
    }
    const capture = (strokes: readonly PreparedEventStroke[], originTime = 8, ups = 2) => {
        const range = context.captureEventStrokeVectors(
            () => {
                for (const stroke of strokes) assert.ok(context.strokeEventPath(stroke, ups))
            },
            originTime,
            ups,
        )
        assert.ok(range?.eventStrokes)
        return range
    }
    const cleanup = () => {
        for (const range of [...internals.retained.values()]) {
            range.released = false
            context.releaseVectors(range)
        }
        for (const graphic of graphics) if (!graphic.destroyed) graphic.destroy({ context: true })
        for (const group of internals.containerPool) if (!group.destroyed) group.destroy()
        scene.destroy({ children: true })
    }
    return { context, state, calls, scene, read, capture, paintFallback, cleanup }
}

const snapshot = (range: RetainedVectors) => ({
    matrix: [...range.matrix],
    meshes: range.eventStrokes!.map(({ mesh, width }) => ({
        width,
        x: mesh.x,
        y: mesh.y,
        alpha: mesh.alpha,
        tint: mesh.tint,
        positions: [...mesh.geometry.positions],
        indices: [...mesh.geometry.indices],
        uvs: [...mesh.geometry.uvs],
    })),
})

test('owned event strokes update in place, match fresh captures, and release exactly once', () => {
    for (const matrix of [
        [2.5, 0, 0, -2.5, 11.125, 47.375],
        [-2.5, 0, 0, 2.5, -11.125, 47.375],
    ] satisfies Matrix[]) {
        const f = fixture(matrix)
        try {
            const strokes = [prepared(), prepared(4)]
            const beforePoints = strokes.map((stroke) => [...stroke.points])
            const range = f.capture(strokes)
            const meshes = range.eventStrokes!.map(({ mesh }) => mesh)
            const geometries = meshes.map((mesh) => mesh.geometry)
            const buffers = meshes.map((mesh) => mesh.geometry.getBuffer('aPosition'))
            assert.equal(range.graphics, 2)
            assert.equal(range.reusable, true)
            assert.equal(range.group.parent, null)
            assert.equal(f.scene.children.length, 0)
            assert.equal(
                f.context.eventStrokeStats.bytes,
                meshes.reduce((n, mesh) => n + mesh.geometry.byteSize, 0),
            )
            assert.equal(meshes[0]!.alpha, (0.625 * 128) / 255)
            assert.equal(meshes[0]!.tint, 0x123456)

            assert.ok(f.context.updateEventStrokeVectors(range, 17.125, -3.5))
            const fresh = f.capture(strokes, 17.125, -3.5)
            const actual = snapshot(range)
            const expected = snapshot(fresh)
            // captureVectors evaluates -(a * 0 + c * originY). Reflection and
            // a changed UPS sign can only change this zero's sign, not pixels.
            assert.ok(actual.matrix[4] === expected.matrix[4])
            actual.matrix[4] = expected.matrix[4]!
            assert.deepEqual(actual, expected)
            range.eventStrokes!.forEach(({ mesh }, index) => {
                assert.equal(mesh, meshes[index])
                assert.equal(mesh.geometry.getBuffer('aPosition'), buffers[index])
            })
            assert.deepEqual(
                strokes.map((stroke) => [...stroke.points]),
                beforePoints,
            )
            assert.equal(f.context.eventStrokeStats.updated, 2)

            assert.ok(f.context.drawVectors(range))
            f.context.releaseVectors(range)
            f.context.releaseVectors(range)
            assert.equal(f.calls.flushes, 1)
            assert.ok(meshes.every((mesh) => mesh.destroyed))
            assert.ok(geometries.every((geometry) => geometry.destroyed))
            f.context.releaseVectors(fresh)
            assert.equal(f.calls.unpins, 2)
            assert.equal(f.context.eventStrokeStats.released, 4)
            assert.equal(f.context.eventStrokeStats.bytes, 0)
        } finally {
            f.cleanup()
        }
    }
})

test('late certification refusal publishes no partial geometry, position, matrix, or counters', () => {
    const f = fixture()
    try {
        const range = f.capture([prepared(), prepared(4, 0.01)])
        const before = snapshot(range)
        assert.equal(f.context.updateEventStrokeVectors(range, 9, 8), false)
        assert.deepEqual(snapshot(range), before)
        assert.equal(f.context.eventStrokeStats.updated, 0)
        assert.equal(f.calls.flushes, 0)
        assert.ok(f.context.updateEventStrokeVectors(range, 9, 3))
        const fresh = f.capture([prepared(), prepared(4, 0.01)], 9, 3)
        assert.deepEqual(snapshot(range), snapshot(fresh))
    } finally {
        f.cleanup()
    }
})

test('queued, foreign, lost, released, and incompatible ranges refuse updates without effects', () => {
    type Fixture = ReturnType<typeof fixture>
    const guards: [string, (f: Fixture, range: RetainedVectors) => void][] = [
        [
            'queued',
            (f, range) => {
                assert.ok(f.context.drawVectors(range))
            },
        ],
        [
            'foreign owner',
            (f) => {
                f.read().resources.resourceOwner = {}
            },
        ],
        [
            'context loss',
            (f) => {
                f.read().resources.lost = true
            },
        ],
        [
            'released',
            (_f, range) => {
                range.released = true
            },
        ],
        [
            'replaced ownership',
            (f, range) => {
                f.read().retained.set(range.group, { ...range })
            },
        ],
        [
            'open layer',
            (f) => {
                f.read().layers.push({})
            },
        ],
        [
            'clip',
            (f) => {
                f.state.clips.push({})
            },
        ],
        [
            'changed linear transform',
            (f) => {
                f.state.matrix[0] = 3
            },
        ],
    ]
    for (const [name, reject] of guards) {
        const f = fixture()
        try {
            const range = f.capture([prepared()])
            reject(f, range)
            const before = snapshot(range)
            assert.equal(f.context.updateEventStrokeVectors(range, 9, 3), false, name)
            assert.deepEqual(snapshot(range), before, name)
            assert.equal(f.context.eventStrokeStats.updated, 0, name)
            assert.equal(f.calls.flushes, 0, name)
            range.released = false
            f.read().retained.set(range.group, range)
            f.context.releaseVectors(range)
            assert.equal(f.context.eventStrokeStats.bytes, 0, name)
        } finally {
            f.cleanup()
        }
    }
})

test('capture refusal and exceptions restore capture state and release partial owned meshes', () => {
    const f = fixture()
    try {
        assert.equal(f.context.strokeEventPath(prepared(), 2), false)
        assert.equal(
            f.context.captureEventStrokeVectors(() => assert.fail(), Infinity, 2),
            undefined,
        )
        const error = new Error('draw failed')
        assert.throws(
            () =>
                f.context.captureEventStrokeVectors(
                    () => {
                        assert.equal(f.context.isCapturingEventStrokes, true)
                        assert.equal(
                            f.context.captureEventStrokeVectors(() => assert.fail(), 0, 2),
                            undefined,
                        )
                        assert.ok(f.context.strokeEventPath(prepared(), 2))
                        throw error
                    },
                    8,
                    2,
                ),
            error,
        )
        assert.equal(f.context.isCapturingEventStrokes, false)
        assert.equal(f.context.eventStrokeStats.bytes, 0)
        assert.equal(f.context.eventStrokeStats.released, 1)
        assert.equal(f.read().retained.size, 0)
        assert.equal(f.read().scene, f.scene)
        assert.equal(f.read().state, f.state)
        const mixed = f.context.captureEventStrokeVectors(
            () => {
                assert.ok(f.context.strokeEventPath(prepared(), 2))
                assert.equal(f.context.strokeEventPath(undefined, 2), false)
                f.paintFallback()
            },
            8,
            2,
        )
        assert.ok(mixed)
        assert.equal(mixed.eventStrokes, undefined)
        assert.equal(mixed.graphics, 2)
        assert.equal(mixed.reusable, true, 'partial support may still use ordinary pan replay')
        f.context.releaseVectors(mixed)
        assert.equal(f.context.eventStrokeStats.bytes, 0)
        f.context.releaseVectors(f.capture([prepared()]))
    } finally {
        f.cleanup()
    }
})

test('the owned-byte ceiling and pin refusal keep one-shot captures releasable', () => {
    const f = fixture()
    try {
        const sample = f.capture([prepared()])
        const bytes = sample.eventStrokes![0]!.mesh.geometry.byteSize
        f.context.releaseVectors(sample)
        // Exercise accounting admission exactly at the cap without allocating 32 MiB.
        const existingBytes = 32 * 1024 * 1024 - bytes
        f.context.eventStrokeStats.bytes = existingBytes
        const range = f.context.captureEventStrokeVectors(
            () => {
                assert.ok(f.context.strokeEventPath(prepared(), 2))
                assert.equal(f.context.strokeEventPath(prepared(4), 2), false)
                f.paintFallback()
            },
            8,
            2,
        )
        assert.ok(range)
        assert.equal(range.eventStrokes, undefined)
        assert.equal(range.reusable, false)
        assert.equal(range.group.isRenderGroup, false)
        assert.equal(f.context.eventStrokeStats.bytes, 32 * 1024 * 1024)
        assert.ok(f.context.drawVectors(range))
        f.context.flush()
        assert.equal(range.released, true)
        assert.equal(f.context.eventStrokeStats.bytes, existingBytes)
        f.context.eventStrokeStats.bytes = 0

        f.calls.declinePin = true
        const unpinned = f.capture([prepared()])
        assert.equal(unpinned.reusable, false)
        assert.ok(f.context.drawVectors(unpinned))
        f.context.flush()
        assert.equal(unpinned.released, true)
        assert.equal(f.context.eventStrokeStats.bytes, 0)
        assert.equal(f.calls.unpins, 2, 'a refused pin has no release lease')
    } finally {
        f.cleanup()
    }
})

function sectionFixture(stroke: PreparedEventStroke | undefined = prepared()) {
    const f = fixture()
    const cache = new VectorRanges()
    const entity = {
        type: 'stagePivotEventConnection',
        beat: 20,
        min: { beat: 20 },
        max: { beat: 24 },
    } as Entity
    const section: DrawSection = {
        key: 'connection',
        pass: 'normal',
        minBeat: 20,
        maxBeat: 24,
        steps: [{ entity, highlighted: false, raised: false, opacity: 1 }],
    }
    const sections = [section]
    const context: EditorDrawContext = {
        ctx: f.context,
        state: {
            bpms: calculateBpms([{ x: 0, y: 0, s: 0.5 }]),
            stages: new Map(),
            isDynamicStages: true,
        } as State,
        scale: 2.5,
        pixelRatio: 1,
        ups: 2,
        bounds: { l: -10, r: 10, t: -100, b: 0, w: 20, h: 100 },
        defaultGroupId: undefined,
        showStageName: true,
        showGroupName: true,
        nameContrast: false,
        recentlyActive: false,
        fontFamily: 'sans-serif',
        fontMiddle: 0.25,
        figureMiddle: 0.375,
        names: createNameLayer(),
    }
    const draws: { step: DrawStep; captured: boolean }[] = []
    const draw = (context: EditorDrawContext, step: DrawStep) => {
        draws.push({ step, captured: context.ctx.isCapturingEventStrokes })
        if (!context.ctx.strokeEventPath(stroke, context.ups)) f.paintFallback()
    }
    const render = (ups: number, active = true) => {
        context.ups = ups
        cache.beginFrame(context, [])
        cache.prepareSections(sections, active ? sections : [])
        if (active) cache.drawSection(context, section, undefined, draw)
        f.context.flush()
        cache.endFrame()
    }
    const range = () => {
        const value = [...f.read().retained.values()][0]
        assert.ok(value)
        return value
    }
    return {
        ...f,
        cache,
        context,
        section,
        sections,
        draws,
        render,
        range,
        cleanup: () => {
            cache.clear()
            f.cleanup()
        },
    }
}

test('VectorRanges retains detached connection sections across pans and lazy offscreen UPS changes', () => {
    const f = sectionFixture()
    try {
        f.render(2)
        const range = f.range()
        assert.ok(range.eventStrokes)
        assert.equal(f.draws.length, 1)
        f.state.matrix[5] -= 100
        f.render(2)
        assert.equal(f.range(), range)
        assert.equal(f.draws.length, 1)
        f.render(-3, false)
        assert.equal(range.released, false)
        assert.equal(f.context.ctx.eventStrokeStats.updated, 0)
        f.render(-3)
        assert.equal(f.range(), range)
        assert.equal(f.draws.length, 1)
        assert.equal(f.context.ctx.eventStrokeStats.updated, 1)
        assert.equal(f.cache.stats.captures, 1)
        assert.equal(f.cache.stats.replays, 2)
        f.cache.clear()
        f.cache.clear()
        assert.equal(range.released, true)
        assert.equal(f.context.ctx.eventStrokeStats.bytes, 0)
    } finally {
        f.cleanup()
    }
})

test('VectorRanges releases a refused UPS update and keeps fallback artwork reusable only at that UPS', () => {
    const f = sectionFixture(prepared(0, 0.01))
    try {
        f.render(2)
        const first = f.range()
        f.render(8)
        assert.equal(first.released, true)
        const fallback = f.range()
        assert.equal(fallback.eventStrokes, undefined)
        assert.equal(f.draws.length, 2)
        assert.equal(f.context.ctx.eventStrokeStats.bytes, 0)
        f.render(8)
        assert.equal(f.range(), fallback)
        assert.equal(f.draws.length, 2)
        f.render(2)
        assert.equal(fallback.released, true)
        assert.ok(f.range().eventStrokes)
        assert.equal(f.draws.length, 3)
    } finally {
        f.cleanup()
    }
})

test('VectorRanges live connection sections bypass stroke retention and re-capture on UPS change', () => {
    const f = sectionFixture()
    try {
        f.section.live = true
        f.render(2)
        const first = f.range()
        assert.equal(first.eventStrokes, undefined)
        assert.deepEqual(
            f.draws.map(({ captured }) => captured),
            [false],
        )
        f.render(3)
        assert.equal(first.released, true)
        assert.deepEqual(
            f.draws.map(({ captured }) => captured),
            [false, false],
        )
        assert.equal(f.context.ctx.eventStrokeStats.created, 0)
    } finally {
        f.cleanup()
    }
})
