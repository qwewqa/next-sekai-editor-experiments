import type { StageTriangles } from '../../rendering/stageMesh'
import { clipConvexInto } from '../../rendering/triangleClip'

/** x/y pairs in stage order: left A, left B, right B, right A. */
export type StageQuad = readonly [number, number, number, number, number, number, number, number]

// Loop bounds establish indices; NaN keeps an unexpected missing coordinate on
// the existing-renderer fallback path rather than inventing a vertex.
const coordinate = (points: ArrayLike<number>, index: number) => points[index] ?? NaN

// Reused storage: stage geometry is built synchronously, one shape at a time.
const rectangle = new Float64Array(8)
const clipped = new Float64Array(20)

/*
 * Stage geometry adapter. Each helper appends its triangles and returns true, or
 * appends nothing and returns false to request the existing renderer; a
 * zero-area shape appends nothing and returns true. These helpers do not add an
 * AA fringe, move the clip boundary, or change stroke width.
 */

// Fan triangles of a convex polygon's first `count` vertices, skipping zero-area ones.
const appendConvex = (
    triangles: StageTriangles,
    polygon: ArrayLike<number>,
    count: number,
    color: number,
    alpha: number,
) => {
    const start = triangles.vertices.length
    const x0 = coordinate(polygon, 0)
    const y0 = coordinate(polygon, 1)
    for (let offset = 2; offset + 3 < count * 2; offset += 2) {
        const x1 = coordinate(polygon, offset)
        const y1 = coordinate(polygon, offset + 1)
        const x2 = coordinate(polygon, offset + 2)
        const y2 = coordinate(polygon, offset + 3)
        const area2 = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)
        if (!Number.isFinite(area2)) {
            triangles.vertices.length = start
            return false
        }
        if (area2) triangles.appendTriangle(x0, y0, x1, y1, x2, y2, color, alpha)
    }
    return true
}

/**
 * Fill a stage quad, including a triangle with a collapsed endpoint. `direction`
 * is the quad's `convexDirection`.
 */
export const appendStageQuad = (
    triangles: StageTriangles,
    quad: StageQuad,
    direction: number | undefined,
    color: number,
    alpha: number,
) => {
    // Reuse the clip's convexity validation; fill the original vertices rather
    // than any calculated intersection vertices.
    const count = clipConvexInto(quad, quad, direction, clipped)
    return count >= 0 && (!count || appendConvex(triangles, quad, 4, color, alpha))
}

/**
 * Proves that an equally spaced set of these parallel butt rectangles has no
 * overlapping interiors. False means use the existing coverage-union renderer.
 *
 * Adjacent strokes differ by (spacing, 0). Their perpendicular displacement is
 * abs(spacing * dy) / length, and their parallel displacement is
 * abs(spacing * dx) / length. The rectangles cannot overlap if either projection
 * is at least the corresponding extent (width or length). More distant pairs
 * only increase both displacements, so checking adjacent strokes is sufficient.
 *
 * Axis cases compare exact input extents. Diagonal cases conservatively decline
 * a floating-point ambiguity near touching edges; this only changes fast-path
 * eligibility and never adds an epsilon to the rendered geometry.
 */
export const dividerQuadsAreDisjoint = (
    dx: number,
    dy: number,
    spacing: number,
    width: number,
): boolean => {
    if (![dx, dy, spacing, width].every(Number.isFinite) || width < 0) return false
    if (!width || (!dx && !dy)) return true
    const distance = Math.abs(spacing)
    if (!distance) return false
    if (!dx) return distance >= width
    if (!dy) return distance >= Math.abs(dx)
    const length = Math.hypot(dx, dy)
    if (!Number.isFinite(length)) return false
    const perpendicular = distance * (Math.abs(dy) / length)
    const parallel = distance * (Math.abs(dx) / length)
    const separated = (projection: number, extent: number) =>
        projection - extent > 8 * Number.EPSILON * Math.max(projection, extent)
    return separated(perpendicular, width) || separated(parallel, length)
}

/**
 * Writes the exact local-coordinate rectangle of a straight, centered, butt-capped
 * stroke to `rectangle`: 1, or 0 when it is empty, or -1 for invalid input.
 */
const buttStrokeQuad = (ax: number, ay: number, bx: number, by: number, width: number) => {
    if (
        !(
            Number.isFinite(ax) &&
            Number.isFinite(ay) &&
            Number.isFinite(bx) &&
            Number.isFinite(by) &&
            Number.isFinite(width)
        ) ||
        width < 0
    )
        return -1
    if (!width || (ax === bx && ay === by)) return 0
    const dx = bx - ax
    const dy = by - ay
    const length = Math.hypot(dx, dy)
    if (!Number.isFinite(length) || !length) return -1
    const halfWidth = width / 2
    const nx = (-dy / length) * halfWidth
    const ny = (dx / length) * halfWidth
    rectangle[0] = ax + nx
    rectangle[1] = ay + ny
    rectangle[2] = bx + nx
    rectangle[3] = by + ny
    rectangle[4] = bx - nx
    rectangle[5] = by - ny
    rectangle[6] = ax - nx
    rectangle[7] = ay - ny
    for (let i = 0; i < 8; i++) if (!Number.isFinite(coordinate(rectangle, i))) return -1
    return 1
}

/** A stage border uses the same centered butt stroke, without the stage clip. */
export const appendButtStroke = (
    triangles: StageTriangles,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    width: number,
    color: number,
    alpha: number,
) => {
    const quad = buttStrokeQuad(ax, ay, bx, by, width)
    return quad >= 0 && (!quad || appendConvex(triangles, rectangle, 4, color, alpha))
}

/**
 * Clip the complete stroke rectangle to the stage, preserving perpendicular butt
 * endpoints. `direction` is the stage's `convexDirection`.
 */
export const appendStageStroke = (
    triangles: StageTriangles,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    width: number,
    stage: StageQuad,
    direction: number | undefined,
    color: number,
    alpha: number,
) => {
    const quad = buttStrokeQuad(ax, ay, bx, by, width)
    if (quad <= 0) return !quad
    const count = clipConvexInto(rectangle, stage, direction, clipped)
    return count >= 0 && appendConvex(triangles, clipped, count, color, alpha)
}
