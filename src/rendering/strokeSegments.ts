// The round-capped segments that the preview's selection outline draws, and the curve tolerance
// they share with the path cache. Nothing here imports Pixi, Lyon or libtess, so the preview's
// worker can use it.

const indexed = <T>(values: ArrayLike<T>, index: number): T => values[index] as T

/** The path cache's curve error, in device pixels. */
export const curveTolerance = 0.1

/** Quantized maximum stretch, including the editor's device-pixel transform. */
export function resolutionScale(matrix: readonly number[]) {
    const [a = 1, b = 0, c = 0, d = 1] = matrix
    const trace = a * a + b * b + c * c + d * d
    const determinant = a * d - b * c
    const stretch = Math.sqrt(
        (trace + Math.sqrt(Math.max(0, trace * trace - 4 * determinant * determinant))) / 2,
    )
    if (!Number.isFinite(stretch) || !stretch) return 1
    // A finite bucket set bounds zoom-dependent variants. The editor's normal
    // device scales are well inside this range; cache bytes bound residency.
    return 2 ** Math.max(-8, Math.min(16, Math.ceil(Math.log2(stretch))))
}

/** Chords in an arc of `sweep` radians, each within `tolerance` of the circle. */
export function arcSegments(sweep: number, radius: number, tolerance: number) {
    const step = Math.min(Math.PI / 2, 2 * Math.acos(Math.max(-1, 1 - tolerance / radius)))
    return Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(1e-5, step)))
}

/**
 * The triangles of separate round-capped segments (x0, y0, x1, y1, …), passed
 * to `vertex` three points at a time. They are the bodies and caps that
 * tessellateStroke unions for the same moveTo/lineTo pairs, to rounding, left
 * overlapping, so only an opaque paint draws them as that union.
 */
export function roundCappedSegments(
    segments: ArrayLike<number>,
    width: number,
    tolerance: number,
    vertex: (x: number, y: number) => void,
) {
    const half = width / 2
    if (!(half > 0)) return
    const count = arcSegments(Math.PI, half, tolerance)
    // One half circle, turned to each cap, instead of two trig calls for every point.
    const arcX: number[] = []
    const arcY: number[] = []
    for (let i = 0; i <= count; i++) {
        arcX.push(half * Math.cos((Math.PI * i) / count))
        arcY.push(half * Math.sin((Math.PI * i) / count))
    }
    // Counterclockwise about (x, y), from the unit direction (nx, ny).
    const cap = (x: number, y: number, nx: number, ny: number) => {
        let px = x + nx * half
        let py = y + ny * half
        for (let i = 1; i <= count; i++) {
            const qx = x + nx * indexed(arcX, i) - ny * indexed(arcY, i)
            const qy = y + ny * indexed(arcX, i) + nx * indexed(arcY, i)
            vertex(x, y)
            vertex(px, py)
            vertex(qx, qy)
            px = qx
            py = qy
        }
    }
    for (let i = 0; i + 3 < segments.length; i += 4) {
        const ax = indexed(segments, i)
        const ay = indexed(segments, i + 1)
        const bx = indexed(segments, i + 2)
        const by = indexed(segments, i + 3)
        if (!Number.isFinite(ax + ay + bx + by)) continue
        // A zero-length lineTo adds no point, so the path strokes nothing there.
        if (Math.abs(bx - ax) <= 1e-9 && Math.abs(by - ay) <= 1e-9) continue
        const length = Math.hypot(bx - ax, by - ay)
        const dx = (bx - ax) / length
        const dy = (by - ay) / length
        vertex(ax - dy * half, ay + dx * half)
        vertex(bx - dy * half, by + dx * half)
        vertex(bx + dy * half, by - dx * half)
        vertex(ax - dy * half, ay + dx * half)
        vertex(bx + dy * half, by - dx * half)
        vertex(ax + dy * half, ay - dx * half)
        // Each cap starts a quarter turn back from its direction, as tessellateStroke's arc does.
        cap(ax, ay, -dy, dx)
        cap(bx, by, dy, -dx)
    }
}
