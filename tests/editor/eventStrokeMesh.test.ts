import assert from 'node:assert/strict'
import test from 'node:test'
import { Texture } from 'pixi.js'
import { createEventPath } from '../../src/editor/entities/events/path'
import {
    EventStrokeGeometry,
    EventStrokeMesh,
    prepareEventStroke,
    type PreparedEventStroke,
} from '../../src/rendering/eventStrokeMesh'
import { certifyNativeStrokeStrip } from '../../src/rendering/nativeStrokeStrip'
import { DrawPath } from '../../src/rendering/path'

const at = (values: ArrayLike<number>, index: number) => values[index] as number
const line = (...points: [number, number][]) => {
    const path = new DrawPath()
    for (const [index, point] of points.entries())
        if (index) path.lineTo(...point)
        else path.moveTo(...point)
    return path
}
const prepare = (path: DrawPath, scale = 80) => {
    const prepared = prepareEventStroke(path, scale)
    assert.ok(prepared, 'fixture must be a supported prepared event path')
    return prepared
}
const create = (prepared: PreparedEventStroke, sx = 80, st = 100, width = 2) => {
    const geometry = EventStrokeGeometry.create(prepared, sx, st, width)
    assert.ok(geometry, 'fixture must form a certified stroke strip')
    return geometry
}
const triangleArea = (geometry: EventStrokeGeometry) => {
    const p = geometry.positions
    let area = 0
    for (let i = 0; i < geometry.indices.length; i += 3) {
        const a = at(geometry.indices, i) * 2,
            b = at(geometry.indices, i + 1) * 2,
            c = at(geometry.indices, i + 2) * 2
        area +=
            Math.abs(
                (at(p, b) - at(p, a)) * (at(p, c + 1) - at(p, a + 1)) -
                    (at(p, b + 1) - at(p, a + 1)) * (at(p, c) - at(p, a)),
            ) / 2
    }
    return area
}

test('preparation owns locally rebased coordinates, preserves overshoots and ignores later path writes', () => {
    const points: [number, number][] = [
        [0, 10],
        [2, 11],
        [2, 11],
        [-1, 12],
        [1, 13],
    ]
    const path = line(...points)
    const original = prepare(path)
    const translated = prepare(
        line(...points.map(([x, t]): [number, number] => [x + 2 ** 40, t + 2 ** 40])),
    )
    assert.deepEqual(original.points, translated.points)
    assert.equal(translated.originX - original.originX, 2 ** 40)
    assert.equal(translated.originTime - original.originTime, 2 ** 40)
    assert.equal(original.points.length, 8, 'only the exact duplicate vertex is removed')
    const snapshot = original.points.slice()
    path.lineTo(42, 99)
    assert.deepEqual(original.points, snapshot)
    assert.equal(original.horizontalError, 0)
    assert.equal(original.timeError, 0)
})

test('preparation conservatively refuses unsupported contour, curve and work shapes', () => {
    const closed = line([0, 0], [1, 1])
    closed.closePath()
    const multiple = line([0, 0], [1, 1])
    multiple.moveTo(2, 2)
    multiple.lineTo(3, 3)
    const cubic = line([0, 0])
    cubic.bezierCurveTo(0, 1, 1, 2, 2, 3)
    const nonlinearTime = line([0, 0])
    nonlinearTime.quadraticCurveTo(1, 0.3, 2, 1)
    const mixed = line([0, 0], [1, 1])
    mixed.quadraticCurveTo(2, 1.5, 3, 2)
    const three = line([0, 0])
    for (let i = 0; i < 3; i++) three.quadraticCurveTo(i, i + 0.5, i + 1, i + 1)
    const tooMany = line(...Array.from({ length: 513 }, (_, i): [number, number] => [i, i]))
    const tooCurved = line([0, 0])
    tooCurved.quadraticCurveTo(1e8, 0.5, 0, 1)
    for (const path of [
        new DrawPath(),
        line([0, 0]),
        line([0, 0], [0, 0]),
        closed,
        multiple,
        cubic,
        nonlinearTime,
        mixed,
        three,
        tooMany,
        tooCurved,
    ])
        assert.equal(prepareEventStroke(path, 80), undefined)
    for (const scale of [0, NaN, Infinity, -Infinity])
        assert.equal(prepareEventStroke(line([0, 0], [1, 1]), scale), undefined)
})

test('prepared quadratic chords stay within horizontal device tolerance independent of vertical zoom', () => {
    const ease = {
        inQuad: (t: number) => t * t,
        outQuad: (t: number) => t * (2 - t),
        inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2),
        outInQuad: (t: number) => (t < 0.5 ? 2 * t * (1 - t) : 0.5 + 2 * (t - 0.5) ** 2),
    }
    for (const name of Object.keys(ease) as (keyof typeof ease)[]) {
        const source = prepare(createEventPath(-2, 3, 0, 1, name), 96)
        for (let i = 1; i < source.points.length / 2; i++) {
            const x0 = at(source.points, 2 * i - 2) + source.originX,
                x1 = at(source.points, 2 * i) + source.originX,
                t0 = at(source.points, 2 * i - 1) + source.originTime,
                t1 = at(source.points, 2 * i + 1) + source.originTime
            for (let j = 0; j <= 16; j++) {
                const f = j / 16,
                    t = t0 + (t1 - t0) * f,
                    actualX = -2 + 5 * ease[name](t),
                    chordX = x0 + (x1 - x0) * f
                assert.ok(Math.abs(actualX - chordX) * 96 <= 0.100000000001, `${name} chord error`)
            }
        }
        for (const scaleTime of [-1000, -100, 100, 1000]) {
            const geometry = create(source, 96, scaleTime)
            assert.ok(
                certifyNativeStrokeStrip(
                    geometry.positions,
                    geometry.indices,
                    source.points.length / 2,
                ),
            )
            geometry.destroy()
        }
    }
})

test('straight butt strokes have exact endpoint planes, fixed width and capsule-free area under reflection', () => {
    const source = prepare(line([2, 10], [5, 14]))
    for (const sx of [-16, 16])
        for (const st of [-20, 20]) {
            const geometry = create(source, sx, st, 4)
            const dx = 3 * sx,
                dy = 4 * st,
                length = Math.hypot(dx, dy),
                nx = -dy / length,
                ny = dx / length
            for (let endpoint = 0; endpoint < 2; endpoint++) {
                const cx = at(source.points, endpoint * 2) * sx,
                    cy = at(source.points, endpoint * 2 + 1) * st
                for (let side = 0; side < 2; side++) {
                    const x = at(geometry.positions, endpoint * 4 + side * 2) - cx,
                        y = at(geometry.positions, endpoint * 4 + side * 2 + 1) - cy
                    assert.ok(Math.abs((x * dx + y * dy) / length) < 0.00001)
                    assert.ok(Math.abs(Math.abs(x * nx + y * ny) - 2) < 0.00001)
                }
            }
            assert.ok(Math.abs(triangleArea(geometry) - length * 4) < 0.001)
            assert.ok(geometry.uvs.every((value) => value === 0.5))
            assert.equal(geometry.batchMode, 'batch')
            geometry.destroy()
        }
})

test('stage preserves public buffers until commit, and a refusal invalidates previously staged work', () => {
    const geometry = create(prepare(line([0, 0], [1, 1], [2, 3])))
    const positions = geometry.positions,
        uvs = geometry.uvs,
        indices = geometry.indices,
        original = positions.slice(),
        positionBuffer = geometry.getBuffer('aPosition')
    let updates = 0
    positionBuffer.on('update', () => updates++)
    assert.equal(geometry.stage(80, 200, 2), true)
    assert.deepEqual(geometry.positions, original)
    assert.equal(updates, 0)
    geometry.commit()
    assert.notDeepEqual(geometry.positions, original)
    assert.equal(updates, 1)
    assert.equal(geometry.positions, positions)
    assert.equal(geometry.uvs, uvs)
    assert.equal(geometry.indices, indices)
    const committed = positions.slice()
    assert.equal(geometry.stage(-80, 300, 2), true)
    assert.equal(geometry.stage(0, 300, 2), false)
    geometry.commit()
    assert.deepEqual(positions, committed)
    assert.equal(updates, 1)
    geometry.destroy()
})

test('range staging can refuse one member without publishing earlier members', () => {
    const a = create(prepare(line([0, 0], [1, 1])))
    const b = create(prepare(line([0, 0], [1, 1])))
    const beforeA = a.positions.slice(),
        beforeB = b.positions.slice()
    assert.equal(a.stage(80, 200, 2), true)
    assert.equal(b.stage(80, Infinity, 2), false)
    assert.deepEqual(a.positions, beforeA)
    assert.deepEqual(b.positions, beforeB)
    a.destroy()
    b.destroy()
})

test('uncertain joins, collapsed or imprecise packing and invalid scales decline without publishing', () => {
    for (const path of [
        line([0, 0], [1, 0], [0, 0]),
        line([0, 0], [1, 0], [0.001, 0.001]),
        line([0, 0], [0.001, 0], [0.001, 0.001]),
        line([0, 0], [1e8 + 1, 0]),
    ])
        assert.equal(EventStrokeGeometry.create(prepare(path), 1, 1, 2), undefined)
    const geometry = create(prepare(line([0, 0], [1, 1])))
    const before = geometry.positions.slice()
    for (const args of [
        [0, 1, 2],
        [1, 0, 2],
        [1, 1, 0],
        [1, 1, -1],
        [NaN, 1, 2],
        [1, Infinity, 2],
        [1, 1, Infinity],
        [1e308, 1, 2],
        [1e-308, 1e-308, 2],
    ] as const) {
        assert.equal(geometry.stage(args[0], args[1], args[2]), false)
        geometry.commit()
        assert.deepEqual(geometry.positions, before)
    }
    geometry.destroy()
})

test('tiny rounded time curvature is retained in the projected error guard', () => {
    const path = line([0, 0])
    path.quadraticCurveTo(1, 1e-16, 2, 0)
    const prepared = prepare(path)
    assert.ok(prepared.timeError > 0)
    const geometry = create(prepared, 80, 1)
    const before = geometry.positions.slice()
    assert.equal(geometry.stage(80, 1e18, 2), false)
    geometry.commit()
    assert.deepEqual(geometry.positions, before)
    geometry.destroy()
})

test('geometry accounts for owned numeric payload and destroys its buffers exactly once', () => {
    const source = prepare(line([0, 0], [1, 1]))
    const geometry = create(source)
    const buffers = [
        geometry.getBuffer('aPosition'),
        geometry.getBuffer('aUV'),
        geometry.indexBuffer,
    ]
    const bytes =
        source.points.byteLength +
        geometry.positions.byteLength * 2 +
        geometry.uvs.byteLength +
        geometry.indices.byteLength
    assert.equal(geometry.prepared, source)
    assert.equal(geometry.byteSize, bytes)
    const mesh = new EventStrokeMesh({ geometry, texture: Texture.WHITE })
    assert.equal(mesh.geometry, geometry)
    let destroys = 0
    for (const buffer of buffers) buffer.on('destroy', () => destroys++)
    mesh.destroy()
    assert.equal(geometry.destroyed, false, 'mesh borrows retained geometry')
    geometry.destroy()
    geometry.destroy()
    assert.equal(destroys, 3)
    assert.equal(geometry.destroyed, true)
    assert.equal(geometry.stage(80, 100, 2), false)
    geometry.commit()
})
