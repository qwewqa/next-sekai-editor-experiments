import { parseColor } from '../rendering/paint'
import { curveTolerance, resolutionScale, roundCappedSegments } from '../rendering/strokeSegments'
import { SELECTION_COLOR } from '../utils/colors'
import type { Vec } from './engine/math'
import { linkProgram } from './program'
import type { OutlineMarker } from './selectionOutline'

// The selection outline's own small WebGL2 renderer, used by both preview hosts. It draws the
// outline as the editor's context drew it: round-capped segments, a dark 5 px stroke under a
// 2 px cyan one, flat opaque triangles at the path cache's tolerance, with the default
// framebuffer's MSAA. It imports no editor rendering, so it also runs in the preview's worker.

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
uniform vec2 u_size;
void main() {
    gl_Position = vec4(a_position.x * 2.0 / u_size.x - 1.0, 1.0 - a_position.y * 2.0 / u_size.y, 0.0, 1.0);
}
`
const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }
`

const STROKES = [
    { width: 5, color: [6 / 255, 21 / 255, 29 / 255, 1] },
    { width: 2, color: parseColor(SELECTION_COLOR) },
] as const

/** The outline's edges in CSS pixels (x0, y0, x1, y1, …), from the engine's screen space. */
export const outlineSegments = (
    edges: readonly { a: Vec; b: Vec }[],
    displayWidth: number,
    displayHeight: number,
) => {
    const scale = displayHeight / 2
    const segments: number[] = []
    for (const { a, b } of edges)
        segments.push(
            displayWidth / 2 + a.x * scale,
            displayHeight / 2 - a.y * scale,
            displayWidth / 2 + b.x * scale,
            displayHeight / 2 - b.y * scale,
        )
    return segments
}

/** Half an X's arm on each axis before it turns, in CSS pixels. */
const MARKER_ARM = 6

/** Each marker's two arms in CSS pixels, as `outlineSegments` gives edges. */
export const markerSegments = (
    markers: readonly OutlineMarker[],
    displayWidth: number,
    displayHeight: number,
) => {
    const scale = displayHeight / 2
    const segments: number[] = []
    for (const { point, angle } of markers) {
        const x = displayWidth / 2 + point.x * scale
        const y = displayHeight / 2 - point.y * scale
        const cos = Math.cos(angle) * MARKER_ARM
        const sin = Math.sin(angle) * MARKER_ARM
        // The diagonals (1, 1) and (1, -1), turned; the canvas's y points down.
        for (const side of [1, -1]) {
            const dx = cos - side * sin
            const dy = sin + side * cos
            segments.push(x - dx, y + dy, x + dx, y - dy)
        }
    }
    return segments
}

/** The drawn pixels' alpha, top row first. */
export type OutlineAlpha = { width: number; height: number; data: Uint8Array }

export type OutlineRenderer = {
    /**
     * Draws `segments`, then `markers` over them (CSS pixels), into a backing store of
     * `width` x `height`, scaled by `scaleX` and `scaleY`. No segments and no markers clear what
     * was drawn; while nothing was drawn, the canvas gets no context at all.
     */
    draw: (
        segments: readonly number[],
        markers: readonly number[],
        width: number,
        height: number,
        scaleX: number,
        scaleY: number,
    ) => void
    /** For tests: the drawn pixels' alpha. None while there is no context. */
    alpha: () => OutlineAlpha | undefined
    dispose: () => void
}

type Program = {
    program: WebGLProgram
    buffer: WebGLBuffer
    size: WebGLUniformLocation | null
    color: WebGLUniformLocation | null
}

/** `onError` hears a context that cannot be created or set up; the renderer then draws nothing. */
export const createOutlineRenderer = (
    canvas: HTMLCanvasElement | OffscreenCanvas,
    onError: (error: unknown) => void,
): OutlineRenderer => {
    let gl: WebGL2RenderingContext | undefined
    let program: Program | undefined
    let failed = false
    let lost = false
    let disposed = false
    let drawn = false
    let last: Parameters<OutlineRenderer['draw']> | undefined
    let vertices = new Float32Array(0)

    const setUp = (gl: WebGL2RenderingContext): Program => {
        const program = linkProgram(gl, 'outline', VERTEX_SHADER, FRAGMENT_SHADER)
        gl.useProgram(program)
        const buffer = gl.createBuffer()
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Allocation may fail on a lost/exhausted context despite DOM declarations.
        if (!buffer) throw new Error('Failed to create outline vertex buffer')
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        const position = gl.getAttribLocation(program, 'a_position')
        gl.enableVertexAttribArray(position)
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 8, 0)
        gl.clearColor(0, 0, 0, 0)
        return {
            program,
            buffer,
            size: gl.getUniformLocation(program, 'u_size'),
            color: gl.getUniformLocation(program, 'u_color'),
        }
    }

    const onLost = (event: Event) => {
        // Opt in to restoration; the old program and buffer are gone.
        event.preventDefault()
        lost = true
        program = undefined
    }
    const onRestored = () => {
        lost = false
        // A restored drawing buffer starts transparent.
        drawn = false
        if (last) draw(...last)
    }

    const context = () => {
        if (gl || failed) return gl
        try {
            const context = (canvas as HTMLCanvasElement).getContext('webgl2', {
                alpha: true,
                antialias: true,
                depth: false,
                premultipliedAlpha: true,
                // Keeps the outline readable after its frame, as the editor's context did.
                preserveDrawingBuffer: true,
            })
            if (!context) throw new Error('WebGL2 is unavailable or disabled in this browser')
            gl = context
            canvas.addEventListener('webglcontextlost', onLost)
            canvas.addEventListener('webglcontextrestored', onRestored)
        } catch (error) {
            failed = true
            onError(error)
        }
        return gl
    }

    const draw: OutlineRenderer['draw'] = (segments, markers, width, height, scaleX, scaleY) => {
        if (disposed) return
        last = [segments, markers, width, height, scaleX, scaleY]
        if (!segments.length && !markers.length && !drawn) return
        const current = context()
        if (!current || lost || current.isContextLost()) return
        try {
            program ??= setUp(current)
        } catch (error) {
            failed = true
            onError(error)
            return
        }
        if (canvas.width !== width) canvas.width = width
        if (canvas.height !== height) canvas.height = height
        current.viewport(0, 0, width, height)
        current.clear(current.COLOR_BUFFER_BIT)
        drawn = segments.length > 0 || markers.length > 0
        if (!drawn) return
        current.uniform2f(program.size, width, height)
        const matrix = [scaleX, 0, 0, scaleY, 0, 0]
        // The path cache's tolerance at this transform, so the caps match a stroked path's.
        const tolerance = curveTolerance / resolutionScale(matrix)
        // The markers' dark stroke covers the outline under them.
        for (const list of [segments, markers])
            for (const { width: lineWidth, color } of STROKES) {
                let length = 0
                roundCappedSegments(list, lineWidth, tolerance, (x, y) => {
                    if (length + 2 > vertices.length) {
                        const grown = new Float32Array(Math.max(1024, vertices.length * 2))
                        grown.set(vertices)
                        vertices = grown
                    }
                    vertices[length++] = x * scaleX
                    vertices[length++] = y * scaleY
                })
                if (!length) continue
                current.bufferData(
                    current.ARRAY_BUFFER,
                    vertices.subarray(0, length),
                    current.STREAM_DRAW,
                )
                current.uniform4f(program.color, color[0], color[1], color[2], color[3])
                current.drawArrays(current.TRIANGLES, 0, length / 2)
            }
    }

    return {
        draw,
        alpha: () => {
            if (!gl || gl.isContextLost()) return
            const { width, height } = canvas
            const rgba = new Uint8Array(width * height * 4)
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
            const data = new Uint8Array(width * height)
            // WebGL reads the bottom row first.
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++)
                    data[y * width + x] = rgba[((height - 1 - y) * width + x) * 4 + 3] ?? 0
            return { width, height, data }
        },
        dispose: () => {
            if (disposed) return
            disposed = true
            canvas.removeEventListener('webglcontextlost', onLost)
            canvas.removeEventListener('webglcontextrestored', onRestored)
            if (gl && program && !gl.isContextLost()) {
                gl.deleteBuffer(program.buffer)
                gl.deleteProgram(program.program)
            }
            gl?.getExtension('WEBGL_lose_context')?.loseContext()
            gl = undefined
            program = undefined
            last = undefined
        },
    }
}
