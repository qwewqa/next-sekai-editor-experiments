import assert from 'node:assert/strict'
import test from 'node:test'
import { clipConvexPolygon } from '../../src/rendering/triangleClip'

const polygon = (...points: number[]) => new Float64Array(points)
const rectangle = (x: number, y: number, width: number, height: number) =>
    polygon(x, y, x + width, y, x + width, y + height, x, y + height)
const area = (points: Float64Array) => {
    let result = 0
    assert.ok(points.every(Number.isFinite), 'output has only finite coordinates')
    for (let i = 2; i + 3 < points.length; i += 2) {
        const bx = points[i]! - points[0]!,
            by = points[i + 1]! - points[1]!
        const cx = points[i + 2]! - points[0]!,
            cy = points[i + 3]! - points[1]!
        result += bx * cy - by * cx
    }
    return Math.abs(result) / 2
}
const intersection = (a: Float64Array, b: Float64Array) => {
    const result = clipConvexPolygon(a, b)
    assert.ok(result)
    return result
}
const reversed = (points: Float64Array) => {
    const result = points.slice()
    for (let i = 0; i < points.length; i += 2) {
        result[i] = points[points.length - i - 2]!
        result[i + 1] = points[points.length - i - 1]!
    }
    return result
}
const contains = (points: Float64Array, x: number, y: number) => {
    if (points.length < 6) return false
    let positive = false,
        negative = false
    for (let a = 0; a < points.length; a += 2) {
        const b = (a + 2) % points.length
        const side =
            (points[b]! - points[a]!) * (y - points[a + 1]!) -
            (points[b + 1]! - points[a + 1]!) * (x - points[a]!)
        positive ||= side > 0
        negative ||= side < 0
    }
    return !(positive && negative)
}
let seed = 0x7193a1
const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
}

test('convex clipping preserves either winding and exact touching boundaries', () => {
    const square = [0, 0, 4, 0, 4, 4, 0, 4]
    const strip = [2, -1, 5, -1, 5, 2, 2, 2]
    const clipped = clipConvexPolygon(square, strip)
    assert.ok(clipped)
    assert.equal(clipped.length, 8)
    const points = (values: ArrayLike<number>) =>
        Array.from({ length: values.length / 2 }, (_, i) => [
            values[i * 2],
            values[i * 2 + 1],
        ]).sort()
    assert.deepEqual(points(clipped), [
        [2, 0],
        [2, 2],
        [4, 0],
        [4, 2],
    ])
    assert.deepEqual(
        points(clipConvexPolygon(square, [2, 2, 5, 2, 5, -1, 2, -1])!),
        points(clipped),
    )
    assert.equal(clipConvexPolygon(square, [5, 0, 6, 0, 6, 1, 5, 1])?.length, 0)
    const touching = intersection(rectangle(0, 0, 4, 4), rectangle(4, 0, 2, 2))
    assert.equal(area(touching), 0)
    for (let i = 0; i < touching.length; i += 2) assert.equal(touching[i], 4)
})

test('convex helper declines concave, crossing, non-finite and unsupported polygons', () => {
    const square = [0, 0, 4, 0, 4, 4, 0, 4]
    for (const invalid of [
        [0, 0, 4, 4, 4, 0, 0, 4],
        [0, 0, 4, 0, 1, 1, 0, 4],
        [0, 0, Infinity, 0, 0, 1],
        [0, 0, 1],
        [0, 0, 2, 0, 3, 1, 2, 2, 0, 2],
    ]) {
        assert.equal(clipConvexPolygon(square, invalid), undefined)
        assert.equal(clipConvexPolygon(invalid, square), undefined)
    }
    assert.equal(clipConvexPolygon(square, [0, 0, 1, 1, 2, 2])?.length, 0)
})

test('opposing triangles form the exact six-vertex intersection', () => {
    const a = polygon(0, 0, 6, 0, 3, 6)
    const b = polygon(0, 4, 6, 4, 3, -2)
    const output = intersection(a, b)
    assert.equal(output.length, 12)
    assert.equal(area(output), 12)
    for (const x of [1.01, 2.53, 4.99])
        for (const y of [0.03, 1.77, 3.96])
            assert.equal(contains(output, x, y), contains(a, x, y) && contains(b, x, y))
    assert.equal(area(intersection(reversed(a), b)), 12)
    assert.equal(area(intersection(a, reversed(b))), 12)
})

test('rectangle intersection area agrees with independent bounds in either winding', () => {
    for (let index = 0; index < 250; index++) {
        const ax = random() * 8,
            ay = random() * 8,
            aw = random() * 8,
            ah = random() * 8
        const bx = random() * 8,
            by = random() * 8,
            bw = random() * 8,
            bh = random() * 8
        const a = rectangle(ax, ay, aw, ah)
        const b = rectangle(bx, by, bw, bh)
        const expected =
            Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx)) *
            Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by))
        assert.ok(Math.abs(area(intersection(index % 2 ? reversed(a) : a, b)) - expected) < 1e-10)
    }
})

test('independent point classification and commutative area agree for arbitrary triangles', () => {
    for (let iteration = 0; iteration < 200; iteration++) {
        const a = Float64Array.from({ length: 6 }, () => random() * 20 - 10)
        const b = Float64Array.from({ length: 6 }, () => random() * 20 - 10)
        const output = intersection(a, b)
        assert.ok(Math.abs(area(output) - area(intersection(b, a))) < 1e-10)
        for (let sample = 0; sample < 80; sample++) {
            const x = random() * 20 - 10,
                y = random() * 20 - 10
            assert.equal(contains(output, x, y), contains(a, x, y) && contains(b, x, y))
        }
    }
})

test('far timeline coordinates retain double precision', () => {
    const a = polygon(0, 0, 6, 0, 3, 6),
        b = polygon(0, 4, 6, 4, 3, -2)
    const translated = (points: Float64Array) =>
        points.map((value, index) => value + (index % 2 ? 2 ** 40 : -(2 ** 36)))
    const local = intersection(a, b)
    const far = intersection(translated(a), translated(b))
    assert.deepEqual(
        far.map((value, index) => value - (index % 2 ? 2 ** 40 : -(2 ** 36))),
        local,
    )
    assert.equal(area(far), 12)
})

test('empty and degenerate polygons contribute no area and neither input is mutated', () => {
    const a = polygon(0, 0, 4, 0, 0, 4)
    const b = rectangle(-1, -1, 8, 8)
    const oldA = a.slice(),
        oldB = b.slice()
    assert.equal(area(intersection(a, b)), 8)
    assert.deepEqual(a, oldA)
    assert.deepEqual(b, oldB)
    assert.equal(intersection(new Float64Array(), b).length, 0)
    assert.equal(intersection(b, new Float64Array()).length, 0)
    const degenerate = polygon(1, 1, 1, 1, 1, 1)
    assert.equal(intersection(degenerate, b).length, 0)
    assert.equal(intersection(b, degenerate).length, 0)
})

test('finite opposite-side distances whose difference overflows use the existing clip', () => {
    const subject = polygon(-1, -1e154, 1, -1e154, 0, 1e154)
    const boundary = [-5e153, 0, 5e153, 0, 5e153, 1, -5e153, 1]
    assert.equal(clipConvexPolygon(subject, boundary), undefined)
})

test('axis-aligned clip boundaries retain their exact coordinate', () => {
    const output = clipConvexPolygon(
        [-0.75, -2, 1.25, -2, 1.25, 12, -0.75, 12],
        [0, 0, 10, 0, 10, 10, 0, 10],
    )
    assert.ok(output)
    for (let index = 0; index < output.length; index += 2) {
        assert.ok(output[index] === 0 || output[index] === 1.25)
        assert.ok(output[index + 1] === 0 || output[index + 1] === 10)
    }
})
