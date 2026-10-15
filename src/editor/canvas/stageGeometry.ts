import { clipConvexPolygon } from '../../rendering/triangleClip'

/** x/y pairs in stage order: left A, left B, right B, right A. */
export type StageQuad = readonly [number, number, number, number, number, number, number, number]

// Loop bounds establish indices; NaN keeps an unexpected missing coordinate on
// the existing-renderer fallback path rather than inventing a vertex.
const coordinate = (points: Float64Array, index: number) => points[index] ?? NaN

/**
 * Stage geometry adapter. Undefined requests the existing renderer;
 * an empty array is a valid zero-area result. These helpers do not add an AA
 * fringe, move the clip boundary, or change stroke width.
 */
const triangulateConvex = (polygon: Float64Array): Float64Array | undefined => {
    const triangles: number[] = []
    const x0 = coordinate(polygon, 0)
    const y0 = coordinate(polygon, 1)
    for (let offset = 2; offset + 3 < polygon.length; offset += 2) {
        const x1 = coordinate(polygon, offset)
        const y1 = coordinate(polygon, offset + 1)
        const x2 = coordinate(polygon, offset + 2)
        const y2 = coordinate(polygon, offset + 3)
        const area2 = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)
        if (!Number.isFinite(area2)) return
        if (area2) triangles.push(x0, y0, x1, y1, x2, y2)
    }
    return new Float64Array(triangles)
}

/** Triangulate a stage quad, including a triangle with a collapsed endpoint. */
export const triangulateStageQuad = (quad: StageQuad): Float64Array | undefined => {
    // Reuse the root helper's convexity validation; retain the original vertices
    // for the un-clipped fill rather than any calculated intersection vertices.
    const polygon = clipConvexPolygon(quad, quad)
    return polygon && (polygon.length ? triangulateConvex(new Float64Array(quad)) : polygon)
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

/** Exact local-coordinate rectangle for a straight, centered, butt-capped stroke. */
export const buttStrokeQuad = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    width: number,
): Float64Array | undefined => {
    if (![ax, ay, bx, by, width].every(Number.isFinite) || width < 0) return
    if (!width || (ax === bx && ay === by)) return new Float64Array()
    const dx = bx - ax
    const dy = by - ay
    const length = Math.hypot(dx, dy)
    if (!Number.isFinite(length) || !length) return
    const halfWidth = width / 2
    const nx = (-dy / length) * halfWidth
    const ny = (dx / length) * halfWidth
    const quad = new Float64Array([
        ax + nx,
        ay + ny,
        bx + nx,
        by + ny,
        bx - nx,
        by - ny,
        ax - nx,
        ay - ny,
    ])
    return quad.every(Number.isFinite) ? quad : undefined
}

/** A stage border uses the same centered butt stroke, without the stage clip. */
export const triangulateButtStroke = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    width: number,
): Float64Array | undefined => {
    const quad = buttStrokeQuad(ax, ay, bx, by, width)
    return quad && triangulateConvex(quad)
}

/** Clip the complete stroke rectangle, preserving perpendicular butt endpoints. */
export const clipButtStrokeToStage = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    width: number,
    stage: StageQuad,
): Float64Array | undefined => {
    const quad = buttStrokeQuad(ax, ay, bx, by, width)
    if (!quad) return
    const polygon = clipConvexPolygon(quad, stage)
    return polygon && triangulateConvex(polygon)
}
