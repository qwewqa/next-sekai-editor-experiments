type Contours = readonly { points: readonly (readonly [number, number])[] }[]
// Callers below prove indices against the array length before each access.
const indexed = <T>(values: ArrayLike<T>, index: number): T => values[index] as T

type LyonExports = {
    memory: WebAssembly.Memory
    abi_version(): number
    reserve(coordinates: number, contours: number): number
    input_ptr(): number
    counts_ptr(): number
    output_ptr(): number
    output_length(): number
    run(contours: number, coordinates: number, odd: number): number
    dispose(): number
}

// A contour can wind repeatedly. Count all edges, not just contours, before
// entering Lyon's signed 16-bit winding accumulator.
const maxEdges = 32767
const maxLocalCoordinate = 2 ** 23
// One quarter of the renderer's 0.1-pixel curve tolerance. Resolution is the
// existing cache bucket, which bounds the final device stretch to at most one.
const maxPixelError = 0.025
const endpointSnapRadius = Math.sqrt(1e-9)

/** One page-owned, single-threaded fill kernel; returned triangles are JS-owned. */
export class LyonTessellator {
    private exports?: LyonExports
    private buffer?: ArrayBuffer
    private coordinates = new Float64Array()
    private counts = new Uint32Array()

    constructor(exports: WebAssembly.Exports) {
        const functions = [
            'abi_version',
            'reserve',
            'input_ptr',
            'counts_ptr',
            'output_ptr',
            'output_length',
            'run',
            'dispose',
        ]
        if (
            !(exports.memory instanceof WebAssembly.Memory) ||
            functions.some((name) => typeof exports[name] !== 'function')
        ) {
            throw new Error('Invalid Lyon module exports')
        }
        const checked = exports as unknown as LyonExports
        if (checked.abi_version() !== 1) throw new Error('Unsupported Lyon ABI')
        this.exports = checked
    }

    /** Undefined means the caller must run the unchanged double-precision path. */
    triangulate(
        contours: Contours,
        rule: CanvasFillRule,
        resolution: number,
    ): Float64Array | undefined {
        const native = this.exports
        if (
            !native ||
            !(resolution > 0) ||
            !Number.isFinite(resolution) ||
            endpointSnapRadius * resolution > maxPixelError ||
            contours.length > maxEdges
        )
            return

        let edges = 0
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity
        for (const contour of contours) {
            edges += contour.points.length
            if (edges > maxEdges) return
            for (const [x, y] of contour.points) {
                if (!Number.isFinite(x) || !Number.isFinite(y)) return
                minX = Math.min(minX, x)
                minY = Math.min(minY, y)
                maxX = Math.max(maxX, x)
                maxY = Math.max(maxY, y)
            }
        }
        if (!edges) return new Float64Array()
        const originX = minX + (maxX - minX) / 2
        const originY = minY + (maxY - minY) / 2
        const extent = Math.max(maxX - minX, maxY - minY) / 2
        // Bound rounding anywhere in the local box, including new intersection
        // vertices, as well as measuring each actual input conversion below.
        if (
            !Number.isFinite(originX) ||
            !Number.isFinite(originY) ||
            extent > maxLocalCoordinate ||
            (Math.hypot(maxX - minX, maxY - minY) / 2) * 2 ** -24 * resolution > maxPixelError
        )
            return
        const errorSquared = (maxPixelError / resolution) ** 2
        try {
            if (!native.reserve(edges * 2, contours.length)) {
                this.retire()
                return
            }
            this.refresh(native.memory)
            const coordinates = this.coordinates,
                counts = this.counts
            const inputOffset = native.input_ptr() / 8,
                countOffset = native.counts_ptr() / 4
            if (
                !Number.isInteger(inputOffset) ||
                inputOffset < 0 ||
                inputOffset + edges * 2 > coordinates.length ||
                !Number.isInteger(countOffset) ||
                countOffset < 0 ||
                countOffset + contours.length > counts.length
            ) {
                this.retire()
                return
            }
            let cursor = inputOffset
            for (let i = 0; i < contours.length; i++) {
                const points = indexed(contours, i).points
                counts[countOffset + i] = points.length
                for (const [x, y] of points) {
                    const localX = x - originX,
                        localY = y - originY
                    // Include subtraction/restoration error, not just f32 cast
                    // error. A distant timeline origin must not silently move
                    // a small positive painted feature.
                    const dx = Math.fround(localX) + originX - x
                    const dy = Math.fround(localY) + originY - y
                    if (dx * dx + dy * dy > errorSquared) return
                    coordinates[cursor++] = localX
                    coordinates[cursor++] = localY
                }
            }
            if (native.run(contours.length, edges * 2, rule === 'evenodd' ? 1 : 0) !== 0) {
                this.retire()
                return
            }
            this.refresh(native.memory)
            const heap = this.coordinates
            const offset = native.output_ptr() / 8,
                length = native.output_length()
            if (
                !Number.isInteger(offset) ||
                offset < 0 ||
                !Number.isInteger(length) ||
                length < 0 ||
                length % 6 ||
                offset + length > heap.length
            ) {
                this.retire()
                return
            }
            const result = heap.slice(offset, offset + length)
            for (let i = 0; i < length; i += 2) {
                const localX = indexed(result, i),
                    localY = indexed(result, i + 1)
                const x = localX + originX,
                    y = localY + originY
                if (!Number.isFinite(x) || !Number.isFinite(y)) {
                    this.retire()
                    return
                }
                // New intersection vertices may have fractions absent from
                // the input. Restoring a large origin must preserve them too.
                const dx = x - originX - localX,
                    dy = y - originY - localY
                if (dx * dx + dy * dy > errorSquared) return
                result[i] = x
                result[i + 1] = y
            }
            return result
        } catch {
            // A panic/OOM trap can leave native state partially mutated. Never
            // call that instance again, including its destructor. Dropping all
            // exports and views lets the entire linear memory be reclaimed.
            this.retire()
            return
        }
    }

    private refresh(memory: WebAssembly.Memory) {
        if (this.buffer === memory.buffer) return
        this.buffer = memory.buffer
        this.coordinates = new Float64Array(this.buffer)
        this.counts = new Uint32Array(this.buffer)
    }

    private retire(): undefined {
        this.exports = undefined
        this.buffer = undefined
        this.coordinates = new Float64Array()
        this.counts = new Uint32Array()
    }

    dispose() {
        const native = this.exports
        this.retire()
        if (native) {
            try {
                native.dispose()
            } catch {
                /* The whole instance is already retired. */
            }
        }
    }
}

/** A failed, CSP-blocked or hung optimization must not prevent editor startup. */
export async function loadLyon(url: URL, timeoutMs = 4000): Promise<LyonTessellator | undefined> {
    const controller = new AbortController()
    const state = { expired: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
            state.expired = true
            controller.abort()
            resolve(undefined)
        }, timeoutMs)
    })
    const loading = (async () => {
        try {
            const response = await fetch(url, { signal: controller.signal })
            if (!response.ok) return
            const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {})
            const kernel = new LyonTessellator(instance.exports)
            if (!state.expired) return kernel
            kernel.dispose()
        } catch {
            /* Rendering continues through the existing JS tessellator. */
        }
    })()
    try {
        return await Promise.race([loading, timeout])
    } finally {
        clearTimeout(timer)
    }
}

let kernel: LyonTessellator | undefined
let initialization: Promise<void> | undefined

export const initializeLyon = () =>
    (initialization ??= loadLyon(new URL('./vendor/lyon.wasm', import.meta.url)).then((loaded) => {
        kernel = loaded
    }))

export const triangulateLyon = (contours: Contours, rule: CanvasFillRule, resolution: number) =>
    kernel?.triangulate(contours, rule, resolution)
