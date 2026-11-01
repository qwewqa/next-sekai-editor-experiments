import { linkProgram } from './program'

export type RenderTargetOptions = { width: number; height: number; antialias: boolean }

export type RenderTarget = RenderTargetOptions & {
    bind: () => void
    /** Resolves at the render size and returns the single-sample foreground texture. */
    resolve: () => WebGLTexture
    /** Copies the resolved texture to the canvas, averaging each output pixel's source area. */
    present: (width: number, height: number) => void
    dispose: () => void
}

const VERTEX_SHADER = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_outputSize;
out vec4 outColor;
void main() {
    vec2 scale = vec2(textureSize(u_source, 0)) / u_outputSize;
    vec2 lo = floor(gl_FragCoord.xy) * scale;
    vec2 hi = lo + scale;
    ivec2 first = ivec2(floor(lo));
    vec4 sum = vec4(0.0);
    for (int y = first.y; y < int(ceil(hi.y)); y++) {
        float wy = min(hi.y, float(y + 1)) - max(lo.y, float(y));
        for (int x = first.x; x < int(ceil(hi.x)); x++) {
            float wx = min(hi.x, float(x + 1)) - max(lo.x, float(x));
            sum += texelFetch(u_source, ivec2(x, y), 0) * wx * wy;
        }
    }
    outColor = sum / (scale.x * scale.y);
}
`

/** Allocations are checked here; the caller checks GL errors after all passes of a frame. */
export const createRenderTarget = (
    gl: WebGL2RenderingContext,
    canvas: HTMLCanvasElement | OffscreenCanvas,
    { width, height, antialias }: RenderTargetOptions,
): RenderTarget => {
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
    const limit = Math.min(
        gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
        antialias ? (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) : Infinity,
    )
    if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- MAX_VIEWPORT_DIMS has two entries.
        width > Math.min(limit, viewport[0]!) ||
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- MAX_VIEWPORT_DIMS has two entries.
        height > Math.min(limit, viewport[1]!)
    )
        throw new Error('Invalid size for preview render target')

    const texture = gl.createTexture()
    const resolved = gl.createFramebuffer()
    const multisample = antialias ? gl.createFramebuffer() : null
    const color = antialias ? gl.createRenderbuffer() : null
    let program: WebGLProgram | undefined
    let outputSize: WebGLUniformLocation | null
    let disposed = false
    const dispose = () => {
        if (disposed) return
        disposed = true
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.bindRenderbuffer(gl.RENDERBUFFER, null)
        gl.deleteFramebuffer(multisample)
        gl.deleteFramebuffer(resolved)
        gl.deleteRenderbuffer(color)
        gl.deleteTexture(texture)
        if (program) {
            gl.useProgram(null)
            gl.deleteProgram(program)
        }
    }
    const check = () => {
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error('Incomplete preview render target')
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GL allocations can fail on a lost or exhausted context.
        if (!texture || !resolved || (antialias && (!multisample || !color)))
            throw new Error('Failed to allocate preview render target')
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.bindFramebuffer(gl.FRAMEBUFFER, resolved)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
        check()
        if (antialias) {
            gl.bindRenderbuffer(gl.RENDERBUFFER, color)
            gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, gl.RGBA8, width, height)
            gl.bindFramebuffer(gl.FRAMEBUFFER, multisample)
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color)
            check()
        }
        program = linkProgram(gl, 'preview downscale', VERTEX_SHADER, FRAGMENT_SHADER)
        outputSize = gl.getUniformLocation(program, 'u_outputSize')
    } catch (error) {
        dispose()
        throw error
    } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.bindRenderbuffer(gl.RENDERBUFFER, null)
    }
    const alive = () => {
        if (disposed) throw new Error('Preview render target is disposed')
    }
    return {
        width,
        height,
        antialias,
        bind() {
            alive()
            gl.bindFramebuffer(gl.FRAMEBUFFER, multisample ?? resolved)
        },
        resolve() {
            alive()
            if (multisample) {
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, multisample)
                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolved)
                gl.blitFramebuffer(
                    0,
                    0,
                    width,
                    height,
                    0,
                    0,
                    width,
                    height,
                    gl.COLOR_BUFFER_BIT,
                    gl.NEAREST,
                )
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, resolved)
            return texture
        },
        present(outputWidth, outputHeight) {
            alive()
            if (
                !Number.isInteger(outputWidth) ||
                !Number.isInteger(outputHeight) ||
                outputWidth <= 0 ||
                outputHeight <= 0 ||
                outputWidth > width ||
                outputHeight > height
            )
                throw new Error('Invalid preview output size')
            if (canvas.width !== outputWidth) canvas.width = outputWidth
            if (canvas.height !== outputHeight) canvas.height = outputHeight
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            gl.viewport(0, 0, outputWidth, outputHeight)
            gl.disable(gl.BLEND)
            gl.useProgram(program)
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, texture)
            gl.uniform1i(gl.getUniformLocation(program, 'u_source'), 0)
            gl.uniform2f(outputSize, outputWidth, outputHeight)
            gl.drawArrays(gl.TRIANGLES, 0, 3)
        },
        dispose,
    }
}
