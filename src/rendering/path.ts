type Radius = number | DOMPointInit
type Matrix = readonly [number, number, number, number, number, number, number, number, number]

export type PathCommand =
    | readonly ['moveTo' | 'lineTo', number, number]
    | readonly ['closePath']
    | readonly ['rect', number, number, number, number]
    | readonly ['roundRect', number, number, number, number, readonly Radius[]]
    | readonly ['quadraticCurveTo', number, number, number, number]
    | readonly ['bezierCurveTo', number, number, number, number, number, number]
    | readonly ['ellipse', number, number, number, number, number, number, number, boolean]
    | readonly ['arcTo', number, number, number, number, number]
    | readonly ['svg', string]
    | readonly ['addPath', DrawPath, Matrix]
    | readonly ['transform', Matrix]

const finite = (...values: number[]) => values.every(Number.isFinite)

const matrixFrom = (matrix: DOMMatrix2DInit): Matrix => [
    matrix.a ?? matrix.m11 ?? 1,
    matrix.c ?? matrix.m21 ?? 0,
    matrix.e ?? matrix.m41 ?? 0,
    matrix.b ?? matrix.m12 ?? 0,
    matrix.d ?? matrix.m22 ?? 1,
    matrix.f ?? matrix.m42 ?? 0,
    0,
    0,
    1,
]

const identity = (matrix: Matrix) =>
    matrix[0] === 1 &&
    matrix[1] === 0 &&
    matrix[2] === 0 &&
    matrix[3] === 0 &&
    matrix[4] === 1 &&
    matrix[5] === 0

/** Retained vector commands. Copies share immutable snapshots until either path changes. */
export class DrawPath {
    private recorded: PathCommand[]
    private shared = false

    constructor(source?: string | DrawPath) {
        this.recorded = source instanceof DrawPath ? source.recorded : []
        if (source instanceof DrawPath) source.shared = this.shared = true
        if (typeof source === 'string') this.record(['svg', source])
    }

    /** Read-only retained commands, also useful for geometry inspection. */
    get commands(): readonly PathCommand[] {
        return this.recorded
    }

    clone() {
        return new DrawPath(this)
    }

    /** Retained commands own no external resources; disposal keeps the path usable. */
    dispose() {
        // Geometry resources belong to the renderer's bounded caches.
    }

    private record(command: PathCommand) {
        if (this.shared) {
            this.recorded = [...this.recorded]
            this.shared = false
        }
        this.recorded.push(command)
    }

    moveTo(x: number, y: number) {
        if (finite(x, y)) this.record(['moveTo', x, y])
    }

    lineTo(x: number, y: number) {
        if (finite(x, y)) this.record(['lineTo', x, y])
    }

    closePath() {
        this.record(['closePath'])
    }

    rect(x: number, y: number, width: number, height: number) {
        if (finite(x, y, width, height)) this.record(['rect', x, y, width, height])
    }

    roundRect(
        x: number,
        y: number,
        width: number,
        height: number,
        radii: Radius | Iterable<Radius> = 0,
    ) {
        if (!finite(x, y, width, height)) return
        const values = typeof radii === 'object' && Symbol.iterator in radii ? [...radii] : [radii]
        if (!values.length || values.length > 4) throw new RangeError('Expected one to four radii')
        const normalized: Radius[] = []
        for (const radius of values) {
            const x = typeof radius === 'number' ? radius : (radius.x ?? 0)
            const y = typeof radius === 'number' ? radius : (radius.y ?? 0)
            if (!finite(x, y)) return
            if (x < 0 || y < 0) throw new RangeError('Radii must be non-negative')
            normalized.push(typeof radius === 'number' ? radius : { x, y })
        }
        this.record(['roundRect', x, y, width, height, normalized])
    }

    quadraticCurveTo(cpx: number, cpy: number, x: number, y: number) {
        if (finite(cpx, cpy, x, y)) this.record(['quadraticCurveTo', cpx, cpy, x, y])
    }

    bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number) {
        if (finite(cp1x, cp1y, cp2x, cp2y, x, y))
            this.record(['bezierCurveTo', cp1x, cp1y, cp2x, cp2y, x, y])
    }

    arc(x: number, y: number, radius: number, start: number, end: number, ccw = false) {
        this.ellipse(x, y, radius, radius, 0, start, end, ccw)
    }

    ellipse(
        x: number,
        y: number,
        radiusX: number,
        radiusY: number,
        rotation: number,
        start: number,
        end: number,
        ccw = false,
    ) {
        if (!finite(x, y, radiusX, radiusY, rotation, start, end)) return
        if (radiusX < 0 || radiusY < 0)
            throw new DOMException('Radii must be non-negative', 'IndexSizeError')
        this.record(['ellipse', x, y, radiusX, radiusY, rotation, start, end, ccw])
    }

    arcTo(x1: number, y1: number, x2: number, y2: number, radius: number) {
        if (!finite(x1, y1, x2, y2, radius)) return
        if (radius < 0) throw new DOMException('Radius must be non-negative', 'IndexSizeError')
        this.record(['arcTo', x1, y1, x2, y2, radius])
    }

    addPath(path: DrawPath, transform: DOMMatrix2DInit = {}) {
        const matrix = matrixFrom(transform)
        if (!matrix.every(Number.isFinite) || !path.recorded.length) return
        this.record(['addPath', path.clone(), matrix])
    }

    /** Transform all existing geometry, leaving subsequent commands unaffected. */
    transform(transform: DOMMatrix2DInit) {
        const matrix = matrixFrom(transform)
        if (this.recorded.length && matrix.every(Number.isFinite) && !identity(matrix))
            this.record(['transform', matrix])
    }
}
