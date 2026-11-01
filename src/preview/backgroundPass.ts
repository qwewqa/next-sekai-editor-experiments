import { backgroundBlurSize, backgroundColor } from './backgroundBlur'
import { linkProgram } from './program'

const VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    v_uv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform int u_mode;
uniform vec2 u_margin;
uniform vec2 u_step;
uniform float u_sigma;
uniform vec4 u_color;
in vec2 v_uv;
out vec4 outColor;
void main() {
    if (u_mode == 0) {
        vec2 uv = v_uv * (1.0 + 2.0 * u_margin) - u_margin;
        outColor = any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))
            ? vec4(0.0) : texture(u_source, vec2(uv.x, 1.0 - uv.y));
    } else if (u_mode == 1) {
        vec4 sum = vec4(0.0);
        float weight = 0.0;
        for (int i = -24; i <= 24; i++) {
            if (abs(float(i)) > ceil(3.0 * u_sigma)) continue;
            float w = exp(-0.5 * float(i * i) / (u_sigma * u_sigma));
            vec2 uv = v_uv + float(i) * u_step;
            if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))))
                sum += texture(u_source, uv) * w;
            weight += w;
        }
        outColor = sum / weight;
    } else if (u_mode == 2) {
        outColor = texture(u_source, v_uv);
    } else {
        outColor = u_color;
    }
}
`

/** Owns the two bounded blur textures and the full-screen mask and foreground pass. */
export const createBackgroundPass = (gl: WebGL2RenderingContext) => {
    const program = linkProgram(gl, 'preview background', VERTEX, FRAGMENT)
    const mode = gl.getUniformLocation(program, 'u_mode')
    const margin = gl.getUniformLocation(program, 'u_margin')
    const step = gl.getUniformLocation(program, 'u_step')
    const sigmaLocation = gl.getUniformLocation(program, 'u_sigma')
    const color = gl.getUniformLocation(program, 'u_color')
    const sampler = gl.getUniformLocation(program, 'u_source')
    type Buffer = { texture: WebGLTexture; framebuffer: WebGLFramebuffer }
    let buffers: Buffer[] = []
    let cached: ReturnType<typeof backgroundBlurSize> | undefined
    let identity: object | undefined
    const clear = () => {
        for (const buffer of buffers) {
            gl.deleteFramebuffer(buffer.framebuffer)
            gl.deleteTexture(buffer.texture)
        }
        buffers = []
        cached = undefined
        identity = undefined
    }
    const use = () => {
        gl.useProgram(program)
        gl.activeTexture(gl.TEXTURE3)
        gl.uniform1i(sampler, 3)
    }
    const allocate = (width: number, height: number): Buffer => {
        const texture = gl.createTexture()
        const framebuffer = gl.createFramebuffer()
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GL allocations can fail.
        if (!texture || !framebuffer) {
            gl.deleteTexture(texture)
            gl.deleteFramebuffer(framebuffer)
            throw new Error('Failed to allocate background blur')
        }
        const buffer = { texture, framebuffer }
        buffers.push(buffer)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error('Incomplete background blur framebuffer')
        return buffer
    }
    return {
        blur(source: WebGLTexture, image: object, width: number, height: number, sigma: number) {
            if (sigma <= 0) {
                clear()
                return undefined
            }
            const size = backgroundBlurSize(width, height, sigma)
            const cachedBuffer = buffers[0]
            if (
                cachedBuffer &&
                identity === image &&
                cached?.width === size.width &&
                cached.height === size.height &&
                cached.sigma === size.sigma &&
                cached.marginX === size.marginX &&
                cached.marginY === size.marginY
            )
                return { ...size, texture: cachedBuffer.texture }
            use()
            try {
                if (cached?.width !== size.width || cached.height !== size.height) {
                    clear()
                    allocate(size.width, size.height)
                    allocate(size.width, size.height)
                }
                const [a, b] = buffers as [Buffer, Buffer]
                gl.disable(gl.BLEND)
                gl.viewport(0, 0, size.width, size.height)
                gl.bindFramebuffer(gl.FRAMEBUFFER, a.framebuffer)
                gl.bindTexture(gl.TEXTURE_2D, source)
                gl.uniform1i(mode, 0)
                gl.uniform2f(margin, size.marginX, size.marginY)
                gl.drawArrays(gl.TRIANGLES, 0, 3)
                gl.uniform1i(mode, 1)
                gl.uniform1f(sigmaLocation, size.sigma)
                gl.bindFramebuffer(gl.FRAMEBUFFER, b.framebuffer)
                gl.bindTexture(gl.TEXTURE_2D, a.texture)
                gl.uniform2f(step, 1 / size.width, 0)
                gl.drawArrays(gl.TRIANGLES, 0, 3)
                gl.bindFramebuffer(gl.FRAMEBUFFER, a.framebuffer)
                gl.bindTexture(gl.TEXTURE_2D, b.texture)
                gl.uniform2f(step, 0, 1 / size.height)
                gl.drawArrays(gl.TRIANGLES, 0, 3)
                cached = size
                identity = image
                return { ...size, texture: a.texture }
            } catch (error) {
                clear()
                throw error
            }
        },
        composite(foreground: WebGLTexture, mask: string | undefined) {
            use()
            gl.enable(gl.BLEND)
            gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
            if (mask) {
                gl.uniform1i(mode, 3)
                gl.uniform4fv(color, backgroundColor(mask))
                gl.drawArrays(gl.TRIANGLES, 0, 3)
            }
            gl.bindTexture(gl.TEXTURE_2D, foreground)
            gl.uniform1i(mode, 2)
            gl.drawArrays(gl.TRIANGLES, 0, 3)
        },
        dispose() {
            clear()
            gl.deleteProgram(program)
        },
    }
}
