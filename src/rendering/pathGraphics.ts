import {
    GraphicsContext,
    GraphicsPath,
    Matrix,
    type FillInput,
    type Polygon,
    type StrokeStyle,
} from 'pixi.js'
import { tessellateFill, tessellateStroke, triangulate } from './geometry'
import { maxStrokeStripPoints } from './nativeStrokeStrip'
import { DrawPath, type PathCommand } from './path'
import { PathMeshGeometry } from './pathMesh'
import { parseSvgPath } from './pathSvg'
import { isNativeStrokeStrip, nativeStrokeBoundary, pathTriangles } from './pathTriangles'
import { retainPaint, scalePaint } from './pixiPaint'

type Point = [number, number]
type MatrixValues = Extract<PathCommand, readonly ['transform', unknown]>[1]
type Extras = { dash: readonly number[]; dashOffset: number }
const tau = 2 * Math.PI
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
const at = <T>(items: readonly T[], i: number) => items[i] as T
const matrixFrom = (m: MatrixValues) => new Matrix(m[0], m[3], m[1], m[4], m[2], m[5])
const transformPoint = (p: Point, m: Matrix): Point => [
    m.a * p[0] + m.c * p[1] + m.tx,
    m.b * p[0] + m.d * p[1] + m.ty,
]

function sweepAngle(start: number, end: number, ccw: boolean) {
    const delta = end - start
    if (!ccw && delta >= tau) return tau
    if (ccw && delta <= -tau) return -tau
    const wrapped = delta % tau
    return ccw ? (delta > 0 ? wrapped - tau : wrapped) : delta < 0 ? wrapped + tau : wrapped
}

/** Canvas current-point semantics, producing Pixi's native shape/curve commands. */
class PathWriter {
    readonly path = new GraphicsPath()
    current?: Point
    start?: Point
    closed = false

    move(x: number, y: number) {
        this.path.moveTo(x, y)
        this.current = this.start = [x, y]
        this.closed = false
    }

    private ensure(x: number, y: number) {
        if (!this.current) this.move(x, y)
        else if (this.closed) this.move(...this.current)
    }

    line(x: number, y: number) {
        this.ensure(x, y)
        this.path.lineTo(x, y)
        this.current = [x, y]
    }

    quadratic(cx: number, cy: number, x: number, y: number) {
        this.ensure(cx, cy)
        if (this.current?.[0] === x && this.current[1] === y && cx === x && cy === y) return
        this.path.quadraticCurveTo(cx, cy, x, y, 1 - curveTolerance)
        this.current = [x, y]
    }

    cubic(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
        this.ensure(c1x, c1y)
        if (
            this.current?.[0] === x &&
            this.current[1] === y &&
            c1x === x &&
            c1y === y &&
            c2x === x &&
            c2y === y
        )
            return
        this.path.bezierCurveTo(c1x, c1y, c2x, c2y, x, y, 1 - curveTolerance)
        this.current = [x, y]
    }

    close() {
        if (!this.current || this.closed) return
        this.path.closePath()
        this.current = this.start
        this.closed = true
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
        this.ellipseSweep(x, y, rx, ry, rotation, start, sweepAngle(start, end, ccw))
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
        const point = (angle: number): Point => [
            x + c * rx * Math.cos(angle) - s * ry * Math.sin(angle),
            y + s * rx * Math.cos(angle) + c * ry * Math.sin(angle),
        ]
        const derivative = (angle: number): Point => [
            -c * rx * Math.sin(angle) - s * ry * Math.cos(angle),
            -s * rx * Math.sin(angle) + c * ry * Math.cos(angle),
        ]
        this.line(...point(start))
        if (!sweep || (!rx && !ry)) return
        // Eighth-turn cubic segments keep the analytic ellipse approximation
        // below 0.000005 of its radius; Pixi performs the adaptive tessellation.
        const count = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 4)))
        for (let i = 0; i < count; i++) {
            const a = start + (sweep * i) / count,
                b = start + (sweep * (i + 1)) / count
            const p = point(a),
                q = point(b),
                dp = derivative(a),
                dq = derivative(b)
            const k = (4 / 3) * Math.tan((b - a) / 4)
            this.cubic(p[0] + k * dp[0], p[1] + k * dp[1], q[0] - k * dq[0], q[1] - k * dq[1], ...q)
        }
    }

    arcTo(x1: number, y1: number, x2: number, y2: number, radius: number) {
        if (!this.current) {
            this.move(x1, y1)
            return
        }
        let ax = this.current[0] - x1,
            ay = this.current[1] - y1,
            bx = x2 - x1,
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
        const turn = ax * by - ay * bx
        if (Math.abs(turn) < 1e-14) {
            this.line(x1, y1)
            return
        }
        const distance =
            radius / Math.tan(Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by))) / 2)
        const tx = x1 + ax * distance,
            ty = y1 + ay * distance,
            sign = turn < 0 ? -1 : 1
        const cx = tx - ay * radius * sign,
            cy = ty + ax * radius * sign
        this.ellipse(
            cx,
            cy,
            radius,
            radius,
            0,
            Math.atan2(ty - cy, tx - cx),
            Math.atan2(y1 + by * distance - cy, x1 + bx * distance - cx),
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
        const normalized = radii.map((r): Point => {
            const rx = typeof r === 'number' ? r : (r.x ?? 0),
                ry = typeof r === 'number' ? r : (r.y ?? 0)
            return rx && ry ? [rx, ry] : [0, 0]
        })
        const a = normalized[0] ?? [0, 0],
            b = normalized[1] ?? a,
            c = normalized[2] ?? a,
            d = normalized[3] ?? b
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
        const fit = (size: number, radius: number) => (radius ? size / radius : 1)
        const scale = Math.min(
            1,
            fit(w, tl[0] + tr[0]),
            fit(w, bl[0] + br[0]),
            fit(h, tl[1] + bl[1]),
            fit(h, tr[1] + br[1]),
        )
        ;[tl, tr, br, bl] = [tl, tr, br, bl].map(([rx, ry]): Point => [rx * scale, ry * scale]) as [
            Point,
            Point,
            Point,
            Point,
        ]
        const r = x + w,
            bottom = y + h,
            half = Math.PI / 2
        this.move(x + tl[0], y)
        if (reverse) {
            this.ellipseSweep(x + tl[0], y + tl[1], ...tl, 0, -half, -half)
            this.line(x, bottom - bl[1])
            this.ellipseSweep(x + bl[0], bottom - bl[1], ...bl, 0, Math.PI, -half)
            this.line(r - br[0], bottom)
            this.ellipseSweep(r - br[0], bottom - br[1], ...br, 0, half, -half)
            this.line(r, y + tr[1])
            this.ellipseSweep(r - tr[0], y + tr[1], ...tr, 0, 0, -half)
        } else {
            this.line(r - tr[0], y)
            this.ellipseSweep(r - tr[0], y + tr[1], ...tr, 0, -half, half)
            this.line(r, bottom - br[1])
            this.ellipseSweep(r - br[0], bottom - br[1], ...br, 0, 0, half)
            this.line(x + bl[0], bottom)
            this.ellipseSweep(x + bl[0], bottom - bl[1], ...bl, 0, half, half)
            this.line(x, y + tl[1])
            this.ellipseSweep(x + tl[0], y + tl[1], ...tl, 0, Math.PI, half)
        }
        this.close()
        this.move(x, y)
    }

    transform(matrix: Matrix) {
        // Pixi's generic transform has incomplete arc/ellipse handling. All
        // curved contours here are Beziers; primitive ellipse matrices are
        // composed explicitly at the documented argument position instead.
        for (const instruction of this.path.instructions) {
            const data = instruction.data as number[]
            if (instruction.action === 'ellipse') {
                const args = instruction.data as [number, number, number, number, Matrix?]
                args[4] = args[4] ? matrix.clone().append(args[4]) : matrix.clone()
            } else if (instruction.action === 'addPath') {
                const child = instruction.data[0] as GraphicsPath
                const holder = new PathWriter()
                holder.path.instructions = child.clone(true).instructions
                holder.transform(matrix)
                instruction.data[0] = holder.path
            } else if (instruction.action !== 'closePath') {
                const n =
                    instruction.action === 'bezierCurveTo'
                        ? 6
                        : instruction.action === 'quadraticCurveTo'
                          ? 4
                          : 2
                for (let i = 0; i < n; i += 2) {
                    const x = at(data, i),
                        y = at(data, i + 1)
                    data[i] = matrix.a * x + matrix.c * y + matrix.tx
                    data[i + 1] = matrix.b * x + matrix.d * y + matrix.ty
                }
            }
        }
        if (this.current) this.current = transformPoint(this.current, matrix)
        if (this.start) this.start = transformPoint(this.start, matrix)
    }

    append(child: PathWriter, matrix?: Matrix) {
        if (!child.path.instructions.length) return
        if (matrix) child.transform(matrix)
        this.path.addPath(child.path)
        if (child.current) {
            this.current = child.current
            this.start = child.start
            this.closed = child.closed
        }
    }

    resolution(scale: number) {
        // Curve coordinates must be scaled BEFORE native flattening, while
        // ellipse radii must be scaled BEFORE the native perimeter is built.
        for (const instruction of this.path.instructions) {
            if (instruction.action === 'ellipse') {
                const args = instruction.data as [number, number, number, number, Matrix?]
                for (let i = 0; i < 4; i++) args[i] = (args[i] as number) * scale
                if (args[4]) {
                    args[4].tx *= scale
                    args[4].ty *= scale
                }
            } else if (instruction.action === 'addPath') {
                const child = new PathWriter()
                child.path.instructions = (instruction.data[0] as GraphicsPath).instructions
                child.resolution(scale)
            } else if (instruction.action !== 'closePath') {
                const count =
                    instruction.action === 'bezierCurveTo'
                        ? 6
                        : instruction.action === 'quadraticCurveTo'
                          ? 4
                          : 2
                const data = instruction.data as number[]
                for (let i = 0; i < count; i++) data[i] = at(data, i) * scale
            }
        }
    }
}

function writerFor(source: DrawPath, primitive = true): PathWriter {
    const result = new PathWriter()
    const commands = source.commands
    if (primitive && commands.length === 1 && commands[0]?.[0] === 'ellipse') {
        const [, x, y, rx, ry, rotation, start, end, ccw] = commands[0]
        if (rx > 0 && ry > 0 && rotation === 0 && Math.abs(sweepAngle(start, end, ccw)) === tau) {
            const c = Math.cos(rotation),
                s = Math.sin(rotation)
            // Bake the center directly. Pixi applies a primitive transform to
            // global-gradient UVs as well as vertices; rotated ellipses use the
            // ordinary baked cubic route below to keep user-space paint fixed.
            result.path.ellipse(x, y, rx, ry)
            result.current = result.start = [
                x + c * rx * Math.cos(start) - s * ry * Math.sin(start),
                y + s * rx * Math.cos(start) + c * ry * Math.sin(start),
            ]
            result.closed = true
            return result
        }
    }
    for (const command of commands) {
        switch (command[0]) {
            case 'moveTo':
                result.move(command[1], command[2])
                break
            case 'lineTo':
                result.line(command[1], command[2])
                break
            case 'closePath':
                result.close()
                break
            case 'quadraticCurveTo':
                result.quadratic(command[1], command[2], command[3], command[4])
                break
            case 'bezierCurveTo':
                result.cubic(command[1], command[2], command[3], command[4], command[5], command[6])
                break
            case 'ellipse':
                result.ellipse(
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
                result.arcTo(command[1], command[2], command[3], command[4], command[5])
                break
            case 'rect': {
                const [, x, y, w, h] = command
                result.move(x, y)
                result.line(x + w, y)
                result.line(x + w, y + h)
                result.line(x, y + h)
                result.close()
                break
            }
            case 'roundRect':
                result.roundRect(command[1], command[2], command[3], command[4], command[5])
                break
            case 'svg':
                result.append(writerFor(parseSvgPath(command[1]), false))
                break
            case 'addPath':
                result.append(writerFor(command[1], false), matrixFrom(command[2]))
                break
            case 'transform':
                result.transform(matrixFrom(command[1]))
                break
        }
    }
    return result
}

export function compilePath(path: DrawPath, resolution = 1): GraphicsPath {
    const writer = writerFor(path)
    writer.resolution(resolution)
    refineLargeCurves(writer.path)
    return writer.path
}

/** Keep native adaptive subdivision away from Pixi's eight-level recursion cap. */
function refineLargeCurves(path: GraphicsPath, state: { current?: Point; start?: Point } = {}) {
    const refined: typeof path.instructions = []
    const straight = (a: Point, controls: Point[], end: Point) => {
        const dx = end[0] - a[0],
            dy = end[1] - a[1],
            length2 = dx * dx + dy * dy
        let previous = 0
        for (const point of controls) {
            const x = point[0] - a[0],
                y = point[1] - a[1]
            const projected = x * dx + y * dy
            if (x * dy !== y * dx || projected < previous || projected > length2) return false
            previous = projected
        }
        return !!length2
    }
    const quadratic = (a: Point, b: Point, c: Point, depth = 0) => {
        if (straight(a, [b], c)) refined.push({ action: 'lineTo', data: [...c] })
        else if (depth < 12 && Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1]) > 1024) {
            const ab: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
            const bc: Point = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]
            const mid: Point = [(ab[0] + bc[0]) / 2, (ab[1] + bc[1]) / 2]
            quadratic(a, ab, mid, depth + 1)
            quadratic(mid, bc, c, depth + 1)
        } else refined.push({ action: 'quadraticCurveTo', data: [...b, ...c, 1 - curveTolerance] })
    }
    const cubic = (a: Point, b: Point, c: Point, d: Point, depth = 0) => {
        const curvature = Math.max(
            Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1]),
            Math.hypot(b[0] - 2 * c[0] + d[0], b[1] - 2 * c[1] + d[1]),
        )
        if (straight(a, [b, c], d)) refined.push({ action: 'lineTo', data: [...d] })
        else if (depth < 12 && curvature > 1024) {
            const ab: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
            const bc: Point = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]
            const cd: Point = [(c[0] + d[0]) / 2, (c[1] + d[1]) / 2]
            const abc: Point = [(ab[0] + bc[0]) / 2, (ab[1] + bc[1]) / 2]
            const bcd: Point = [(bc[0] + cd[0]) / 2, (bc[1] + cd[1]) / 2]
            const mid: Point = [(abc[0] + bcd[0]) / 2, (abc[1] + bcd[1]) / 2]
            cubic(a, ab, abc, mid, depth + 1)
            cubic(mid, bcd, cd, d, depth + 1)
        } else
            refined.push({ action: 'bezierCurveTo', data: [...b, ...c, ...d, 1 - curveTolerance] })
    }
    for (const instruction of path.instructions) {
        const data = instruction.data as number[]
        if (instruction.action === 'quadraticCurveTo') {
            const control: Point = [at(data, 0), at(data, 1)]
            const end: Point = [at(data, 2), at(data, 3)]
            quadratic(state.current ?? control, control, end)
            state.current = end
        } else if (instruction.action === 'bezierCurveTo') {
            const first: Point = [at(data, 0), at(data, 1)]
            const second: Point = [at(data, 2), at(data, 3)]
            const end: Point = [at(data, 4), at(data, 5)]
            cubic(state.current ?? first, first, second, end)
            state.current = end
        } else {
            if (instruction.action === 'moveTo')
                state.start = state.current = [at(data, 0), at(data, 1)]
            else if (instruction.action === 'lineTo') state.current = [at(data, 0), at(data, 1)]
            else if (instruction.action === 'closePath') state.current = state.start
            else if (instruction.action === 'addPath')
                refineLargeCurves(instruction.data[0] as GraphicsPath, state)
            refined.push(instruction)
        }
    }
    path.instructions = refined
}

function selfIntersects(points: readonly number[], closed: boolean) {
    const count = points.length / 2
    if (!closed) {
        // A strictly monotone coordinate rules out non-adjacent centerline
        // intersections. This does not bypass wide-stroke overlap checks below.
        for (const axis of [0, 1]) {
            let direction = 0,
                monotone = true
            for (let i = 1; i < count; i++) {
                const delta = at(points, 2 * i + axis) - at(points, 2 * (i - 1) + axis)
                const sign = Math.sign(delta)
                if (!Number.isFinite(delta) || !sign || (direction && sign !== direction)) {
                    monotone = false
                    break
                }
                direction = sign
            }
            if (monotone) return false
        }
    }
    const segments = closed ? count : count - 1
    const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx
    for (let i = 0; i < segments; i++) {
        const next = (i + 1) % count
        const ax = at(points, 2 * i),
            ay = at(points, 2 * i + 1),
            bx = at(points, 2 * next),
            by = at(points, 2 * next + 1)
        for (let j = i + 2; j < segments; j++) {
            if (closed && i === 0 && j === count - 1) continue
            const jn = (j + 1) % count
            const cx = at(points, 2 * j),
                cy = at(points, 2 * j + 1),
                dx = at(points, 2 * jn),
                dy = at(points, 2 * jn + 1)
            if (
                Math.max(ax, bx) < Math.min(cx, dx) ||
                Math.max(cx, dx) < Math.min(ax, bx) ||
                Math.max(ay, by) < Math.min(cy, dy) ||
                Math.max(cy, dy) < Math.min(ay, by)
            )
                continue
            const p = cross(bx - ax, by - ay, cx - ax, cy - ay),
                q = cross(bx - ax, by - ay, dx - ax, dy - ay)
            const r = cross(dx - cx, dy - cy, ax - cx, ay - cy),
                s = cross(dx - cx, dy - cy, bx - cx, by - cy)
            // Non-adjacent touches/retracing are also compound topology. Earcut
            // does not implement the Canvas winding cancellation for them.
            if (p * q <= 0 && r * s <= 0) return true
        }
    }
    return false
}

function needsCompoundFallback(path: GraphicsPath, strokeWidth: number, strokeReach = strokeWidth) {
    const shapes = path.shapePath.shapePrimitives
    // These paths need one coverage union regardless of centerline topology.
    // Reject them before quadratic pair scans of their flattened curves.
    if (compoundBoundsOverlap(shapes, strokeReach)) return true
    for (const { shape, transform } of shapes) {
        if (shape.type === 'polygon') {
            const polygon = shape as Polygon
            if (selfIntersects(polygon.points, !strokeWidth || polygon.closePath)) return true
            if (strokeWidth) {
                const p = polygon.points,
                    count = p.length / 2
                const first = polygon.closePath ? 0 : 1,
                    last = polygon.closePath ? count : count - 1
                for (let i = first; i < last; i++) {
                    const before = (i + count - 1) % count,
                        after = (i + 1) % count
                    const ax = at(p, 2 * i) - at(p, 2 * before),
                        ay = at(p, 2 * i + 1) - at(p, 2 * before + 1)
                    const bx = at(p, 2 * after) - at(p, 2 * i),
                        by = at(p, 2 * after + 1) - at(p, 2 * i + 1)
                    // Pixi's segment bodies overlap at a sharp reversal; one
                    // coverage union is needed for translucent hairpin strokes.
                    if (ax * bx + ay * by < 0) return true
                }
                // Turns beyond 90 degrees already require union above. Every
                // remaining miter (and a diagonal square cap) lies within
                // sqrt(2) half-widths, including protrusions inside one contour.
                if (
                    strokeSegmentsOverlap(
                        p,
                        polygon.closePath,
                        Math.min(strokeReach, Math.SQRT2 * strokeWidth),
                        transform,
                    )
                )
                    return true
            }
        }
    }
    return false
}

function strokeSegmentsOverlap(
    points: number[],
    closed: boolean,
    radius: number,
    transform?: Matrix,
) {
    const count = points.length / 2,
        segmentCount = closed ? count : count - 1
    if (segmentCount < (closed ? 4 : 3)) return false
    type Segment = {
        index: number
        ax: number
        ay: number
        bx: number
        by: number
        left: number
        right: number
        top: number
        bottom: number
    }
    const segments: Segment[] = []
    const point = (i: number): Point => {
        const p: Point = [at(points, i * 2), at(points, i * 2 + 1)]
        return transform ? transformPoint(p, transform) : p
    }
    for (let i = 0; i < segmentCount; i++) {
        const [ax, ay] = point(i),
            [bx, by] = point((i + 1) % count)
        segments.push({
            index: i,
            ax,
            ay,
            bx,
            by,
            left: Math.min(ax, bx) - radius,
            right: Math.max(ax, bx) + radius,
            top: Math.min(ay, by) - radius,
            bottom: Math.max(ay, by) + radius,
        })
    }
    segments.sort((a, b) => a.top - b.top)
    const active: Segment[] = []
    const widthSquared = (2 * radius) ** 2
    const distanceSquared = (x: number, y: number, segment: Segment) => {
        const dx = segment.bx - segment.ax,
            dy = segment.by - segment.ay,
            length = dx * dx + dy * dy
        const t = length
            ? Math.max(0, Math.min(1, ((x - segment.ax) * dx + (y - segment.ay) * dy) / length))
            : 0
        return (x - segment.ax - t * dx) ** 2 + (y - segment.ay - t * dy) ** 2
    }
    let work = 100000
    for (const segment of segments) {
        let kept = 0
        for (const previous of active) {
            if (--work < 0) return true
            if (previous.bottom < segment.top) continue
            active[kept++] = previous
            const apart = Math.abs(previous.index - segment.index)
            if (apart === 1 || (closed && apart === segmentCount - 1)) continue
            if (previous.right < segment.left || segment.right < previous.left) continue
            // selfIntersects has already rejected crossing centerlines. The
            // minimum distance is therefore attained by at least one endpoint.
            // Nonadjacent stroke bands, caps or miters can still overlap even
            // though no centerline crosses and neither local turn reverses.
            if (
                Math.min(
                    distanceSquared(segment.ax, segment.ay, previous),
                    distanceSquared(segment.bx, segment.by, previous),
                    distanceSquared(previous.ax, previous.ay, segment),
                    distanceSquared(previous.bx, previous.by, segment),
                ) <= widthSquared
            )
                return true
        }
        active.length = kept
        active.push(segment)
    }
    return false
}

function compoundBoundsOverlap(
    shapes: GraphicsPath['shapePath']['shapePrimitives'],
    strokeWidth: number,
) {
    if (shapes.length < 2) return false
    // Pixi fills each shape independently. Intersecting bounds conservatively
    // identify holes/overlapping contours requiring one Canvas coverage union.
    const bounds = shapes.map(({ shape, transform }) => {
        const b = shape.getBounds()
        const corners: Point[] = [
            [b.x, b.y],
            [b.x + b.width, b.y],
            [b.x, b.y + b.height],
            [b.x + b.width, b.y + b.height],
        ]
        const p = transform ? corners.map((p) => transformPoint(p, transform)) : corners
        return [
            Math.min(...p.map((p) => p[0])) - strokeWidth,
            Math.min(...p.map((p) => p[1])) - strokeWidth,
            Math.max(...p.map((p) => p[0])) + strokeWidth,
            Math.max(...p.map((p) => p[1])) + strokeWidth,
        ]
    })
    for (let i = 0; i < bounds.length; i++)
        for (let j = i + 1; j < bounds.length; j++) {
            const a = at(bounds, i),
                b = at(bounds, j)
            if (
                at(a, 0) < at(b, 2) &&
                at(b, 0) < at(a, 2) &&
                at(a, 1) < at(b, 3) &&
                at(b, 1) < at(a, 3)
            )
                return true
        }
    return false
}

type CachedPath = {
    commands: readonly PathCommand[]
    resolution: number
    length: number
    last: PathCommand | undefined
    path: GraphicsPath
    styles: Map<string, Entry>
}
export type PathGraphicsResource = GraphicsContext | PathMeshGeometry
type Entry = {
    context: PathGraphicsResource
    bytes: number
    frame: number
    owner: CachedPath
    key: string
    pins: number
    accessed: number
    evictableIndex: number
    frameOnly: boolean
}

/**
 * Charge public compiled shapes, not a fixed 64 vertices for every ellipse.
 * Numeric arrays use 8-byte JS numbers; coefficients cover vertices, UVs,
 * indices, duplicate flattened contours and spare array capacity. Each context
 * and shape also pays object/instruction overhead. Shared renderer batch buffers
 * are measured separately and must not be charged once per GraphicsContext.
 */
function estimateContextBytes(context: GraphicsContext, commands: number, key: string) {
    let bytes = 768 + commands * 48 + key.length * 2
    for (const instruction of context.instructions) {
        if (instruction.action !== 'fill' && instruction.action !== 'stroke') continue
        const stroke = instruction.action === 'stroke'
        const style = instruction.data.style as StrokeStyle
        for (const { shape } of instruction.data.path.shapePath.shapePrimitives) {
            const polygon = shape.type === 'polygon' ? (shape as Polygon) : undefined
            // This is Pixi's public ellipse builder's radius-dependent count.
            // Shape transforms are applied after that geometry is generated.
            let count = polygon ? polygon.points.length / 2 : 0
            if (!polygon) {
                const bounds = shape.getBounds()
                count = 4 * Math.ceil(2.3 * Math.sqrt((bounds.width + bounds.height) / 2))
            }
            bytes += 192 + count * (stroke ? (polygon ? 224 : 160) : polygon ? 112 : 80)
            if (!stroke || !polygon) continue
            const p = polygon.points,
                radius = Math.sqrt((style.width ?? 1) / 2)
            if (!polygon.closePath && style.cap === 'round') {
                bytes += (4 * (Math.floor(15 * radius) + 1) + 4) * 64
            }
            if (style.join !== 'round' || count < 3) continue
            const first = polygon.closePath ? 0 : 1,
                last = polygon.closePath ? count : count - 1
            for (let i = first; i < last; i++) {
                const before = (i + count - 1) % count,
                    after = (i + 1) % count
                const ax = at(p, 2 * i) - at(p, 2 * before),
                    ay = at(p, 2 * i + 1) - at(p, 2 * before + 1)
                const bx = at(p, 2 * after) - at(p, 2 * i),
                    by = at(p, 2 * after + 1) - at(p, 2 * i + 1)
                const length = Math.hypot(ax, ay) * Math.hypot(bx, by)
                if (!length) continue
                const angle = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / length)))
                if (angle < 1e-5) continue
                const segments = Math.floor((15 * angle * radius) / Math.PI) + 1
                bytes += (2 + 2 * segments) * 64
            }
        }
    }
    return bytes
}

function estimateMeshBytes(
    mesh: PathMeshGeometry,
    path: GraphicsPath,
    commands: number,
    key: string,
) {
    // Owned typed buffers are exact. The original compiled path is retained for
    // classification/style variants; include its public flattened geometry and
    // instruction metadata, conservatively charging shared data per resource.
    let bytes = 1536 + commands * 48 + key.length * 2
    bytes += mesh.positions.byteLength + mesh.uvs.byteLength + mesh.indices.byteLength
    bytes += path.instructions.length * 96
    for (const { shape } of path.shapePath.shapePrimitives) {
        bytes += 192
        if (shape.type === 'polygon') bytes += (shape as Polygon).points.length * 16
    }
    return bytes
}

/** The native fill selector admits only simple polygons or convex primitives. */
function emptyNativeFill(path: GraphicsPath) {
    return path.shapePath.shapePrimitives.every(({ shape, transform }) => {
        if (transform) {
            const positive = transform.a * transform.d,
                negative = transform.b * transform.c
            if (Number.isFinite(positive) && positive === negative) return true
        }
        if (shape.type !== 'polygon') {
            const bounds = shape.getBounds()
            return !bounds.width || !bounds.height
        }
        const points = (shape as Polygon).points
        if (points.length < 6) return true
        const x = at(points, 0),
            y = at(points, 1)
        let area = 0
        // Rebase before multiplying so a narrow nonempty shape far along the
        // timeline is not lost to cancellation of its absolute coordinates.
        for (let i = 2; i + 3 < points.length; i += 2)
            area +=
                (at(points, i) - x) * (at(points, i + 3) - y) -
                (at(points, i + 1) - y) * (at(points, i + 2) - x)
        return area === 0
    })
}

/** Per-renderer, retained native Pixi geometry. Frame pins prevent mid-render eviction. */
export class PathGraphicsCache {
    private paths = new WeakMap<readonly PathCommand[], Map<number, CachedPath>>()
    private readonly entries = new Set<Entry>()
    // Only unpinned entries from earlier frames enter this LRU min-heap.
    // Scene pins can expire in any order, so append-only eviction queues would
    // evict newer geometry before an older entry whose last pin just expired.
    private readonly evictable: Entry[] = []
    private readonly touched: Entry[] = []
    private readonly overflow = new Set<Entry>()
    // Geometry of paths no later frame draws again. It is released at the
    // first frame boundary that finds it unpinned, and never enters the LRU.
    private readonly frameOnly: Entry[] = []
    private contexts = new WeakMap<PathGraphicsResource, Entry>()
    private empty = new WeakSet<PathGraphicsResource>()
    private bytes = 0
    private protectedBytes = 0
    private frame = 0
    private access = 0
    // `access` at the last chart switch: entries last drawn before it are released
    // like frame-only ones, once unpinned.
    private switchedAt = 0
    readonly stats = {
        hits: 0,
        native: 0,
        fallback: 0,
        evictions: 0,
        // Evictions to fit the budget, and their bytes.
        trimmed: 0,
        trimmedBytes: 0,
        maskHits: 0,
        maskBuilt: 0,
        maskDeclined: 0,
        maskEmpty: 0,
    }

    // The measured dense 1000x2400 chart needs 19.35 MB after device-resolution
    // tessellation. 24 MiB retains that set with room for live/grid geometry;
    // smaller viewports allocate only their actual working set.
    constructor(private readonly maxBytes = 24 * 1024 * 1024) {}

    get retainedBytes() {
        return this.bytes
    }

    get pinnedBytes() {
        return this.protectedBytes
    }

    /** Empty fills must not enter Pixi's native batch pipe (which can reuse stale data). */
    isEmpty(resource: PathGraphicsResource) {
        return resource instanceof PathMeshGeometry
            ? resource.indices.length === 0
            : this.empty.has(resource)
    }

    /** Retained scene nodes may pin resident geometry within the same budget. */
    pin(contexts: Iterable<PathGraphicsResource>): (() => void) | undefined {
        const entries = new Set<Entry>()
        let additional = 0
        for (const context of contexts) {
            const entry = this.contexts.get(context)
            // Overflow belongs only to the current frame. Declining capture
            // avoids promoting a scene whose retained working set cannot fit.
            if (!entry || !this.entries.has(entry)) return
            if (entries.has(entry)) continue
            entries.add(entry)
            if (!entry.pins) additional += entry.bytes
        }
        if (this.protectedBytes + additional > this.maxBytes) return
        for (const entry of entries) {
            entry.pins++
            this.removeEvictable(entry)
        }
        this.protectedBytes += additional
        let active = true
        return () => {
            if (!active) return
            active = false
            for (const entry of entries) {
                if (!entry.pins) continue // The entire cache may have been destroyed.
                if (!--entry.pins) {
                    this.protectedBytes -= entry.bytes
                    if (this.stale(entry)) this.frameOnly.push(entry)
                    else if (entry.frame !== this.frame && this.entries.has(entry))
                        this.addEvictable(entry)
                }
            }
        }
    }

    beginFrame() {
        // The caller has detached all previous-frame Graphics before this call.
        // Overflow geometry is needed only until that frame has been rendered.
        for (const entry of this.overflow) {
            this.release(entry)
        }
        this.overflow.clear()
        // An entry drawn again since the switch is no longer stale; `touched` holds it.
        for (const entry of this.frameOnly) if (!entry.pins && this.stale(entry)) this.drop(entry)
        this.frameOnly.length = 0
        this.frame++
        // Visit only resources used by the preceding frame. The large retained
        // scene working set does not need reordering or scanning on each draw.
        for (const entry of this.touched) {
            if (entry.pins) continue
            if (this.stale(entry)) this.drop(entry)
            else this.addEvictable(entry)
        }
        this.touched.length = 0
    }

    /**
     * Another chart was installed: release the geometry no frame since has drawn. Pinned and
     * queued entries stay; each goes at the first frame boundary that finds it unpinned, unless
     * a draw has used it again by then.
     */
    releaseUnused() {
        this.switchedAt = this.access
        for (let entry = this.evictable[0]; entry; entry = this.evictable[0]) this.drop(entry)
    }

    private stale(entry: Entry) {
        return entry.frameOnly || entry.accessed <= this.switchedAt
    }

    private drop(entry: Entry) {
        // An entry can be listed twice; the first release removes it.
        if (!this.entries.delete(entry)) return
        this.bytes -= entry.bytes
        this.release(entry)
    }

    /** `frameOnly`: no later frame draws this path, as with a context's current path. */
    get(
        path: DrawPath,
        style: FillInput | StrokeStyle,
        stroke: boolean,
        rule: CanvasFillRule,
        styleKey: string,
        extras: Extras = { dash: [], dashOffset: 0 },
        resolution = 1,
        frameOnly = false,
    ): PathGraphicsResource {
        const owner = this.ownerFor(path, resolution)
        const commands = path.commands
        const key = `${stroke ? 's' : 'f'}:${rule}:${styleKey}:${extras.dashOffset}:${extras.dash.join(',')}`
        const cached = this.cached(owner, key)
        if (cached) return cached
        let context: PathGraphicsResource
        const strokeStyle = style as StrokeStyle
        const paint = scalePaint(style, resolution)
        // Event connections use one/two quadratics. Their nearby flattened
        // segments often trigger the conservative general union selector.
        // Prove the actual native triangles disjoint before using that route.
        if (
            stroke &&
            style &&
            typeof style === 'object' &&
            typeof strokeStyle.color === 'number' &&
            !('fill' in style) &&
            !('texture' in style) &&
            !strokeStyle.pixelLine &&
            (strokeStyle.alignment === undefined || strokeStyle.alignment === 0.5) &&
            (strokeStyle.cap ?? 'butt') === 'butt' &&
            (strokeStyle.join ?? 'miter') === 'miter' &&
            !extras.dash.length &&
            (commands.length === 2 || commands.length === 3) &&
            commands[0]?.[0] === 'moveTo' &&
            commands[1]?.[0] === 'quadraticCurveTo' &&
            (commands.length === 2 || commands[2]?.[0] === 'quadraticCurveTo')
        ) {
            const primitives = owner.path.shapePath.shapePrimitives
            const primitive = primitives[0]
            if (
                primitives.length === 1 &&
                primitive &&
                !primitive.transform &&
                primitive.shape.type === 'polygon'
            ) {
                const polygon = primitive.shape as Polygon
                if (!polygon.closePath && polygon.points.length <= maxStrokeStripPoints * 2) {
                    const native = new GraphicsContext()
                        .path(owner.path)
                        .stroke(paint as StrokeStyle)
                    let certified = false
                    try {
                        certified = isNativeStrokeStrip(native, polygon.points.length / 2)
                    } finally {
                        if (!certified) native.destroy()
                    }
                    if (certified) {
                        this.stats.native++
                        retainPaint(native, paint)
                        return this.store(native, owner, key, frameOnly)
                    }
                }
            }
        }
        const halfWidth = stroke ? ((strokeStyle.width ?? 1) * resolution) / 2 : 0
        const strokeReach =
            halfWidth *
            Math.max(
                strokeStyle.join === 'miter' || strokeStyle.join === undefined
                    ? Math.max(1, strokeStyle.miterLimit ?? 10)
                    : 1,
                strokeStyle.cap === 'square' ? Math.SQRT2 : 1,
            )
        const fallback =
            (stroke &&
                (extras.dash.some((v) => v > 0) ||
                    (strokeStyle.cap === 'square' &&
                        commands.length === 1 &&
                        commands[0]?.[0] === 'ellipse'))) ||
            needsCompoundFallback(owner.path, halfWidth, strokeReach)
        if (fallback) {
            this.stats.fallback++
            const triangles = stroke
                ? tessellateStroke(
                      path,
                      {
                          width: strokeStyle.width ?? 1,
                          cap: strokeStyle.cap ?? 'butt',
                          join: strokeStyle.join ?? 'miter',
                          miterLimit: strokeStyle.miterLimit ?? 10,
                          dash: extras.dash,
                          dashOffset: extras.dashOffset,
                      },
                      curveTolerance / resolution,
                      resolution,
                  )
                : tessellateFill(path, rule, curveTolerance / resolution, resolution)
            const mesh = PathMeshGeometry.supports(paint)
                ? new PathMeshGeometry(triangles, paint, resolution)
                : undefined
            // The bucket bounds effective device stretch to one. Very large
            // local extents can still lose Float32 precision despite rebasing;
            // keep the previous double-coordinate route in that rare case.
            if (mesh && mesh.positionError <= curveTolerance / 4) context = mesh
            else {
                mesh?.destroy()
                const trianglesPath = new GraphicsPath()
                for (let i = 0; i < triangles.length; i += 6)
                    trianglesPath.poly(
                        Array.from(triangles.subarray(i, i + 6), (value) => value * resolution),
                        true,
                    )
                context = new GraphicsContext().path(trianglesPath).fill(paint)
                if (!triangles.length) this.empty.add(context)
            }
        } else {
            this.stats.native++
            context = new GraphicsContext()
            context.path(owner.path)
            if (stroke) {
                context.stroke(paint as StrokeStyle)
                // A point-like stroke's cap behavior belongs to Pixi. Probe
                // only these degenerate candidates, preserving nonempty round
                // caps without duplicating ordinary stroke tessellation.
                if (
                    owner.path.shapePath.shapePrimitives.every(({ shape }) => {
                        if (shape.type === 'polygon') {
                            const points = (shape as Polygon).points
                            for (let i = 2; i < points.length; i += 2)
                                if (points[i] !== points[0] || points[i + 1] !== points[1])
                                    return false
                            return true
                        }
                        const bounds = shape.getBounds()
                        return !bounds.width && !bounds.height
                    }) &&
                    pathTriangles(context, 0)?.length === 0
                )
                    this.empty.add(context)
            } else {
                context.fill(paint)
                if (emptyNativeFill(owner.path)) this.empty.add(context)
            }
        }
        retainPaint(context, paint)
        return this.store(context, owner, key, frameOnly)
    }

    /** Two sampled fake-marker lines share one painted union, including their crossing. */
    getFakeMarkerStroke(
        path: DrawPath,
        style: StrokeStyle,
        styleKey: string,
        extras: Extras = { dash: [], dashOffset: 0 },
        resolution = 1,
    ): PathGraphicsResource {
        const owner = this.ownerFor(path, resolution)
        const key = `s:nonzero:${styleKey}:${extras.dashOffset}:${extras.dash.join(',')}`
        const cached = this.cached(owner, key)
        if (cached) return cached
        const fallback = () => this.get(path, style, true, 'nonzero', styleKey, extras, resolution)
        const commands = path.commands
        if (
            typeof style.color !== 'number' ||
            'fill' in style ||
            'texture' in style ||
            style.pixelLine ||
            (style.alignment !== undefined && style.alignment !== 0.5) ||
            (style.cap ?? 'butt') !== 'butt' ||
            (style.join ?? 'miter') !== 'miter' ||
            extras.dash.length ||
            commands.filter((command) => command[0] === 'moveTo').length !== 2 ||
            commands.some((command) => command[0] !== 'moveTo' && command[0] !== 'lineTo')
        )
            return fallback()
        const primitives = owner.path.shapePath.shapePrimitives
        if (
            primitives.length !== 2 ||
            primitives.some(
                ({ shape, transform }) =>
                    !!transform ||
                    shape.type !== 'polygon' ||
                    (shape as Polygon).closePath ||
                    (shape as Polygon).points.length > maxStrokeStripPoints * 2,
            )
        )
            return fallback()
        const paint = scalePaint(style, resolution) as StrokeStyle
        const contours: { points: [number, number][] }[] = []
        for (const { shape } of primitives) {
            const points = (shape as Polygon).points
            const native = new GraphicsContext().poly(points, false).stroke(paint)
            let boundary: [number, number][] | undefined
            try {
                boundary = nativeStrokeBoundary(native, points.length / 2)
            } finally {
                native.destroy()
            }
            if (!boundary) return fallback()
            contours.push({ points: boundary })
        }
        // Native points and paint already use compiled units. Passing these
        // boundaries through DrawPath/flatten would prune very short edges.
        // At the maximum bucket resolutionScale may have clamped a larger
        // device stretch, so keep JS when its precision cannot be bounded.
        const compiledResolution = resolution < 2 ** 16 ? 1 : undefined
        const mesh = new PathMeshGeometry(
            triangulate(contours, 'nonzero', compiledResolution),
            paint,
            1,
        )
        if (!(mesh.positionError <= curveTolerance / 4)) {
            mesh.destroy()
            return fallback()
        }
        this.stats.fallback++
        retainPaint(mesh, paint)
        return this.store(mesh, owner, key)
    }

    /**
     * Native geometry for an undashed connector's coverage mask. Overlapping
     * triangles are intentional: the stencil mask unions their samples before
     * the connector's already-unioned fill is painted once through it.
     */
    getStrokeMask(
        path: DrawPath,
        style: Pick<StrokeStyle, 'width' | 'cap' | 'join' | 'miterLimit'>,
        extras: Extras = { dash: [], dashOffset: 0 },
        resolution = 1,
    ): GraphicsContext | undefined {
        const width = style.width ?? 1
        const cap = style.cap ?? 'butt'
        const join = style.join ?? 'miter'
        const miterLimit = style.miterLimit ?? 10
        if (
            extras.dash.length ||
            (cap === 'square' && path.commands.length === 1 && path.commands[0]?.[0] === 'ellipse')
        ) {
            this.stats.maskDeclined++
            return
        }
        const owner = this.ownerFor(path, resolution)
        // Paint and undashed offsets do not affect coverage. The owner already
        // separates command identity/version and device-resolution variants.
        const key = `u:${width}:${cap}:${join}:${miterLimit}`
        const cached = this.cached(owner, key)
        if (cached) {
            this.stats.maskHits++
            return cached as GraphicsContext
        }
        if (
            !owner.path.shapePath.shapePrimitives.some(({ shape }) => {
                const bounds = shape.getBounds()
                return bounds.width > 0 || bounds.height > 0
            })
        ) {
            this.stats.maskDeclined++
            return
        }
        const context = new GraphicsContext().path(owner.path).stroke({
            color: 0xffffff,
            alpha: 1,
            width: width * resolution,
            cap,
            join,
            miterLimit,
        })
        // Nonzero bounds can still generate zero indices under Pixi's native
        // area cutoff. Check exactly once without copying triangle coordinates.
        if (pathTriangles(context, 0)?.length === 0) {
            this.empty.add(context)
            this.stats.maskEmpty++
        }
        this.stats.maskBuilt++
        this.store(context, owner, key)
        return context
    }

    private ownerFor(path: DrawPath, resolution: number) {
        const commands = path.commands
        let variants = this.paths.get(commands)
        if (!variants) this.paths.set(commands, (variants = new Map<number, CachedPath>()))
        let owner = variants.get(resolution)
        if (owner?.length !== commands.length || owner.last !== commands.at(-1)) {
            owner = {
                commands,
                resolution,
                length: commands.length,
                last: commands.at(-1),
                path: compilePath(path, resolution),
                styles: new Map(),
            }
            variants.set(resolution, owner)
        }
        return owner
    }

    private cached(owner: CachedPath, key: string) {
        const cached = owner.styles.get(key)
        if (!cached) return
        if (cached.frame !== this.frame) {
            cached.frame = this.frame
            this.removeEvictable(cached)
            // Overflow is released before advancing the frame, so every hit
            // from an earlier frame is resident. Enqueue it just once.
            if (cached.frameOnly) this.frameOnly.push(cached)
            else this.touched.push(cached)
        }
        cached.accessed = ++this.access
        this.stats.hits++
        return cached.context
    }

    private store(
        context: PathGraphicsResource,
        owner: CachedPath,
        key: string,
        frameOnly = false,
    ) {
        const bytes =
            context instanceof PathMeshGeometry
                ? estimateMeshBytes(context, owner.path, owner.length, key)
                : estimateContextBytes(context, owner.length, key)
        const entry: Entry = {
            context,
            bytes,
            frame: this.frame,
            owner,
            key,
            pins: 0,
            accessed: ++this.access,
            evictableIndex: -1,
            frameOnly,
        }
        this.contexts.set(context, entry)
        owner.styles.set(key, entry)
        this.trim(bytes)
        if (this.bytes + bytes <= this.maxBytes) {
            this.entries.add(entry)
            if (frameOnly) this.frameOnly.push(entry)
            else this.touched.push(entry)
            this.bytes += bytes
        } else {
            // Pin queued geometry for this frame without allowing a visible
            // working set larger than the budget to remain cached indefinitely.
            this.overflow.add(entry)
        }
        return context
    }

    endFrame() {
        this.trim(0)
    }

    private trim(required: number) {
        while (this.bytes + required > this.maxBytes) {
            const entry = this.evictable[0]
            if (!entry) break
            this.entries.delete(entry)
            this.bytes -= entry.bytes
            this.stats.trimmed++
            this.stats.trimmedBytes += entry.bytes
            this.release(entry)
        }
    }

    private release(entry: Entry) {
        this.removeEvictable(entry)
        this.contexts.delete(entry.context)
        entry.owner.styles.delete(entry.key)
        const variants = this.paths.get(entry.owner.commands)
        if (!entry.owner.styles.size && variants?.get(entry.owner.resolution) === entry.owner) {
            // Recorded application paths can live for the whole chart lifetime.
            // Do not leave their flattened CPU geometry behind after GPU eviction.
            variants.delete(entry.owner.resolution)
            if (!variants.size) this.paths.delete(entry.owner.commands)
        }
        entry.context.destroy()
        this.stats.evictions++
    }

    private addEvictable(entry: Entry) {
        let index = this.evictable.length
        this.evictable.push(entry)
        while (index) {
            const parentIndex = (index - 1) >>> 1
            const parent = at(this.evictable, parentIndex)
            if (parent.accessed < entry.accessed) break
            this.evictable[index] = parent
            parent.evictableIndex = index
            index = parentIndex
        }
        this.evictable[index] = entry
        entry.evictableIndex = index
    }

    private removeEvictable(entry: Entry) {
        let index = entry.evictableIndex
        if (index < 0) return
        entry.evictableIndex = -1
        const last = at(this.evictable, this.evictable.length - 1)
        this.evictable.pop()
        if (last === entry) return
        // A replacement can move in either direction when removing an
        // arbitrary entry for a frame draw or scene pin.
        if (index && last.accessed < at(this.evictable, (index - 1) >>> 1).accessed) {
            while (index) {
                const parentIndex = (index - 1) >>> 1
                const parent = at(this.evictable, parentIndex)
                if (parent.accessed < last.accessed) break
                this.evictable[index] = parent
                parent.evictableIndex = index
                index = parentIndex
            }
        } else {
            for (;;) {
                let childIndex = index * 2 + 1
                const left = this.evictable[childIndex]
                if (!left) break
                const right = this.evictable[childIndex + 1]
                if (right && right.accessed < left.accessed) childIndex++
                const child = at(this.evictable, childIndex)
                if (last.accessed < child.accessed) break
                this.evictable[index] = child
                child.evictableIndex = index
                index = childIndex
            }
        }
        this.evictable[index] = last
        last.evictableIndex = index
    }

    destroy() {
        for (const entry of this.entries) {
            entry.pins = 0
            entry.evictableIndex = -1
            entry.context.destroy()
        }
        for (const entry of this.overflow) entry.context.destroy()
        this.entries.clear()
        this.evictable.length = 0
        this.touched.length = 0
        this.overflow.clear()
        this.frameOnly.length = 0
        this.paths = new WeakMap()
        this.contexts = new WeakMap()
        this.empty = new WeakSet()
        this.bytes = 0
        this.protectedBytes = 0
        this.access = 0
        this.switchedAt = 0
    }
}
