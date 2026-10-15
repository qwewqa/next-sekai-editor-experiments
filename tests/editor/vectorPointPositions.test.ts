import assert from 'node:assert/strict'
import test from 'node:test'
import { Container, Graphics, type GraphicsContext } from 'pixi.js'
import { WebGLDrawContext, type RetainedVectors } from '../../src/rendering/context'
import type { Matrix } from '../../src/rendering/matrix'
import { DrawPath } from '../../src/rendering/path'

function fixture(matrix: Matrix = [2.5, 0, 0, -3.75, 11.125, 47.375]) {
    const scene = new Container()
    const state = { matrix, clips: [] as unknown[], globalAlpha: 0.625 }
    const calls = { pins: [] as object[][], releases: 0, flushes: 0, declinePin: false }
    const graphics: Graphics[] = []
    const internals = {
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
        resources: { resourceOwner: {}, lost: false },
        paths: {
            pin: (contexts: Iterable<object>) => {
                calls.pins.push([...contexts])
                return calls.declinePin
                    ? undefined
                    : () => {
                          calls.releases++
                      }
            },
        },
        ensure: () => true,
        mutate: () => true,
        parent: () => scene,
        flush: () => {
            calls.flushes++
            scene.removeChildren()
        },
    }
    const context = Object.assign(
        Object.create(WebGLDrawContext.prototype) as object,
        internals,
    ) as unknown as WebGLDrawContext
    const read = () => context as unknown as typeof internals
    const paint = (index: number) => {
        const current = read()
        const graphic = new Graphics().rect(-0.125, -0.375, 1.25, 0.75).fill(0x123456)
        graphic.alpha = (current.state.globalAlpha * (index + 1)) / 4
        graphic.scale.set(current.state.matrix[0], current.state.matrix[3])
        graphic.position.set(current.state.matrix[4], current.state.matrix[5])
        current.scene.addChild(graphic)
        graphics.push(graphic)
    }
    const capture = (ys: readonly number[], origin: number, empty = false) => {
        const range = context.capturePointVectors(
            ys.map((y, index) => ({
                y,
                draw: () => {
                    if (!empty) paint(index)
                },
            })),
            origin,
        )
        assert.ok(range)
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
    return { context, state, calls, scene, read, paint, capture, cleanup }
}

const positions = (range: RetainedVectors) => ({
    matrix: [...range.matrix],
    groupPosition: [range.group.x, range.group.y],
    parent: range.group.parent,
    points: range.pointGroups!.map((point) => ({
        x: point.x,
        y: point.y,
        scale: [point.scale.x, point.scale.y],
        alpha: point.alpha,
        graphics: point.children.map((graphic) => ({
            x: graphic.x,
            y: graphic.y,
            scale: [graphic.scale.x, graphic.scale.y],
            alpha: graphic.alpha,
        })),
    })),
})

test('point anchors reuse one render group and match fresh signed/far-origin captures exactly', () => {
    for (const matrix of [
        [2.5, 0, 0, -3.75, 11.125, 47.375],
        [-0.625, 0, 0, 17.25, -7, 0.125],
    ] satisfies Matrix[]) {
        const value = fixture(matrix)
        try {
            const range = value.capture([1.25, 3.375], 1)
            const points = [...range.pointGroups!]
            const artwork = points.map((point) => point.children[0])
            assert.equal(range.group.isRenderGroup, true)
            assert.ok(points.every((point) => !point.isRenderGroup))
            assert.equal(range.graphics, 2)
            assert.equal(value.calls.pins[0]?.length, 2)
            for (const origin of [17.123456789, -(2 ** 40) + 0.125]) {
                const ys = new Float64Array([origin - 0.3125, origin + 123.375])
                const before = [...ys]
                assert.ok(value.context.updateVectorPointPositions(range, ys, origin))
                const fresh = value.capture([...ys], origin)
                const actual = positions(range)
                const expected = positions(fresh)
                // Existing captureVectors computes -(a * 0 + c * originY).
                // A reflected matrix and negative origin can change only this zero's sign.
                assert.ok(actual.matrix[4] === expected.matrix[4])
                actual.matrix[4] = expected.matrix[4]!
                assert.deepEqual(actual, expected)
                assert.deepEqual([...ys], before)
                range.pointGroups!.forEach((point, index) => {
                    assert.equal(point, points[index])
                    assert.equal(point.children[0], artwork[index])
                })
            }
        } finally {
            value.cleanup()
        }
    }
})

test('empty point captures charge anchors and pin refusal keeps a one-shot range releasable', () => {
    const value = fixture()
    try {
        const empty = value.capture([1, 2, 3], 0, true)
        assert.equal(empty.graphics, 3)
        assert.equal(empty.pointGroups?.length, 3)
        assert.deepEqual(value.calls.pins[0], [])
        assert.equal(empty.reusable, true)
        value.context.releaseVectors(empty)
        value.context.releaseVectors(empty)
        assert.equal(value.calls.releases, 1)
        value.calls.declinePin = true
        const once = value.capture([4, 5], 4)
        assert.equal(once.reusable, false)
        assert.equal(once.group.isRenderGroup, false)
        assert.ok(value.context.drawVectors(once))
        value.context.releaseVectors(once)
        value.context.releaseVectors(once)
        assert.equal(value.calls.flushes, 1)
        assert.equal(value.calls.releases, 1, 'a refused pin has no release lease')
        assert.equal(once.group.destroyed, true)
        assert.equal(value.read().retained.size, 0)
    } finally {
        value.cleanup()
    }
})

test('point update guards reject atomically without flushing or releasing pinned artwork', () => {
    type Fixture = ReturnType<typeof fixture>
    const guards: [string, (value: Fixture, range: RetainedVectors) => void][] = [
        [
            'released',
            (_value, range) => {
                range.released = true
            },
        ],
        [
            'owner',
            (value) => {
                value.read().resources.resourceOwner = {}
            },
        ],
        [
            'map',
            (value, range) => {
                value.read().retained.set(range.group, { ...range })
            },
        ],
        [
            'queued',
            (value, range) => {
                value.scene.addChild(range.group)
            },
        ],
        [
            'layers',
            (value) => {
                value.read().layers.push({})
            },
        ],
        [
            'clips',
            (value) => {
                value.state.clips.push({})
            },
        ],
        [
            'linear',
            (value) => {
                value.state.matrix[3] *= 2
            },
        ],
        [
            'nonfinite matrix',
            (value) => {
                value.state.matrix[4] = NaN
            },
        ],
        [
            'child count',
            (_value, range) => {
                range.group.addChild(new Container())
            },
        ],
        [
            'point parent',
            (value, range) => {
                value.scene.addChild(range.pointGroups![0]!)
            },
        ],
    ]
    for (const [name, invalidate] of guards) {
        const value = fixture()
        try {
            const range = value.capture([1, 2], 0)
            invalidate(value, range)
            const before = positions(range)
            assert.equal(value.context.updateVectorPointPositions(range, [10, 20], 8), false, name)
            assert.deepEqual(positions(range), before, name)
            assert.equal(value.calls.flushes, 0)
            assert.equal(value.calls.releases, 0)
            value.read().retained.set(range.group, range)
        } finally {
            value.cleanup()
        }
    }
    const value = fixture([1, 0, 0, 4, 0, 0])
    try {
        const range = value.capture([1, 2], 0)
        for (const [ys, origin] of [
            [[100, NaN], 0],
            [[100, Number.MAX_VALUE], 0],
            [[100, 200], NaN],
            [[100, 200], Number.MAX_VALUE],
            [[100], 0],
            [{ length: 2, 0: 100 }, 0],
        ] as [ArrayLike<number>, number][]) {
            const before = positions(range)
            assert.equal(value.context.updateVectorPointPositions(range, ys, origin), false)
            assert.deepEqual(positions(range), before)
        }
    } finally {
        value.cleanup()
    }
})

test('point capture declines recursive/invalid inputs and restores all context state after a throw', () => {
    const value = fixture()
    try {
        let invoked = 0
        const draw = () => {
            invoked++
        }
        assert.equal(value.context.capturePointVectors([], 0), undefined)
        assert.equal(value.context.capturePointVectors([{ y: NaN, draw }], 0), undefined)
        assert.equal(value.context.capturePointVectors([{ y: 0, draw }], Infinity), undefined)
        value.state.matrix[1] = 0.25
        assert.equal(value.context.capturePointVectors([{ y: 0, draw }], 0), undefined)
        value.state.matrix[1] = 0
        value.state.clips.push({})
        assert.equal(value.context.capturePointVectors([{ y: 0, draw }], 0), undefined)
        value.state.clips.pop()
        assert.equal(invoked, 0)
        const original = {
            scene: value.read().scene,
            state: value.read().state,
            states: value.read().states,
            path: value.read().path,
            pathMatrix: value.read().pathMatrix,
        }
        const failure = new Error('point drawing failed')
        assert.throws(
            () =>
                value.context.capturePointVectors(
                    [
                        {
                            y: 123,
                            draw: () => {
                                assert.equal(
                                    value.context.capturePointVectors([{ y: 0, draw }], 0),
                                    undefined,
                                )
                                value.paint(0)
                                value.read().state = { ...value.read().state, globalAlpha: 0.1 }
                                value.read().activeClip = {}
                                value.read().activeParent = new Container()
                                value.read().activeParent!.destroy()
                                throw failure
                            },
                        },
                    ],
                    100,
                ),
            failure,
        )
        for (const key of ['scene', 'state', 'states', 'path', 'pathMatrix'] as const)
            assert.equal(value.read()[key], original[key], key)
        assert.equal(value.read().activeClip, undefined)
        assert.equal(value.read().activeParent, undefined)
        assert.equal(value.read().retained.size, 0)
        assert.equal(value.calls.pins.length, 0)
        const range = value.capture([10], 0)
        assert.equal(range.group.isRenderGroup, true, 'throw resets the recursive-capture guard')
        assert.equal(range.pointGroups?.[0]?.alpha, 1)
        assert.deepEqual([range.pointGroups![0]!.scale.x, range.pointGroups![0]!.scale.y], [1, 1])
        value.context.releaseVectors(range)
        assert.equal(value.calls.releases, 1)
    } finally {
        value.cleanup()
    }
})
