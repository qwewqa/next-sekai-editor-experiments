import assert from 'node:assert/strict'
import test from 'node:test'
import { Container, Graphics, Mesh } from 'pixi.js'
import { WebGLDrawContext } from '../../src/rendering/context'
import type { Matrix } from '../../src/rendering/matrix'
import { DrawGradient, type DrawStyle } from '../../src/rendering/paint'
import { DrawPath } from '../../src/rendering/path'
import { PathGraphicsCache, type PathGraphicsResource } from '../../src/rendering/pathGraphics'
import { PathMeshGeometry } from '../../src/rendering/pathMesh'
import { PaintStyles } from '../../src/rendering/pixiPaint'
import { pathResourceGeometry } from './pixiGeometryTestUtils'

function fixture(matrix: Matrix = [3, 0, 0, -5, 17.125, 91.375]) {
    const scene = new Container()
    const paths = new PathGraphicsCache()
    const paints = new PaintStyles()
    const state = {
        matrix,
        fillStyle: '#12345680' as DrawStyle,
        globalAlpha: 0.375,
        globalCompositeOperation: 'source-over',
        dash: [] as number[],
        lineDashOffset: 0,
        clips: [],
    }
    const calls = {
        cache: [] as { resource: PathGraphicsResource; resolution: number | undefined }[],
        paints: 0,
        mutations: 0,
    }
    const available = { value: true }
    const get = paths.get.bind(paths)
    paths.get = (...args: Parameters<PathGraphicsCache['get']>) => {
        const resource = get(...args)
        calls.cache.push({ resource, resolution: args[6] })
        return resource
    }
    const fill = paints.fill.bind(paints)
    paints.fill = (style) => {
        calls.paints++
        return fill(style)
    }
    const context = Object.assign(Object.create(WebGLDrawContext.prototype) as object, {
        state,
        ensure: () => available.value,
        mutate: () => {
            calls.mutations++
            return available.value
        },
        paths,
        paints,
        graphicPool: [],
        graphicsByContext: new Map(),
        pooledGraphics: 0,
        pathMeshPool: [],
        meshesByGeometry: new Map(),
        pooledPathMeshes: 0,
        parent: () => scene,
    }) as unknown as WebGLDrawContext
    const cleanup = () => {
        // Draw nodes borrow cache geometry; destroy them before their owner cache.
        for (const node of scene.removeChildren()) {
            if (node instanceof Graphics) node.destroy({ context: false })
            else node.destroy()
        }
        paths.destroy()
        paints.destroy()
        scene.destroy()
    }
    return { context, state, scene, paths, paints, calls, available, cleanup }
}

const body = (compound = false) => {
    const path = new DrawPath()
    path.rect(-1, 0, 3, 2)
    if (compound) path.rect(0, 1, 3, 2)
    return path
}

const nodeResource = (node: Container) => {
    if (node instanceof Graphics) return node.context
    assert.ok(node instanceof Mesh && node.geometry instanceof PathMeshGeometry)
    return node.geometry
}

function assertPlacement(
    node: Container,
    resource: PathGraphicsResource,
    factor: number,
    matrix: Matrix,
    yScale: number,
    originY: number,
) {
    node.updateLocalTransform()
    const geometry = pathResourceGeometry(resource)
    const ox = resource instanceof PathMeshGeometry ? resource.originX : 0
    const oy = resource instanceof PathMeshGeometry ? resource.originY : 0
    for (let index = 0; index < geometry.vertices.length; index += 2) {
        const x = geometry.vertices[index]!
        const y = geometry.vertices[index + 1]!
        const actual = node.localTransform.apply({ x: x - ox, y: y - oy })
        assert.ok(Math.abs(actual.x - ((matrix[0] * x) / factor + matrix[4])) < 1e-7)
        assert.ok(
            Math.abs(actual.y - (matrix[3] * ((y / factor) * yScale + originY) + matrix[5])) < 1e-7,
        )
    }
    return geometry
}

test('queued connector fills share a LOD resource but keep independent transforms and immutable inputs', () => {
    for (const compound of [false, true]) {
        const value = fixture()
        try {
            const path = body(compound)
            const commands = structuredClone(path.commands)
            const state = { ...value.state, matrix: [...value.state.matrix] }
            assert.equal(value.context.fillConnectorBody(path, 1, 100.125), true)
            const first = value.scene.children[0]!
            const resource = nodeResource(first)
            const firstGeometry = pathResourceGeometry(resource)
            first.updateLocalTransform()
            const firstMatrix = first.localTransform.clone()
            assert.equal(value.context.fillConnectorBody(path, -1.1, -23.375), true)
            const second = value.scene.children[1]!
            assert.notEqual(first, second)
            assert.equal(nodeResource(second), resource)
            assert.equal(resource instanceof PathMeshGeometry, compound)
            assert.deepEqual(
                value.calls.cache.map(({ resolution }) => resolution),
                [8, 8],
            )
            assertPlacement(first, resource, 8, value.state.matrix, 1, 100.125)
            assertPlacement(second, resource, 8, value.state.matrix, -1.1, -23.375)
            assert.deepEqual(first.localTransform, firstMatrix)
            assert.deepEqual(pathResourceGeometry(resource), firstGeometry)
            assert.deepEqual(path.commands, commands)
            assert.deepEqual(value.state, state)
            assert.equal(first.alpha, compound ? 0.375 * (128 / 255) : 0.375)
            first.destroy()
            assert.equal(resource.destroyed, false, 'a draw node borrows its cache resource')
            assert.equal(second.destroyed, false)
            assert.deepEqual(pathResourceGeometry(nodeResource(second)), firstGeometry)
            assert.ok(value.context.fillConnectorBody(path, 1.05, 0))
            assert.equal(nodeResource(value.scene.children.at(-1)!), resource)
        } finally {
            value.cleanup()
        }
    }
})

test('reference-space gradient coordinates remain attached to borrowed native and mesh geometry', () => {
    for (const compound of [false, true]) {
        const value = fixture()
        try {
            const gradient = new DrawGradient([0, 0], [0, 10])
            gradient.addColorStop(0, '#ff000000')
            gradient.addColorStop(1, '#ff0000')
            value.state.fillStyle = gradient
            const original = JSON.stringify(gradient)
            const path = body(compound)
            for (const [yScale, originY] of [
                [1, 17.25],
                [-1.1, -13.125],
                [2.1, 23.75],
            ]) {
                assert.equal(value.context.fillConnectorBody(path, yScale!, originY!), true)
                const node = value.scene.children.at(-1)!
                const { resource, resolution } = value.calls.cache.at(-1)!
                const geometry = assertPlacement(
                    node,
                    resource,
                    resolution!,
                    value.state.matrix,
                    yScale!,
                    originY!,
                )
                for (let index = 0; index < geometry.vertices.length; index += 2) {
                    const referenceY = geometry.vertices[index + 1]! / resolution!
                    // Two texels hold the endpoint colors at their centers.
                    assert.ok(Math.abs(geometry.uvs[index]! - (0.25 + referenceY / 20)) < 1e-6)
                }
                assert.equal(JSON.stringify(gradient), original)
                assert.equal(value.state.fillStyle, gradient)
            }
            assert.equal(value.calls.cache[0]!.resource, value.calls.cache[1]!.resource)
            assert.notEqual(value.calls.cache[1]!.resource, value.calls.cache[2]!.resource)
        } finally {
            value.cleanup()
        }
    }
})

test('LOD refinement and immutable path versions leave already queued connector nodes intact', () => {
    const value = fixture([1, 0, 0, -1, 0, 0])
    try {
        const path = new DrawPath()
        path.moveTo(0, 0)
        path.quadraticCurveTo(4, 1, 0, 2)
        path.closePath()
        assert.ok(value.context.fillConnectorBody(path, 1, 0))
        const first = value.scene.children[0]!
        const firstResource = nodeResource(first)
        const firstGeometry = pathResourceGeometry(firstResource)
        assert.ok(value.context.fillConnectorBody(path, 1.01, 100))
        const refined = value.calls.cache.at(-1)!
        assert.equal(refined.resolution, 2)
        assert.notEqual(refined.resource, firstResource)
        path.rect(10, 0, 1, 1)
        assert.ok(value.context.fillConnectorBody(path, 1, 0))
        assert.notEqual(value.calls.cache.at(-1)!.resource, firstResource)
        assert.deepEqual(pathResourceGeometry(firstResource), firstGeometry)
        assert.equal(firstResource.destroyed, false)
        assert.equal(first.parent, value.scene)
    } finally {
        value.cleanup()
    }
})

test('invalid connector transforms decline without touching paint, cache, queued nodes or state', () => {
    const value = fixture([1, 0, 0, 1, 0, 0])
    try {
        const path = body()
        assert.ok(value.context.fillConnectorBody(path, 1, 0))
        const first = value.scene.children[0]!
        first.updateLocalTransform()
        const firstMatrix = first.localTransform.clone()
        const cacheCount = value.calls.cache.length
        const paintCount = value.calls.paints
        for (const [matrix, yScale, originY] of [
            [[1, 0, 0, 1, 0, 0], 0, 0],
            [[1, 0, 0, 1, 0, 0], NaN, 0],
            [[1, 0, 0, 1, 0, 0], 1, Infinity],
            [[1, 0, 0, 1, 0, 0], 65537, 0],
            [[1, 0, 0, 1, 0, 0], Number.MAX_VALUE, 0],
            [[0, 0, 0, 1, 0, 0], 1, 0],
            [[1, 0, 0, 0, 0, 0], 1, 0],
            [[1, 0.25, 0, 1, 0, 0], 1, 0],
            [[1, 0, 0.25, 1, 0, 0], 1, 0],
            [[1, 0, 0, 1, NaN, 0], 1, 0],
            [[1, 0, 0, 2, 0, 0], 1, Number.MAX_VALUE],
        ] as [Matrix, number, number][]) {
            value.state.matrix = matrix
            const before = { ...value.state, matrix: [...matrix] }
            assert.equal(value.context.fillConnectorBody(path, yScale, originY), false)
            assert.deepEqual(value.state, before)
            assert.deepEqual(value.scene.children, [first])
            assert.deepEqual(first.localTransform, firstMatrix)
            assert.equal(value.calls.cache.length, cacheCount)
            assert.equal(value.calls.paints, paintCount)
        }
        value.state.matrix = [1, 0, 0, 1, 0, 0]
        value.available.value = false
        assert.equal(value.context.fillConnectorBody(path, 1, 0), false)
        assert.equal(value.calls.cache.length, cacheCount)
        value.available.value = true
        assert.equal(value.context.fillConnectorBody(new DrawPath(), 65536, 0), true)
        assert.equal(value.scene.children.length, 1, 'valid empty fill queues no stale node')
    } finally {
        value.cleanup()
    }
})
