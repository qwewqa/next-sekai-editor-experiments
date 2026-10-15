import assert from 'node:assert/strict'
import test from 'node:test'
import { Container } from 'pixi.js'
import { WebGLDrawContext } from '../../src/rendering/context'
import type { Matrix } from '../../src/rendering/matrix'
import { DrawPath } from '../../src/rendering/path'

function fixture(matrix: Matrix) {
    const scene = new Container()
    const state = { matrix, clips: [] }
    const internals = {
        scene,
        state,
        path: new DrawPath(),
        pathMatrix: [...matrix],
        states: [state],
        layers: [],
        retained: new Map(),
        resources: { resourceOwner: {} },
        paths: { pin: () => () => {} },
        ensure: () => true,
        mutate: () => true,
        parent: () => scene,
        recycleNodes: (container: Container) => container.removeChildren(),
    }
    const context = Object.assign(
        Object.create(WebGLDrawContext.prototype) as object,
        internals,
    ) as unknown as WebGLDrawContext
    return { context, scene, state, read: () => context as unknown as typeof internals }
}

test('canonical vector captures have the same local transform after arbitrary viewport pans', () => {
    const origin = [0, 123456.25] as const
    const first = fixture([40, 0, 0, -32, 127.125, 3950666.5])
    const second = fixture([40, 0, 0, -32, -63.375, 3950707.125])
    try {
        const capture = (value: typeof first) => {
            const before = value.read().state
            let captured: Matrix | undefined
            const range = value.context.captureVectors(() => {
                captured = [...value.read().state.matrix]
                // A callback may replace its drawing state; the caller retains
                // the original state and capture anchor in either case.
                value.read().state.matrix = [1, 0, 0, 1, 0, 0]
            }, origin)!
            assert.equal(value.read().state, before)
            assert.equal(value.read().states[0], before)
            assert.deepEqual(range.matrix, captured)
            assert.equal(value.context.drawVectors(range), true)
            assert.equal(range.group.position.x, before.matrix[4] - range.matrix[4])
            assert.equal(range.group.position.y, before.matrix[5] - range.matrix[5])
            return range
        }
        const a = capture(first)
        const b = capture(second)
        assert.deepEqual(a.matrix, b.matrix)
        assert.deepEqual(a.matrix, [40, 0, 0, -32, -0, 3950600])
        a.group.destroy()
        b.group.destroy()
    } finally {
        first.scene.destroy()
        second.scene.destroy()
    }
})

test('capture restores caller state and scene after a failing callback', () => {
    const value = fixture([1, 0, 0, 1, 20, 30])
    const original = value.read().state
    const failure = new Error('capture failed')
    try {
        assert.throws(
            () =>
                value.context.captureVectors(() => {
                    throw failure
                }, [0, 1000]),
            failure,
        )
        assert.equal(value.read().state, original)
        assert.equal(value.read().scene, value.scene)
        assert.equal(value.read().retained.size, 0)
    } finally {
        value.scene.destroy()
    }
})

test('nonfinite capture origins preserve the existing finite transform', () => {
    const value = fixture([2, 0, 0, -3, 20, 30])
    try {
        const range = value.context.captureVectors(() => {}, [0, Infinity])!
        assert.deepEqual(range.matrix, value.state.matrix)
        assert.equal(value.context.drawVectors(range), true)
        assert.deepEqual([range.group.x, range.group.y], [0, 0])
        range.group.destroy()
    } finally {
        value.scene.destroy()
    }
})

test('capture path commands cannot mutate or replace the caller current path', () => {
    const value = fixture([2, 0, 0, -3, 20, 30])
    value.context.moveTo(1, 2)
    value.context.lineTo(4, 5)
    const original = value.read().path
    const originalMatrix = value.read().pathMatrix
    const commands = JSON.stringify(original.commands)
    try {
        const range = value.context.captureVectors(() => {
            value.context.lineTo(7, 8)
            value.context.beginPath()
            value.context.rect(0, 1000, 3, 4)
        }, [0, 1000])!
        assert.equal(value.read().path, original)
        assert.equal(value.read().pathMatrix, originalMatrix)
        assert.equal(JSON.stringify(original.commands), commands)
        range.group.destroy()
        assert.throws(() =>
            value.context.captureVectors(() => {
                value.context.lineTo(9, 10)
                throw new Error('failed path capture')
            }, [0, 1000]),
        )
        assert.equal(value.read().path, original)
        assert.equal(value.read().pathMatrix, originalMatrix)
        assert.equal(JSON.stringify(original.commands), commands)
    } finally {
        value.scene.destroy()
    }
})
