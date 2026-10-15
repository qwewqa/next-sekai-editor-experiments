type Coordinates = ArrayLike<number>
type Budget = { remaining: number }

// Callers and loop bounds establish the coordinate indices.
const at = <T>(points: ArrayLike<T>, index: number): T => points[index] as T
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx

/** Zero is degenerate; undefined rejects non-convex or non-finite input. */
const orientation = (points: Coordinates, offset: number, count: number) => {
    let direction = 0
    for (let i = 0; i < count; i++) {
        const a = offset + i * 2
        const b = offset + ((i + 1) % count) * 2
        const c = offset + ((i + 2) % count) * 2
        const turn = cross(
            at(points, b) - at(points, a),
            at(points, b + 1) - at(points, a + 1),
            at(points, c) - at(points, b),
            at(points, c + 1) - at(points, b + 1),
        )
        if (!Number.isFinite(turn)) return
        if (!turn) continue
        const sign = Math.sign(turn)
        if (direction && direction !== sign) return
        direction = sign
    }
    return direction
}

/** Reused scratch storage for Sutherland–Hodgman convex clipping. */
class ConvexClipper {
    private a: Float64Array
    private b: Float64Array
    result: Float64Array

    constructor(maxVertices: number) {
        this.result = this.a = new Float64Array(maxVertices * 2)
        this.b = new Float64Array(maxVertices * 2)
    }

    // Returns a vertex count, or -1 to retain the existing GPU clip fallback.
    clip(
        subject: Coordinates,
        subjectOffset: number,
        count: number,
        boundary: Coordinates,
        boundaryOffset: number,
        boundaryCount: number,
        direction: number,
        budget: Budget,
    ) {
        let input = this.a
        let output = this.b
        for (let i = 0; i < count * 2; i++) input[i] = at(subject, subjectOffset + i)
        for (let edge = 0; edge < boundaryCount && count; edge++) {
            budget.remaining -= count
            if (budget.remaining < 0) return -1
            const start = boundaryOffset + edge * 2
            const end = boundaryOffset + ((edge + 1) % boundaryCount) * 2
            const ax = at(boundary, start)
            const ay = at(boundary, start + 1)
            const dx = at(boundary, end) - ax
            const dy = at(boundary, end + 1) - ay
            let used = 0
            const push = (x: number, y: number) => {
                if (!Number.isFinite(x) || !Number.isFinite(y)) return false
                if (used && at(output, used - 2) === x && at(output, used - 1) === y) return true
                if (used + 2 > output.length) return false
                output[used++] = x
                output[used++] = y
                return true
            }
            let px = at(input, (count - 1) * 2)
            let py = at(input, (count - 1) * 2 + 1)
            let previous = direction * cross(dx, dy, px - ax, py - ay)
            for (let vertex = 0; vertex < count; vertex++) {
                const x = at(input, vertex * 2)
                const y = at(input, vertex * 2 + 1)
                const distance = direction * cross(dx, dy, x - ax, y - ay)
                if (!Number.isFinite(previous) || !Number.isFinite(distance)) return -1
                if (previous < 0 !== distance < 0) {
                    const denominator = previous - distance
                    if (!Number.isFinite(denominator)) return -1
                    const fraction = previous / denominator
                    // Interpolate from the nearer end to reduce cancellation.
                    const ix =
                        dx === 0
                            ? ax
                            : fraction <= 0.5
                              ? px + (x - px) * fraction
                              : x + (px - x) * (1 - fraction)
                    const iy =
                        dy === 0
                            ? ay
                            : fraction <= 0.5
                              ? py + (y - py) * fraction
                              : y + (py - y) * (1 - fraction)
                    if (!push(ix, iy)) return -1
                }
                if (distance >= 0 && !push(x, y)) return -1
                px = x
                py = y
                previous = distance
            }
            if (
                used > 2 &&
                at(output, 0) === at(output, used - 2) &&
                at(output, 1) === at(output, used - 1)
            )
                used -= 2
            count = used / 2
            ;[input, output] = [output, input]
        }
        this.result = input
        return count
    }
}

/**
 * Intersect convex triangles or quadrilaterals, accepting either winding. No epsilon
 * expands the clip. Undefined keeps the caller's existing mask for invalid input.
 */
export const clipConvexPolygon = (subject: Coordinates, boundary: Coordinates) => {
    if (subject.length % 2 || boundary.length % 2 || subject.length > 8 || boundary.length > 8)
        return
    if (subject.length < 6 || boundary.length < 6) return new Float64Array()
    const subjectDirection = orientation(subject, 0, subject.length / 2)
    const boundaryDirection = orientation(boundary, 0, boundary.length / 2)
    if (subjectDirection === undefined || boundaryDirection === undefined) return
    if (!subjectDirection || !boundaryDirection) return new Float64Array()
    const clipper = new ConvexClipper((subject.length + boundary.length) / 2 + 2)
    const count = clipper.clip(
        subject,
        0,
        subject.length / 2,
        boundary,
        0,
        boundary.length / 2,
        boundaryDirection,
        { remaining: 1024 },
    )
    return count < 0 ? undefined : clipper.result.slice(0, count * 2)
}
