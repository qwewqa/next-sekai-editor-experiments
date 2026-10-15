import { triangulateLyon } from './lyon'
import type { DrawPath, PathCommand } from './path'
import { parseSvgPath } from './pathSvg'
import libtess from './vendor/libtess.js'

type Point = [number, number]
type Points = [Point, ...Point[]]
type Contour = { points: Points; closed: boolean; tangent?: Point }
type Matrix = readonly [number, number, number, number, number, number, number, number, number]

// Internal loops prove each index against array length; do not add a runtime
// bounds check to every coordinate access in tessellation.
const indexed = <T>(values: readonly T[], index: number): T => values[index] as T
export type StrokeOptions = {
    width: number
    cap: CanvasLineCap
    join: CanvasLineJoin
    miterLimit: number
    dash: readonly number[]
    dashOffset: number
}

const tau = 2 * Math.PI
const same = (a: Point, b: Point) => Math.abs(a[0] - b[0]) <= 1e-9 && Math.abs(a[1] - b[1]) <= 1e-9
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx
const transformed = (p: Point, m: Matrix): Point => [
    m[0] * p[0] + m[1] * p[1] + m[2],
    m[3] * p[0] + m[4] * p[1] + m[5],
]
const scaleOf = (m: Matrix) => {
    // Maximum singular value bounds transformed curve error without refining
    // unchanged curves every time a path receives another translation.
    const sum = m[0] ** 2 + m[1] ** 2 + m[3] ** 2 + m[4] ** 2
    const determinant = m[0] * m[4] - m[1] * m[3]
    return Math.sqrt((sum + Math.sqrt(Math.max(0, sum * sum - 4 * determinant ** 2))) / 2)
}

function transformedPoints(contour: Contour, matrix: Matrix): Points {
    const points: Points = [transformed(contour.points[0], matrix)]
    for (let i = 1; i < contour.points.length; i++) {
        const point = transformed(indexed(contour.points, i), matrix)
        // Singular transforms can collapse formerly distinct segments. Stroke
        // directions require the same duplicate pruning as ordinary lineTo.
        if (!same(indexed(points, points.length - 1), point)) points.push(point)
    }
    if (contour.closed && points.length > 1 && same(points[0], indexed(points, points.length - 1)))
        points.pop()
    return points
}

/** Flatten in double precision: timeline coordinates can be much larger than the viewport. */
class FlattenedPath {
    readonly contours: Contour[] = []
    private active?: Contour

    constructor(readonly tolerance: number) {}

    get current(): Point | undefined {
        return this.active?.points.at(-1)
    }

    move(x: number, y: number) {
        const active: Contour = { points: [[x, y]], closed: false }
        this.active = active
        this.contours.push(active)
        return active
    }

    line(x: number, y: number) {
        let active = this.active
        if (!active) {
            this.move(x, y)
            return
        }
        // closePath preserves the current point but a following segment starts
        // a fresh open contour there (rather than changing the closed contour).
        if (active.closed) {
            const start = active.points[0]
            active = this.move(start[0], start[1])
        }
        const p: Point = [x, y]
        // Contours always contain their move-to point.
        if (!same(indexed(active.points, active.points.length - 1), p)) active.points.push(p)
    }

    close() {
        if (!this.active) return
        this.active.closed = true
        // A repeated endpoint is unnecessary; stroke traversal closes it once.
        const points = this.active.points
        if (points.length > 1 && same(points[0], indexed(points, points.length - 1))) points.pop()
    }

    private startPoint(fallback: Point): Point {
        if (this.active?.closed) {
            const p = this.active.points[0]
            this.move(...p)
            return p
        }
        const current = this.current
        if (current) return current
        this.move(...fallback)
        return fallback
    }

    quadratic(cx: number, cy: number, x: number, y: number) {
        const p = this.startPoint([cx, cy])
        this.cubic(
            p[0] + ((cx - p[0]) * 2) / 3,
            p[1] + ((cy - p[1]) * 2) / 3,
            x + ((cx - x) * 2) / 3,
            y + ((cy - y) * 2) / 3,
            x,
            y,
        )
    }

    cubic(cx1: number, cy1: number, cx2: number, cy2: number, x: number, y: number) {
        const p = this.startPoint([cx1, cy1])
        const tolerance2 = this.tolerance * this.tolerance
        const distance2 = (
            px: number,
            py: number,
            ax: number,
            ay: number,
            bx: number,
            by: number,
        ) => {
            const dx = bx - ax
            const dy = by - ay
            const t = Math.max(
                0,
                Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy) || 0),
            )
            return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
        }
        const subdivide = (
            ax: number,
            ay: number,
            bx: number,
            by: number,
            cx: number,
            cy: number,
            dx: number,
            dy: number,
            depth: number,
        ) => {
            if (
                depth >= 20 ||
                Math.max(distance2(bx, by, ax, ay, dx, dy), distance2(cx, cy, ax, ay, dx, dy)) <=
                    tolerance2
            ) {
                this.line(dx, dy)
                return
            }
            const abx = (ax + bx) / 2,
                aby = (ay + by) / 2
            const bcx = (bx + cx) / 2,
                bcy = (by + cy) / 2
            const cdx = (cx + dx) / 2,
                cdy = (cy + dy) / 2
            const abcx = (abx + bcx) / 2,
                abcy = (aby + bcy) / 2
            const bcdx = (bcx + cdx) / 2,
                bcdy = (bcy + cdy) / 2
            const midx = (abcx + bcdx) / 2,
                midy = (abcy + bcdy) / 2
            subdivide(ax, ay, abx, aby, abcx, abcy, midx, midy, depth + 1)
            subdivide(midx, midy, bcdx, bcdy, cdx, cdy, dx, dy, depth + 1)
        }
        subdivide(p[0], p[1], cx1, cy1, cx2, cy2, x, y, 0)
    }

    ellipse(
        x: number,
        y: number,
        rx: number,
        ry: number,
        rotation: number,
        start: number,
        end: number,
        ccw: boolean,
    ) {
        const delta = end - start
        const sweep = ccw
            ? delta <= -tau
                ? -tau
                : delta > 0
                  ? (delta % tau) - tau
                  : delta
            : delta >= tau
              ? tau
              : delta < 0
                ? (delta % tau) + tau
                : delta
        this.ellipseSweep(x, y, rx, ry, rotation, start, sweep)
    }

    ellipseSweep(
        x: number,
        y: number,
        rx: number,
        ry: number,
        rotation: number,
        start: number,
        sweep: number,
    ) {
        const c = Math.cos(rotation),
            s = Math.sin(rotation)
        const radius = Math.max(rx, ry)
        const step = radius
            ? Math.min(Math.PI / 2, 2 * Math.acos(Math.max(-1, 1 - this.tolerance / radius)))
            : Math.PI / 2
        const steps = Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(1e-5, step)))
        for (let i = 0; i <= steps; i++) {
            const angle = start + (sweep * i) / steps
            const ax = rx * Math.cos(angle),
                ay = ry * Math.sin(angle)
            this.line(x + c * ax - s * ay, y + s * ax + c * ay)
        }
    }

    arcTo(x1: number, y1: number, x2: number, y2: number, radius: number) {
        if (!this.current) {
            this.move(x1, y1)
            return
        }
        const p = this.startPoint([x1, y1])
        let ax = p[0] - x1,
            ay = p[1] - y1
        let bx = x2 - x1,
            by = y2 - y1
        const al = Math.hypot(ax, ay),
            bl = Math.hypot(bx, by)
        if (!al || !bl || !radius) {
            this.line(x1, y1)
            return
        }
        ax /= al
        ay /= al
        bx /= bl
        by /= bl
        const turn = cross(ax, ay, bx, by)
        if (Math.abs(turn) < 1e-14) {
            this.line(x1, y1)
            return
        }
        const angle = Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by)))
        const distance = radius / Math.tan(angle / 2)
        const tx = x1 + ax * distance,
            ty = y1 + ay * distance
        const sign = turn < 0 ? -1 : 1
        const cx = tx - ay * radius * sign,
            cy = ty + ax * radius * sign
        const endX = x1 + bx * distance,
            endY = y1 + by * distance
        this.ellipse(
            cx,
            cy,
            radius,
            radius,
            0,
            Math.atan2(ty - cy, tx - cx),
            Math.atan2(endY - cy, endX - cx),
            turn > 0,
        )
    }

    roundRect(
        x: number,
        y: number,
        w: number,
        h: number,
        radii: readonly (number | DOMPointInit)[],
    ) {
        const normalized = radii.map((r) => {
            const rx = typeof r === 'number' ? r : (r.x ?? 0)
            const ry = typeof r === 'number' ? r : (r.y ?? 0)
            return rx && ry ? ([rx, ry] as Point) : ([0, 0] as Point)
        })
        const a = normalized[0] ?? ([0, 0] as Point)
        const b = normalized[1] ?? a
        const c = normalized[2] ?? a
        const d = normalized[3] ?? b
        let [tl, tr, br, bl]: [Point, Point, Point, Point] = [a, b, c, d]
        const reverse = w < 0 !== h < 0
        if (w < 0) {
            x += w
            w = -w
            ;[tl, tr, br, bl] = [tr, tl, bl, br]
        }
        if (h < 0) {
            y += h
            h = -h
            ;[tl, tr, br, bl] = [bl, br, tr, tl]
        }
        const fit = (size: number, radii: number) => (radii ? size / radii : 1)
        const scale = Math.min(
            1,
            fit(w, tl[0] + tr[0]),
            fit(w, bl[0] + br[0]),
            fit(h, tl[1] + bl[1]),
            fit(h, tr[1] + br[1]),
        )
        ;[tl, tr, br, bl] = [tl, tr, br, bl].map(
            ([rx, ry]) => [rx * scale, ry * scale] as Point,
        ) as [Point, Point, Point, Point]
        const r = x + w,
            bottom = y + h
        this.move(x + tl[0], y)
        if (reverse) {
            this.ellipseSweep(x + tl[0], y + tl[1], tl[0], tl[1], 0, -Math.PI / 2, -Math.PI / 2)
            this.line(x, bottom - bl[1])
            this.ellipseSweep(x + bl[0], bottom - bl[1], bl[0], bl[1], 0, Math.PI, -Math.PI / 2)
            this.line(r - br[0], bottom)
            this.ellipseSweep(r - br[0], bottom - br[1], br[0], br[1], 0, Math.PI / 2, -Math.PI / 2)
            this.line(r, y + tr[1])
            this.ellipseSweep(r - tr[0], y + tr[1], tr[0], tr[1], 0, 0, -Math.PI / 2)
        } else {
            this.line(r - tr[0], y)
            this.ellipseSweep(r - tr[0], y + tr[1], tr[0], tr[1], 0, -Math.PI / 2, Math.PI / 2)
            this.line(r, bottom - br[1])
            this.ellipseSweep(r - br[0], bottom - br[1], br[0], br[1], 0, 0, Math.PI / 2)
            this.line(x + bl[0], bottom)
            this.ellipseSweep(x + bl[0], bottom - bl[1], bl[0], bl[1], 0, Math.PI / 2, Math.PI / 2)
            this.line(x, y + tl[1])
            this.ellipseSweep(x + tl[0], y + tl[1], tl[0], tl[1], 0, Math.PI, Math.PI / 2)
        }
        this.close()
        this.move(x, y)
    }

    append(contours: Contour[], matrix?: Matrix) {
        for (const c of contours)
            this.contours.push({
                points: matrix ? transformedPoints(c, matrix) : c.points,
                closed: c.closed,
            })
        this.active = this.contours.at(-1)
    }

    transform(matrix: Matrix) {
        for (const contour of this.contours) contour.points = transformedPoints(contour, matrix)
    }
}

function flatten(commands: readonly PathCommand[], tolerance: number): Contour[] {
    // Embedded transforms affect already-recorded curves. Conservatively reduce
    // their flattening tolerance before they are transformed.
    let scale = 1
    for (const command of commands)
        if (command[0] === 'transform') scale *= Math.max(1, scaleOf(command[1]))
    const path = new FlattenedPath(Math.max(1e-8, tolerance / scale))
    for (const command of commands) {
        switch (command[0]) {
            case 'moveTo':
                path.move(command[1], command[2])
                break
            case 'lineTo':
                path.line(command[1], command[2])
                break
            case 'closePath':
                path.close()
                break
            case 'rect': {
                const [, x, y, w, h] = command
                path.move(x, y)
                path.line(x + w, y)
                path.line(x + w, y + h)
                path.line(x, y + h)
                path.close()
                break
            }
            case 'roundRect':
                path.roundRect(command[1], command[2], command[3], command[4], command[5])
                break
            case 'quadraticCurveTo':
                path.quadratic(command[1], command[2], command[3], command[4])
                break
            case 'bezierCurveTo':
                path.cubic(command[1], command[2], command[3], command[4], command[5], command[6])
                break
            case 'ellipse':
                path.ellipse(
                    command[1],
                    command[2],
                    command[3],
                    command[4],
                    command[5],
                    command[6],
                    command[7],
                    command[8],
                )
                break
            case 'arcTo':
                path.arcTo(command[1], command[2], command[3], command[4], command[5])
                break
            case 'svg': {
                path.append(flatten(parseSvgPath(command[1]).commands, path.tolerance))
                break
            }
            case 'addPath':
                path.append(
                    flatten(command[1].commands, path.tolerance / Math.max(1, scaleOf(command[2]))),
                    command[2],
                )
                break
            case 'transform':
                path.transform(command[1])
                break
        }
    }
    return path.contours
}

const tessellator = new libtess.GluTesselator()
const enums = libtess.gluEnum
tessellator.gluTessNormal(0, 0, 1)
// An edge callback forces independent triangles instead of strips/fans.
tessellator.gluTessCallback(enums.GLU_TESS_EDGE_FLAG, () => {
    /* Only callback presence matters. */
})
tessellator.gluTessCallback(enums.GLU_TESS_VERTEX_DATA, (point: Point, output: number[]) =>
    output.push(point[0], point[1]),
)
tessellator.gluTessCallback(enums.GLU_TESS_COMBINE, (coords) => [coords[0], coords[1]])
tessellator.gluTessCallback(enums.GLU_TESS_ERROR, (error: number) => {
    throw new Error(`Path tessellation failed: ${error}`)
})

/** Union existing contours directly, without flattening or pruning their vertices. */
export function triangulate(
    contours: readonly { points: readonly Point[] }[],
    fillRule: CanvasFillRule,
    resolution?: number,
): Float64Array {
    // An unscaled geometry caller has not supplied a physical error budget.
    // Preserve its double-precision result until the eventual scale is known.
    const accelerated =
        resolution === undefined ? undefined : triangulateLyon(contours, fillRule, resolution)
    if (accelerated) return accelerated
    const output: number[] = []
    tessellator.gluTessProperty(
        enums.GLU_TESS_WINDING_RULE,
        fillRule === 'evenodd'
            ? libtess.windingRule.GLU_TESS_WINDING_ODD
            : libtess.windingRule.GLU_TESS_WINDING_NONZERO,
    )
    tessellator.gluTessBeginPolygon(output)
    for (const contour of contours) {
        if (contour.points.length < 3) continue
        tessellator.gluTessBeginContour()
        for (const p of contour.points) tessellator.gluTessVertex([p[0], p[1], 0], p)
        tessellator.gluTessEndContour()
    }
    tessellator.gluTessEndPolygon()
    return new Float64Array(output)
}

export function tessellateFill(
    path: DrawPath,
    fillRule: CanvasFillRule,
    tolerance: number,
    resolution?: number,
): Float64Array {
    return triangulate(flatten(path.commands, tolerance), fillRule, resolution)
}

function dashed(contour: Contour, pattern: readonly number[], offset: number): Contour[] {
    const dash = pattern.length % 2 ? [...pattern, ...pattern] : pattern
    const total = dash.reduce((a, b) => a + b, 0)
    if (!total) return [contour]
    let phase = ((offset % total) + total) % total
    let index = 0
    while (phase > 0 && phase >= indexed(dash, index)) {
        phase -= indexed(dash, index)
        index = (index + 1) % dash.length
    }
    let remaining = indexed(dash, index) - phase
    const result: Contour[] = []
    let active: Contour | undefined
    const points = contour.closed ? [...contour.points, contour.points[0]] : contour.points
    const beganOn = index % 2 === 0
    for (let i = 1; i < points.length; i++) {
        const a = indexed(points, i - 1),
            b = indexed(points, i)
        const length = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (!length) continue
        let position = 0
        while (position < length) {
            const step = Math.min(remaining, length - position)
            const from: Point = [
                a[0] + ((b[0] - a[0]) * position) / length,
                a[1] + ((b[1] - a[1]) * position) / length,
            ]
            position += step
            const to: Point = [
                a[0] + ((b[0] - a[0]) * position) / length,
                a[1] + ((b[1] - a[1]) * position) / length,
            ]
            if (index % 2 === 0) {
                if (!active) {
                    active = {
                        points: [from],
                        closed: false,
                        tangent: [(b[0] - a[0]) / length, (b[1] - a[1]) / length],
                    }
                    result.push(active)
                }
                if (!same(indexed(active.points, active.points.length - 1), to))
                    active.points.push(to)
            }
            remaining -= step
            if (remaining <= 1e-12) {
                if (index % 2 === 0) active = undefined
                index = (index + 1) % dash.length
                remaining = indexed(dash, index)
                // Zero-length on intervals are visible dots for round/square
                // caps, including a dot exactly at the end of this segment.
                while (!remaining) {
                    if (index % 2 === 0)
                        result.push({
                            points: [to],
                            closed: false,
                            tangent: [(b[0] - a[0]) / length, (b[1] - a[1]) / length],
                        })
                    index = (index + 1) % dash.length
                    remaining = indexed(dash, index)
                }
            }
        }
    }
    if (contour.closed && beganOn && active && result.length) {
        const first = indexed(result, 0)
        if (first === active) first.closed = true
        else {
            first.points = [...active.points, ...first.points.slice(1)]
            result.pop()
        }
    }
    return result
}

/** Build a geometric union of segment bodies, joins and caps. Tessellation of
 * that union applies alpha once even for crossing/overlapping subpaths. */
export function tessellateStroke(
    path: DrawPath,
    options: StrokeOptions,
    tolerance: number,
    resolution?: number,
): Float64Array {
    const outlines: Contour[] = []
    const half = options.width / 2
    if (!(half > 0)) return new Float64Array()
    const polygon = (points: Point[]) => {
        if (points.length < 3) return
        let area = 0
        for (let i = 0; i < points.length; i++) {
            const a = indexed(points, i),
                b = indexed(points, (i + 1) % points.length)
            area += cross(a[0], a[1], b[0], b[1])
        }
        if (area < 0) points.reverse()
        outlines.push({ points: points as Points, closed: true })
    }
    const arc = (center: Point, start: number, sweep: number, omitCenter = false) => {
        const step = Math.min(Math.PI / 2, 2 * Math.acos(Math.max(-1, 1 - tolerance / half)))
        const count = Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(1e-5, step)))
        const points: Point[] = omitCenter ? [] : [center]
        for (let i = 0; i <= count; i++) {
            const a = start + (sweep * i) / count
            points.push([center[0] + half * Math.cos(a), center[1] + half * Math.sin(a)])
        }
        polygon(points)
    }
    const cap = (p: Point, dx: number, dy: number) => {
        // A semicircle's closing chord already supplies its diameter.
        if (options.cap === 'round') arc(p, Math.atan2(dy, dx) - Math.PI / 2, Math.PI, true)
        else if (options.cap === 'square')
            polygon([
                [p[0] - dy * half, p[1] + dx * half],
                [p[0] + dx * half - dy * half, p[1] + dy * half + dx * half],
                [p[0] + dx * half + dy * half, p[1] + dy * half - dx * half],
                [p[0] + dy * half, p[1] - dx * half],
            ])
    }
    for (const source of flatten(path.commands, tolerance)) {
        for (const contour of options.dash.length
            ? dashed(source, options.dash, options.dashOffset)
            : [source]) {
            const points = contour.points
            if (points.length < 2) {
                if (points.length && contour.tangent) {
                    if (options.cap === 'round') arc(points[0], 0, tau)
                    else if (options.cap === 'square') {
                        cap(points[0], ...contour.tangent)
                        cap(points[0], -contour.tangent[0], -contour.tangent[1])
                    }
                }
                continue
            }
            const count = contour.closed ? points.length : points.length - 1
            const directions: Point[] = []
            for (let i = 0; i < count; i++) {
                const a = indexed(points, i),
                    b = indexed(points, (i + 1) % points.length)
                const length = Math.hypot(b[0] - a[0], b[1] - a[1])
                const dx = (b[0] - a[0]) / length,
                    dy = (b[1] - a[1]) / length
                directions.push([dx, dy])
                polygon([
                    [a[0] - dy * half, a[1] + dx * half],
                    [b[0] - dy * half, b[1] + dx * half],
                    [b[0] + dy * half, b[1] - dx * half],
                    [a[0] + dy * half, a[1] - dx * half],
                ])
            }
            const joins = contour.closed ? points.length : points.length - 2
            for (let j = 0; j < joins; j++) {
                const i = contour.closed ? j : j + 1
                const p = indexed(points, i),
                    a = indexed(directions, (i + count - 1) % count),
                    b = indexed(directions, i % count)
                const turn = cross(a[0], a[1], b[0], b[1])
                if (Math.abs(turn) < 1e-12) {
                    if (a[0] * b[0] + a[1] * b[1] < 0 && options.join === 'round') arc(p, 0, tau)
                    continue
                }
                const sign = turn > 0 ? -1 : 1
                const n1: Point = [-a[1] * half * sign, a[0] * half * sign]
                const n2: Point = [-b[1] * half * sign, b[0] * half * sign]
                const p1: Point = [p[0] + n1[0], p[1] + n1[1]],
                    p2: Point = [p[0] + n2[0], p[1] + n2[1]]
                if (options.join === 'round') {
                    let sweep = Math.atan2(n2[1], n2[0]) - Math.atan2(n1[1], n1[0])
                    if (turn > 0 && sweep < 0) sweep += tau
                    if (turn < 0 && sweep > 0) sweep -= tau
                    arc(p, Math.atan2(n1[1], n1[0]), sweep)
                } else if (options.join === 'miter') {
                    const t = cross(n2[0] - n1[0], n2[1] - n1[1], b[0], b[1]) / turn
                    const mx = n1[0] + t * a[0],
                        my = n1[1] + t * a[1]
                    if (Math.hypot(mx, my) <= options.miterLimit * half)
                        polygon([p, p1, [p[0] + mx, p[1] + my], p2])
                    else polygon([p, p1, p2])
                } else polygon([p, p1, p2])
            }
            if (!contour.closed) {
                const first = indexed(directions, 0),
                    last = indexed(directions, directions.length - 1)
                cap(points[0], -first[0], -first[1])
                cap(indexed(points, points.length - 1), last[0], last[1])
            }
        }
    }
    return triangulate(outlines, 'nonzero', resolution)
}
