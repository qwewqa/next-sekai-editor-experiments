type Point = readonly [number, number]
type Segment = {
    index: number
    a: Point
    b: Point
    left: number
    right: number
    top: number
    bottom: number
}

export const maxStrokeStripPoints = 512
const maxWork = 25_000

const orientation = (a: Point, b: Point, c: Point) => {
    const p = (b[0] - a[0]) * (c[1] - a[1])
    const q = (b[1] - a[1]) * (c[0] - a[0])
    const area = p - q
    const uncertainty = 32 * Number.EPSILON * (Math.abs(p) + Math.abs(q))
    // Match Pixi's minimum triangle area, and refuse uncertain arithmetic.
    return Number.isFinite(area) && Math.abs(area) > Math.max(1e-8, uncertainty)
        ? Math.sign(area)
        : 0
}

// All accesses below are within the checked strip or its equally sized boundary.
const at = <T>(items: readonly T[], index: number) => items[index] as T

/**
 * Pixi's ordinary miter stroke is a consecutive triangle strip. Consistent
 * triangle orientation cancels interior edges; a simple boundary then has
 * winding one, proving that its triangles cannot overlap and darken alpha.
 * Extra join branches, degeneracy, uncertainty and excessive work decline.
 */
export function certifyNativeStrokeStrip(
    vertices: ArrayLike<number>,
    indices: ArrayLike<number>,
    flattenedPointCount: number,
) {
    const vertexCount = vertices.length / 2
    if (
        !Number.isInteger(flattenedPointCount) ||
        flattenedPointCount < 2 ||
        flattenedPointCount > maxStrokeStripPoints ||
        vertexCount !== 2 * flattenedPointCount ||
        indices.length !== (vertexCount - 2) * 3
    )
        return false

    const points: Point[] = []
    for (let i = 0; i < vertices.length; i += 2) {
        const x = vertices[i] ?? NaN,
            y = vertices[i + 1] ?? NaN
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false
        points.push([x, y])
    }
    let sign = 0
    for (let i = 0; i < vertexCount - 2; i++) {
        if (indices[3 * i] !== i || indices[3 * i + 1] !== i + 1 || indices[3 * i + 2] !== i + 2)
            return false
        const current =
            orientation(at(points, i), at(points, i + 1), at(points, i + 2)) * (i % 2 ? -1 : 1)
        if (!current || (sign && sign !== current)) return false
        sign = current
    }

    const boundary: Point[] = []
    for (let i = 0; i < vertexCount; i += 2) boundary.push(at(points, i))
    for (let i = vertexCount - 1; i >= 1; i -= 2) boundary.push(at(points, i))
    for (let i = 0; i < boundary.length; i++) {
        const a = at(boundary, (i + boundary.length - 1) % boundary.length),
            b = at(boundary, i),
            c = at(boundary, (i + 1) % boundary.length)
        if (orientation(a, b, c)) continue
        const x = (b[0] - a[0]) * (c[0] - b[0]),
            y = (b[1] - a[1]) * (c[1] - b[1])
        // Adjacent edges may continue straight, but may not retrace each other.
        if (!(x + y > 32 * Number.EPSILON * (Math.abs(x) + Math.abs(y)))) return false
    }
    const segments: Segment[] = boundary
        .map((a, index) => {
            const b = at(boundary, (index + 1) % boundary.length)
            return {
                index,
                a,
                b,
                left: Math.min(a[0], b[0]),
                right: Math.max(a[0], b[0]),
                top: Math.min(a[1], b[1]),
                bottom: Math.max(a[1], b[1]),
            }
        })
        .sort((a, b) => a.top - b.top)
    const active: Segment[] = []
    let work = 0
    for (const segment of segments) {
        let kept = 0
        for (const previous of active) {
            if (++work > maxWork) return false
            if (previous.bottom < segment.top) continue
            active[kept++] = previous
            const apart = Math.abs(previous.index - segment.index)
            if (apart === 1 || apart === boundary.length - 1) continue
            if (previous.right < segment.left || segment.right < previous.left) continue
            const a = orientation(previous.a, previous.b, segment.a),
                b = orientation(previous.a, previous.b, segment.b),
                c = orientation(segment.a, segment.b, previous.a),
                d = orientation(segment.a, segment.b, previous.b)
            // A robust separating side proves disjointness. Touching and
            // uncertain pairs retain the general union tessellator.
            if ((a && a === b) || (c && c === d)) continue
            return false
        }
        active.length = kept
        active.push(segment)
    }
    return true
}
