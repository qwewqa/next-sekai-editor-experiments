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
uniform vec2 u_outputSize;
uniform float u_sigma;
uniform vec4 u_color;
in vec2 v_uv;
out vec4 outColor;
vec4 area(vec2 uv, vec2 footprint) {
    ivec2 size = textureSize(u_source, 0);
    vec2 extent = max(footprint, vec2(1.0));
    vec2 center = uv * vec2(size);
    vec2 coverage = clamp((min(center + footprint * 0.5, vec2(size))
        - max(center - footprint * 0.5, vec2(0.0))) / footprint, 0.0, 1.0);
    // Clamping at the image edges preserves color when the source is enlarged.
    bvec2 enlarged = lessThan(footprint, vec2(1.0));
    center = mix(center, clamp(center, vec2(0.5), vec2(size) - 0.5), enlarged);
    coverage = mix(vec2(1.0), coverage, enlarged);
    vec2 lo = center - extent * 0.5;
    vec2 hi = lo + extent;
    ivec2 first = max(ivec2(0), ivec2(floor(lo)));
    vec4 sum = vec4(0.0);
    for (int y = 0; y < 3; y++) {
        for (int x = 0; x < 3; x++) {
            ivec2 p = first + ivec2(x, y);
            vec2 weight = max(vec2(0.0), min(hi, vec2(p + 1)) - max(lo, vec2(p)));
            if (all(greaterThanEqual(p, ivec2(0))) && all(lessThan(p, size)))
                sum += texelFetch(u_source, p, 0) * weight.x * weight.y;
        }
    }
    return sum * coverage.x * coverage.y / (extent.x * extent.y);
}
void main() {
    if (u_mode == 0) {
        vec2 uv = v_uv * (1.0 + 2.0 * u_margin) - u_margin;
        outColor = area(vec2(uv.x, 1.0 - uv.y),
            vec2(textureSize(u_source, 0)) * (1.0 + 2.0 * u_margin) / u_outputSize);
    } else if (u_mode == 4) {
        outColor = area(v_uv, vec2(textureSize(u_source, 0)) / u_outputSize);
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
    const outputSize = gl.getUniformLocation(program, 'u_outputSize')
    const sigmaLocation = gl.getUniformLocation(program, 'u_sigma')
    const color = gl.getUniformLocation(program, 'u_color')
    const sampler = gl.getUniformLocation(program, 'u_source')
    type Buffer = {
        texture: WebGLTexture
        framebuffer: WebGLFramebuffer
        width: number
        height: number
    }
    let buffers: (Buffer | undefined)[] = []
    let cachedBuffer: Buffer | undefined
    let cached: ReturnType<typeof backgroundBlurSize> | undefined
    let identity: object | undefined
    const clear = () => {
        for (const buffer of buffers) {
            if (!buffer) continue
            gl.deleteFramebuffer(buffer.framebuffer)
            gl.deleteTexture(buffer.texture)
        }
        buffers = []
        cached = undefined
        identity = undefined
        cachedBuffer = undefined
    }
    const use = () => {
        gl.useProgram(program)
        gl.activeTexture(gl.TEXTURE3)
        gl.uniform1i(sampler, 3)
    }
    const allocate = (index: number, width: number, height: number): Buffer => {
        const previous = buffers[index]
        if (previous?.width === width && previous.height === height) return previous
        if (previous) {
            gl.deleteFramebuffer(previous.framebuffer)
            gl.deleteTexture(previous.texture)
            buffers[index] = undefined
        }
        const texture = gl.createTexture()
        const framebuffer = gl.createFramebuffer()
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GL allocations can fail.
        if (!texture || !framebuffer) {
            gl.deleteTexture(texture)
            gl.deleteFramebuffer(framebuffer)
            throw new Error('Failed to allocate background blur')
        }
        const buffer = { texture, framebuffer, width, height }
        buffers[index] = buffer
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
        blur(
            source: WebGLTexture,
            image: { width: number; height: number },
            width: number,
            height: number,
            sigma: number,
        ) {
            if (sigma <= 0) {
                clear()
                return undefined
            }
            const size = backgroundBlurSize(width, height, sigma)
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
                gl.disable(gl.BLEND)
                let reduced = source
                let sourceWidth = image.width
                let sourceHeight = image.height
                let index = 0
                const innerWidth = size.width / (1 + 2 * size.marginX)
                const innerHeight = size.height / (1 + 2 * size.marginY)
                // Each area covers at most 3x3 texels, including partial edge texels.
                // Reuse the two slots so intermediate reductions stay within 32 MiB.
                while (
                    sourceWidth > Math.max(1, 2 * innerWidth) ||
                    sourceHeight > Math.max(1, 2 * innerHeight)
                ) {
                    const nextWidth = Math.min(
                        sourceWidth,
                        Math.max(Math.ceil(innerWidth), Math.ceil(sourceWidth / 2)),
                    )
                    const nextHeight = Math.min(
                        sourceHeight,
                        Math.max(Math.ceil(innerHeight), Math.ceil(sourceHeight / 2)),
                    )
                    const next = allocate(index, nextWidth, nextHeight)
                    gl.viewport(0, 0, nextWidth, nextHeight)
                    gl.bindFramebuffer(gl.FRAMEBUFFER, next.framebuffer)
                    gl.bindTexture(gl.TEXTURE_2D, reduced)
                    gl.uniform1i(mode, 4)
                    gl.uniform2f(outputSize, nextWidth, nextHeight)
                    gl.drawArrays(gl.TRIANGLES, 0, 3)
                    reduced = next.texture
                    sourceWidth = nextWidth
                    sourceHeight = nextHeight
                    index = 1 - index
                }
                const a = allocate(index, size.width, size.height)
                gl.viewport(0, 0, size.width, size.height)
                gl.bindFramebuffer(gl.FRAMEBUFFER, a.framebuffer)
                gl.bindTexture(gl.TEXTURE_2D, reduced)
                gl.uniform1i(mode, 0)
                gl.uniform2f(margin, size.marginX, size.marginY)
                gl.uniform2f(outputSize, size.width, size.height)
                gl.drawArrays(gl.TRIANGLES, 0, 3)
                const b = allocate(1 - index, size.width, size.height)
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
                cachedBuffer = a
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
