import { curveTolerance, resolutionScale, roundCappedSegments } from '../rendering/strokeSegments'
import type { Vec } from './engine/math'
import { linkProgram } from './gl'

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
    { width: 2, color: [103 / 255, 232 / 255, 249 / 255, 1] },
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

export type OutlineRenderer = {
    /**
     * Draws `segments` (CSS pixels) into a backing store of `width` × `height`, scaled by
     * `scaleX` and `scaleY`. No segments clear what was drawn; while nothing was drawn, the
     * canvas gets no context at all.
     */
    draw: (
        segments: readonly number[],
        width: number,
        height: number,
        scaleX: number,
        scaleY: number,
    ) => void
    /** For tests: the drawn pixels, those with any alpha. None while there is no context. */
    litPixels: () => number
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
            const context = canvas.getContext('webgl2', {
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

    const draw: OutlineRenderer['draw'] = (segments, width, height, scaleX, scaleY) => {
        if (disposed) return
        last = [segments, width, height, scaleX, scaleY]
        if (!segments.length && !drawn) return
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
        drawn = segments.length > 0
        if (!drawn) return
        current.uniform2f(program.size, width, height)
        const matrix = [scaleX, 0, 0, scaleY, 0, 0]
        // The path cache's tolerance at this transform, so the caps match a stroked path's.
        const tolerance = curveTolerance / resolutionScale(matrix)
        for (const { width: lineWidth, color } of STROKES) {
            let length = 0
            roundCappedSegments(segments, lineWidth, tolerance, (x, y) => {
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
        litPixels: () => {
            if (!gl || gl.isContextLost()) return 0
            const data = new Uint8Array(canvas.width * canvas.height * 4)
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
            let lit = 0
            for (let i = 3; i < data.length; i += 4) if (data[i]) lit++
            return lit
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
