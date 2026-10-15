import { buildLine, Mesh, MeshGeometry } from 'pixi.js'
import { certifyNativeStrokeStrip, maxStrokeStripPoints } from './nativeStrokeStrip'
import type { DrawPath } from './path'

const curveTolerance = 0.1
const packingTolerance = 0.025
const coordinate = (values: ArrayLike<number>, index: number) => values[index] ?? NaN

/** An owned, immutable-by-contract centerline in lane/time coordinates near its origin. */
export type PreparedEventStroke = {
    readonly originX: number
    readonly originTime: number
    readonly points: Float64Array
    readonly horizontalError: number
    readonly timeError: number
}

/** Prepare only the event renderer's single, open M/L or M/Q[/Q] paths. */
export function prepareEventStroke(
    path: DrawPath,
    horizontalDeviceScale: number,
): PreparedEventStroke | undefined {
    if (!Number.isFinite(horizontalDeviceScale) || !horizontalDeviceScale) return
    const commands = path.commands
    if (commands.length < 2 || commands.length > maxStrokeStripPoints) return
    const first = commands[0]
    if (first?.[0] !== 'moveTo') return

    let minX = first[1],
        maxX = first[1],
        minTime = first[2],
        maxTime = first[2],
        mode: 'lineTo' | 'quadraticCurveTo' | undefined,
        quadratics = 0
    for (let i = 0; i < commands.length; i++) {
        const command = commands[i]
        if (!command) return
        if (i && command[0] !== 'lineTo' && command[0] !== 'quadraticCurveTo') return
        if (command[0] === 'lineTo' || command[0] === 'quadraticCurveTo') {
            if (mode && mode !== command[0]) return
            mode = command[0]
        }
        if (command[0] === 'quadraticCurveTo' && ++quadratics > 2) return
        // The command kind checks above leave only numeric coordinate pairs.
        for (let j = 1; j < command.length; j += 2) {
            const x = command[j],
                time = command[j + 1]
            if (typeof x !== 'number' || typeof time !== 'number') return
            if (!Number.isFinite(x) || !Number.isFinite(time)) return
            minX = Math.min(minX, x)
            maxX = Math.max(maxX, x)
            minTime = Math.min(minTime, time)
            maxTime = Math.max(maxTime, time)
        }
    }
    const originX = minX + (maxX - minX) / 2,
        originTime = minTime + (maxTime - minTime) / 2
    if (!Number.isFinite(originX) || !Number.isFinite(originTime)) return
    const points: number[] = []
    let horizontalError = 0,
        timeError = 0
    const append = (x: number, time: number) => {
        if (!Number.isFinite(x) || !Number.isFinite(time)) return false
        if (points.at(-2) === x && points.at(-1) === time) return true
        if (points.length >= 2 * maxStrokeStripPoints) return false
        points.push(x, time)
        return true
    }
    const quadratic = (
        x0: number,
        t0: number,
        cx: number,
        ct: number,
        x1: number,
        t1: number,
        depth: number,
    ): boolean => {
        const mx = x0 + (x1 - x0) / 2,
            mt = t0 + (t1 - t0) / 2,
            errorX = Math.abs(cx - mx) / 2,
            errorTime = Math.abs(ct - mt) / 2
        if (!Number.isFinite(errorX) || !Number.isFinite(errorTime)) return false
        if (errorX * Math.abs(horizontalDeviceScale) <= curveTolerance) {
            horizontalError = Math.max(horizontalError, errorX)
            timeError = Math.max(timeError, errorTime)
            return append(x1, t1)
        }
        if (depth === 32) return false
        const ax = x0 + (cx - x0) / 2,
            at = t0 + (ct - t0) / 2,
            bx = cx + (x1 - cx) / 2,
            bt = ct + (t1 - ct) / 2,
            x = ax + (bx - ax) / 2,
            t = at + (bt - at) / 2
        return (
            quadratic(x0, t0, ax, at, x, t, depth + 1) && quadratic(x, t, bx, bt, x1, t1, depth + 1)
        )
    }
    let x = first[1],
        time = first[2]
    if (!append(x - originX, time - originTime)) return
    for (const command of commands.slice(1)) {
        if (command[0] === 'lineTo') {
            x = command[1]
            time = command[2]
            if (!append(x - originX, time - originTime)) return
        } else if (command[0] === 'quadraticCurveTo') {
            const [, cx, ct, x1, t1] = command
            // Event quarter-time controls can differ by a few rounding bits
            // from the midpoint of their already-rounded segment endpoints.
            const midpoint = time + (t1 - time) / 2
            if (
                Math.abs(ct - midpoint) >
                8 * Number.EPSILON * Math.max(1, Math.abs(time), Math.abs(t1), Math.abs(ct))
            )
                return
            if (
                !quadratic(
                    x - originX,
                    time - originTime,
                    cx - originX,
                    ct - originTime,
                    x1 - originX,
                    t1 - originTime,
                    0,
                )
            )
                return
            x = x1
            time = t1
        }
    }
    if (points.length < 4) return
    return { originX, originTime, points: new Float64Array(points), horizontalError, timeError }
}

/** Fixed-topology, locally rebased event stroke; the owning retained range releases it. */
export class EventStrokeGeometry extends MeshGeometry {
    readonly prepared: PreparedEventStroke
    private readonly pendingPositions: Float32Array
    private pending = false
    private released = false

    private constructor(prepared: PreparedEventStroke) {
        const positions = new Float32Array(prepared.points.length * 2)
        const uvs = new Float32Array(positions.length).fill(0.5)
        const indices = new Uint32Array((positions.length / 2 - 2) * 3)
        for (let i = 0; i < indices.length / 3; i++) indices.set([i, i + 1, i + 2], 3 * i)
        super({ positions, uvs, indices })
        this.batchMode = 'batch'
        this.prepared = prepared
        this.pendingPositions = new Float32Array(positions.length)
    }

    static create(
        prepared: PreparedEventStroke,
        scaleX: number,
        scaleTime: number,
        widthDevice: number,
    ): EventStrokeGeometry | undefined {
        const count = prepared.points.length / 2
        if (!Number.isInteger(count) || count < 2 || count > maxStrokeStripPoints) return
        const geometry = new EventStrokeGeometry(prepared)
        if (!geometry.stage(scaleX, scaleTime, widthDevice)) {
            geometry.destroy()
            return
        }
        geometry.commit()
        return geometry
    }

    /** Numeric payload owned or retained by this geometry, excluding Pixi/JS object overhead. */
    get byteSize() {
        return (
            this.prepared.points.byteLength +
            this.positions.byteLength +
            this.uvs.byteLength +
            this.indices.byteLength +
            this.pendingPositions.byteLength
        )
    }

    /** Validate every member of a retained range before calling commit on any member. */
    stage(scaleX: number, scaleTime: number, widthDevice: number) {
        this.pending = false
        if (
            this.released ||
            !Number.isFinite(scaleX) ||
            !scaleX ||
            !Number.isFinite(scaleTime) ||
            !scaleTime ||
            !Number.isFinite(widthDevice) ||
            widthDevice <= 0 ||
            Math.hypot(
                this.prepared.horizontalError * scaleX,
                this.prepared.timeError * scaleTime,
            ) > curveTolerance
        )
            return false
        const projected: number[] = []
        for (let i = 0; i < this.prepared.points.length; i += 2) {
            const x = coordinate(this.prepared.points, i) * scaleX,
                y = coordinate(this.prepared.points, i + 1) * scaleTime
            if (!Number.isFinite(x) || !Number.isFinite(y)) return false
            if (i) {
                const dx = x - coordinate(projected, i - 2),
                    dy = y - coordinate(projected, i - 1),
                    squaredLength = dx * dx + dy * dy
                // Match buildLine's norm arithmetic; zero/overflow would divide
                // by zero or silently collapse its normal even with finite input.
                if (!Number.isFinite(squaredLength) || !squaredLength) return false
            }
            projected.push(x, y)
        }
        const vertices: number[] = [],
            indices: number[] = []
        buildLine(
            projected,
            { width: widthDevice, alignment: 0.5, cap: 'butt', join: 'miter', miterLimit: 10 },
            false,
            false,
            vertices,
            indices,
        )
        const count = projected.length / 2
        if (!certifyNativeStrokeStrip(vertices, indices, count)) return false
        for (let i = 0; i < vertices.length; i += 2) {
            const x = coordinate(vertices, i),
                y = coordinate(vertices, i + 1)
            this.pendingPositions[i] = x
            this.pendingPositions[i + 1] = y
            if (
                Math.hypot(
                    coordinate(this.pendingPositions, i) - x,
                    coordinate(this.pendingPositions, i + 1) - y,
                ) > packingTolerance
            )
                return false
        }
        // Certification must survive the exact Float32 positions consumed by
        // the GPU; a valid double strip can collapse or fold during packing.
        if (!certifyNativeStrokeStrip(this.pendingPositions, this.indices, count)) return false
        this.pending = true
        return true
    }

    commit() {
        if (!this.pending || this.released) return
        this.pending = false
        this.positions.set(this.pendingPositions)
        this.getBuffer('aPosition').update()
    }

    get destroyed() {
        return this.released
    }

    override destroy() {
        if (this.released) return
        this.released = true
        this.pending = false
        super.destroy(true)
    }
}

/** Marker for the context's retained-mesh lifetime dispatch. */
export class EventStrokeMesh extends Mesh<EventStrokeGeometry> {}
