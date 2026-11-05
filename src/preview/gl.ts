import { backgroundColor } from './backgroundBlur'
import { createBackgroundPass } from './backgroundPass'
import type { PreviewFrameInput } from './drawFrame'
import type { Quad } from './engine/math'
import { linkProgram } from './program'
import { createRenderTarget, type RenderTarget, type RenderTargetOptions } from './renderTarget'
import type { Sprite } from './skin'

export type ZKey = readonly number[]

export type Tint = {
    r: number
    g: number
    b: number
}

export const BlendMode = {
    normal: 0,
    additive: 1,
} as const

export type BlendModeValue = (typeof BlendMode)[keyof typeof BlendMode]

/** The renderer's textures: 0 skin, 1 particle, 2 text and 3 background. */
export type TextureSlot = 0 | 1 | 2 | 3

export type PreviewRenderer = {
    maxViewportSize: {
        width: number
        height: number
    }
    /** Throws when the upload fails. */
    setTexture: (index: TextureSlot, texture: ImageBitmap, interpolation: boolean) => void
    /** Replaces the texture in `slot` with a transparent one, with linear filtering. */
    reserveTexture: (slot: TextureSlot, width: number, height: number) => void
    /** Uploads `bitmap` into the texture in `slot`, with its top left corner at `x`, `y`. */
    setTextureRegion: (slot: TextureSlot, x: number, y: number, bitmap: ImageBitmap) => void
    /**
     * Test builds: premultiplied RGBA rows, top first, read from the drawn frame before it is
     * shown, or from the texture in a slot. Coordinates are pixels from the top left corner.
     */
    readPixels: (
        source: 'frame' | TextureSlot,
        x: number,
        y: number,
        width: number,
        height: number,
    ) => Uint8Array
    begin: (width: number, height: number, aspectRatio?: number) => void
    draw: (
        sprite: Sprite | undefined,
        quad: Quad,
        z: ZKey,
        a: number,
        tint?: Tint,
        blend?: BlendModeValue,
    ) => void
    flush: () => void
    isContextLost: () => boolean
    dispose: () => void
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec3 a_uvw;
in float a_texture;
in vec4 a_color;
uniform float u_aspect;
out vec3 v_uvw;
out float v_texture;
out vec4 v_color;
void main() {
    gl_Position = vec4(a_position.x / u_aspect, a_position.y, 0.0, 1.0);
    v_uvw = a_uvw;
    v_texture = a_texture;
    v_color = a_color;
}
`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_texture0;
uniform sampler2D u_texture1;
uniform sampler2D u_texture2;
uniform sampler2D u_texture3;
in vec3 v_uvw;
in float v_texture;
in vec4 v_color;
out vec4 outColor;
void main() {
    vec2 uv = v_uvw.xy / v_uvw.z;
    // The background's mip level comes from derivatives taken outside the branch.
    vec2 uvDx = dFdx(uv);
    vec2 uvDy = dFdy(uv);
    vec4 color = v_texture > 2.5
        ? textureGrad(u_texture3, uv, uvDx, uvDy)
        : v_texture > 1.5
        ? texture(u_texture2, uv)
        : mix(texture(u_texture0, uv), texture(u_texture1, uv), v_texture);
    outColor = vec4(color.rgb * v_color.rgb * v_color.a, color.a * v_color.a);
}
`

const FLOATS_PER_VERTEX = 10
const FLOATS_PER_QUAD = FLOATS_PER_VERTEX * 6

export const perspectiveWeights = (quad: Quad): [number, number, number, number] => {
    const { bl, tl, tr, br } = quad

    const rx = tr.x - bl.x
    const ry = tr.y - bl.y
    const sx = br.x - tl.x
    const sy = br.y - tl.y

    const denominator = rx * sy - ry * sx
    if (Math.abs(denominator) < 1e-12) return [1, 1, 1, 1]

    const qx = tl.x - bl.x
    const qy = tl.y - bl.y
    const t = (qx * sy - qy * sx) / denominator
    const u = (qx * ry - qy * rx) / denominator

    if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return [1, 1, 1, 1]

    const ox = bl.x + t * rx
    const oy = bl.y + t * ry

    const dBl = Math.hypot(bl.x - ox, bl.y - oy)
    const dTl = Math.hypot(tl.x - ox, tl.y - oy)
    const dTr = Math.hypot(tr.x - ox, tr.y - oy)
    const dBr = Math.hypot(br.x - ox, br.y - oy)

    if (dBl < 1e-12 || dTl < 1e-12 || dTr < 1e-12 || dBr < 1e-12) return [1, 1, 1, 1]

    return [1 + dBl / dTr, 1 + dTl / dBr, 1 + dTr / dBl, 1 + dBr / dTl]
}

type Entry = {
    z: ZKey
    order: number
    blend: BlendModeValue
    data: Float32Array
}

const writeVertex = (
    data: Float32Array,
    offset: number,
    x: number,
    y: number,
    u: number,
    v: number,
    w: number,
    texture: number,
    r: number,
    g: number,
    b: number,
    a: number,
) => {
    data[offset] = x
    data[offset + 1] = y
    data[offset + 2] = u * w
    data[offset + 3] = v * w
    data[offset + 4] = w
    data[offset + 5] = texture
    data[offset + 6] = r
    data[offset + 7] = g
    data[offset + 8] = b
    data[offset + 9] = a
}

export type PreviewSurface = PreviewRenderer & {
    prepareFrame: (width: number, height: number) => void
    compositeBackground: (quad: Quad, input: PreviewFrameInput) => void
    hasTexture: (slot: TextureSlot) => boolean
    setRenderTarget: (options: RenderTargetOptions | undefined) => RenderTarget | undefined
    /** The caller owns this single-sample target and presents it after the composite. */
    setCompositeTarget: (target: RenderTarget | undefined) => void
    checkError: () => boolean
}

export const createPreviewRenderer = (
    canvas: HTMLCanvasElement | OffscreenCanvas,
    antialias = true,
): PreviewSurface => {
    const getContext = (antialias: boolean) =>
        (canvas as HTMLCanvasElement).getContext('webgl2', {
            alpha: true,
            antialias,
            premultipliedAlpha: true,
        })
    const gl = getContext(antialias) ?? (antialias ? getContext(false) : null)
    if (!gl) throw new Error('WebGL2 is unavailable or disabled in this browser')

    const textures: WebGLTexture[] = []
    let program: WebGLProgram | null = null
    let buffer: WebGLBuffer | null = null
    let restoreState = false
    let target: RenderTarget | undefined
    let compositeTarget: RenderTarget | undefined
    let backgroundPass: ReturnType<typeof createBackgroundPass> | undefined
    let backgroundIdentity: { width: number; height: number } | undefined
    let disposed = false
    const deleteResources = () => {
        if (disposed) return
        disposed = true
        target?.dispose()
        target = undefined
        backgroundPass?.dispose()
        for (const texture of textures) gl.deleteTexture(texture)
        textures.length = 0
        if (buffer) {
            gl.deleteBuffer(buffer)
            buffer = null
        }
        if (program) {
            gl.useProgram(null)
            gl.deleteProgram(program)
            program = null
        }
        // Explicit deletion also releases resources on implementations without this
        // optional extension; losing the context additionally frees its browser slot.
        gl.getExtension('WEBGL_lose_context')?.loseContext()
    }

    const maxViewportDimensions = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
    const hasTextures = [false, false, false, false]
    let aspectLocation: WebGLUniformLocation | null

    try {
        program = linkProgram(gl, 'preview', VERTEX_SHADER, FRAGMENT_SHADER)
        gl.useProgram(program)

        const positionLocation = gl.getAttribLocation(program, 'a_position')
        const uvwLocation = gl.getAttribLocation(program, 'a_uvw')
        const textureLocation = gl.getAttribLocation(program, 'a_texture')
        const colorLocation = gl.getAttribLocation(program, 'a_color')
        aspectLocation = gl.getUniformLocation(program, 'u_aspect')

        gl.uniform1i(gl.getUniformLocation(program, 'u_texture0'), 0)
        gl.uniform1i(gl.getUniformLocation(program, 'u_texture1'), 1)
        gl.uniform1i(gl.getUniformLocation(program, 'u_texture2'), 2)
        gl.uniform1i(gl.getUniformLocation(program, 'u_texture3'), 3)

        buffer = gl.createBuffer()
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Allocation may fail on a lost/exhausted context despite DOM declarations.
        if (!buffer) throw new Error('Failed to create preview vertex buffer')
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)

        const stride = FLOATS_PER_VERTEX * 4
        gl.enableVertexAttribArray(positionLocation)
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, stride, 0)
        gl.enableVertexAttribArray(uvwLocation)
        gl.vertexAttribPointer(uvwLocation, 3, gl.FLOAT, false, stride, 8)
        gl.enableVertexAttribArray(textureLocation)
        gl.vertexAttribPointer(textureLocation, 1, gl.FLOAT, false, stride, 20)
        gl.enableVertexAttribArray(colorLocation)
        gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, stride, 24)

        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.clearColor(0, 0, 0, 0)

        for (let i = 0; i < 4; i++) {
            const texture = gl.createTexture()
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Allocation may fail on a lost/exhausted context despite DOM declarations.
            if (!texture) throw new Error('Failed to create preview texture')
            textures.push(texture)
            gl.activeTexture(gl.TEXTURE0 + i)
            gl.bindTexture(gl.TEXTURE_2D, texture)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        }
    } catch (error) {
        deleteResources()
        throw error
    }

    const entries: Entry[] = []
    // Keep submission slots separate from the sorted list so every slot is reused once per frame.
    const entryPool: Entry[] = []
    let packedData = new Float32Array(0)

    const inputs = new Array<number>(8)
    const outputs = new Array<number>(8)

    const renderer: PreviewSurface = {
        prepareFrame(width, height) {
            renderer.setRenderTarget({ width, height, antialias: target?.antialias ?? antialias })
        },
        compositeBackground(quad, input) {
            if (!target) throw new Error('No foreground render target')
            const foreground = target.resolve()
            backgroundPass ??= createBackgroundPass(gl)
            const background = input.background
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- All four textures were allocated at initialization.
            const source = textures[3]!
            const blurred =
                background && hasTextures[3] && backgroundIdentity
                    ? backgroundPass.blur(
                          source,
                          backgroundIdentity,
                          input.width,
                          input.height,
                          background.sigma,
                      )
                    : undefined
            if (compositeTarget) compositeTarget.bind()
            else {
                if (canvas.width !== input.width) canvas.width = input.width
                if (canvas.height !== input.height) canvas.height = input.height
                gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            }
            gl.viewport(0, 0, input.width, input.height)
            gl.useProgram(program)
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
            for (let i = 0; i < textures.length; i++) {
                gl.activeTexture(gl.TEXTURE0 + i)
                gl.bindTexture(
                    gl.TEXTURE_2D,
                    i === 3 ? (blurred?.texture ?? source) : (textures[i] ?? null),
                )
            }
            gl.enable(gl.BLEND)
            gl.uniform1f(aspectLocation, input.displayWidth / input.displayHeight)
            const [r, g, b, a] = backgroundColor(background?.color)
            const [br, bg, bb] = (background && input.backdrop) ?? [0, 0, 0]
            gl.clearColor(r + br * (1 - a), g + bg * (1 - a), b + bb * (1 - a), 1)
            entries.length = 0
            if (background && hasTextures[3]) {
                const mx = blurred?.marginX ?? 0
                const my = blurred?.marginY ?? 0
                const place = (x: number, y: number) => ({
                    x: quad.tl.x + (quad.tr.x - quad.tl.x) * x + (quad.bl.x - quad.tl.x) * y,
                    y: quad.tl.y + (quad.tr.y - quad.tl.y) * x + (quad.bl.y - quad.tl.y) * y,
                })
                renderer.draw(
                    { texture: 3, u0: 0, v0: blurred ? 1 : 0, u1: 1, v1: blurred ? 0 : 1 },
                    {
                        tl: place(-mx, -my),
                        tr: place(1 + mx, -my),
                        bl: place(-mx, 1 + my),
                        br: place(1 + mx, 1 + my),
                    },
                    [0],
                    1,
                )
            }
            renderer.flush()
            backgroundPass.composite(foreground, background?.mask)
            restoreState = true
        },
        hasTexture: (slot) => hasTextures[slot] === true,
        setCompositeTarget: (value) => {
            compositeTarget = value
        },
        setRenderTarget(options) {
            if (disposed) throw new Error('Preview renderer is disposed')
            if (
                options &&
                target?.width === options.width &&
                target.height === options.height &&
                target.antialias === options.antialias
            )
                return target
            restoreState = true
            target?.dispose()
            target = undefined
            if (options) target = createRenderTarget(gl, canvas, options)
            return target
        },
        checkError: () => !disposed && !gl.isContextLost() && gl.getError() === gl.NO_ERROR,
        maxViewportSize: {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            width: maxViewportDimensions[0]!,
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            height: maxViewportDimensions[1]!,
        },

        setTexture(index, bitmap, interpolation) {
            if (disposed) return
            // An error left by an earlier call is not the upload's.
            for (let i = 0; i < 16; i++) if (gl.getError() === gl.NO_ERROR) break
            gl.activeTexture(gl.TEXTURE0 + index)
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            gl.bindTexture(gl.TEXTURE_2D, textures[index]!)
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)

            const filter = interpolation ? gl.LINEAR : gl.NEAREST
            // The background is often larger than the panel: mipmaps keep its fine lines from aliasing.
            const mipmapped = index === 3 && interpolation
            if (mipmapped) gl.generateMipmap(gl.TEXTURE_2D)
            gl.texParameteri(
                gl.TEXTURE_2D,
                gl.TEXTURE_MIN_FILTER,
                mipmapped ? gl.LINEAR_MIPMAP_LINEAR : filter,
            )
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
            // A failed allocation is reported here, not by an exception. A lost context is
            // restored instead.
            const error = gl.getError()
            if (error !== gl.NO_ERROR && !gl.isContextLost())
                throw new Error(`Preview texture upload failed with GL error ${error}`)

            hasTextures[index] = true
            if (index === 3) backgroundIdentity = { width: bitmap.width, height: bitmap.height }
        },

        reserveTexture(slot, width, height) {
            if (disposed) return
            gl.activeTexture(gl.TEXTURE0 + slot)
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            gl.bindTexture(gl.TEXTURE_2D, textures[slot]!)
            gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                width,
                height,
                0,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                null,
            )
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
            hasTextures[slot] = true
        },

        setTextureRegion(slot, x, y, bitmap) {
            if (disposed) return
            gl.activeTexture(gl.TEXTURE0 + slot)
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            gl.bindTexture(gl.TEXTURE_2D, textures[slot]!)
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
            gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
        },

        readPixels(source, x, y, width, height) {
            const pixels = new Uint8Array(width * height * 4)
            if (disposed) return pixels
            if (source === 'frame') {
                target?.resolve()
                gl.readPixels(
                    x,
                    (target?.height ?? gl.drawingBufferHeight) - y - height,
                    width,
                    height,
                    gl.RGBA,
                    gl.UNSIGNED_BYTE,
                    pixels,
                )
                // The drawing buffer's rows start at the bottom.
                const row = width * 4
                const flipped = new Uint8Array(pixels.length)
                for (let i = 0; i < height; i++)
                    flipped.set(pixels.subarray(i * row, (i + 1) * row), (height - 1 - i) * row)
                return flipped
            }
            const framebuffer = gl.createFramebuffer()
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
            gl.framebufferTexture2D(
                gl.FRAMEBUFFER,
                gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D,
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                textures[source]!,
                0,
            )
            // A texture's rows start at the top of the image uploaded to it.
            gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            gl.deleteFramebuffer(framebuffer)
            return pixels
        },

        begin(width, height, aspectRatio = width / height) {
            if (disposed) return
            if (target) {
                if (width !== target.width || height !== target.height)
                    throw new Error('Preview frame size differs from its render target')
                target.bind()
            } else {
                if (canvas.width !== width) canvas.width = width
                if (canvas.height !== height) canvas.height = height
            }

            if (restoreState) {
                gl.useProgram(program)
                gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
                for (let i = 0; i < textures.length; i++) {
                    gl.activeTexture(gl.TEXTURE0 + i)
                    gl.bindTexture(gl.TEXTURE_2D, textures[i] ?? null)
                }
                gl.enable(gl.BLEND)
                if (!target) restoreState = false
            }
            gl.viewport(0, 0, width, height)
            gl.clearColor(0, 0, 0, 0)
            gl.uniform1f(aspectLocation, aspectRatio)

            entries.length = 0
        },

        draw(sprite, quad, z, a, tint, blend = BlendMode.normal) {
            if (disposed) return
            if (!sprite) return
            if (a <= 0) return
            if (!hasTextures[sprite.texture ?? 0]) return

            let { bl, tl, tr, br } = quad

            if (sprite.transform) {
                const m = sprite.transform

                inputs[0] = bl.x
                inputs[1] = tl.x
                inputs[2] = tr.x
                inputs[3] = br.x
                inputs[4] = bl.y
                inputs[5] = tl.y
                inputs[6] = tr.y
                inputs[7] = br.y

                for (let i = 0; i < 8; i++) {
                    let value = 0
                    for (let j = 0; j < 8; j++) {
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        value += m[i * 8 + j]! * inputs[j]!
                    }
                    outputs[i] = value
                }

                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                bl = { x: outputs[0]!, y: outputs[4]! }
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                tl = { x: outputs[1]!, y: outputs[5]! }
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                tr = { x: outputs[2]!, y: outputs[6]! }
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                br = { x: outputs[3]!, y: outputs[7]! }
            }

            const [wBl, wTl, wTr, wBr] = perspectiveWeights({ bl, tl, tr, br })

            const { u0, v0, u1, v1 } = sprite
            const tex = sprite.texture ?? 0
            const r = tint?.r ?? 1
            const g = tint?.g ?? 1
            const b = tint?.b ?? 1

            const order = entries.length
            let entry = entryPool[order]
            if (!entry) {
                entry = { z, order, blend, data: new Float32Array(FLOATS_PER_QUAD) }
                entryPool.push(entry)
            }
            entry.z = z
            entry.blend = blend

            const { data } = entry
            writeVertex(data, 0, bl.x, bl.y, u0, v1, wBl, tex, r, g, b, a)
            writeVertex(data, 10, tl.x, tl.y, u0, v0, wTl, tex, r, g, b, a)
            writeVertex(data, 20, tr.x, tr.y, u1, v0, wTr, tex, r, g, b, a)
            data.copyWithin(30, 0, 10)
            data.copyWithin(40, 20, 30)
            writeVertex(data, 50, br.x, br.y, u1, v1, wBr, tex, r, g, b, a)
            entries.push(entry)
        },

        flush() {
            if (disposed) return
            gl.clear(gl.COLOR_BUFFER_BIT)

            if (!entries.length) return

            entries.sort((a, b) => {
                const length = Math.max(a.z.length, b.z.length)
                for (let i = 0; i < length; i++) {
                    const diff = (a.z[i] ?? 0) - (b.z[i] ?? 0)
                    if (diff) return diff
                }
                return a.order - b.order
            })

            const length = entries.length * FLOATS_PER_QUAD
            if (length > packedData.length) {
                packedData = new Float32Array(
                    Math.max(length, packedData.length * 2, FLOATS_PER_QUAD * 256),
                )
                gl.bufferData(gl.ARRAY_BUFFER, packedData.byteLength, gl.DYNAMIC_DRAW)
            }

            for (let i = 0; i < entries.length; i++) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                packedData.set(entries[i]!.data, i * FLOATS_PER_QUAD)
            }

            gl.bufferSubData(gl.ARRAY_BUFFER, 0, packedData.subarray(0, length))

            const setBlend = (blend: BlendModeValue) => {
                if (blend === BlendMode.additive) {
                    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
                } else {
                    gl.blendFuncSeparate(
                        gl.ONE,
                        gl.ONE_MINUS_SRC_ALPHA,
                        gl.ONE,
                        gl.ONE_MINUS_SRC_ALPHA,
                    )
                }
            }

            let runStart = 0
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            let runBlend = entries[0]!.blend
            for (let i = 1; i <= entries.length; i++) {
                const entry = entries[i]
                if (entry?.blend === runBlend) continue

                setBlend(runBlend)
                gl.drawArrays(gl.TRIANGLES, runStart * 6, (i - runStart) * 6)

                if (entry) {
                    runStart = i
                    runBlend = entry.blend
                }
            }
        },

        isContextLost: () => disposed || gl.isContextLost(),

        dispose: () => {
            deleteResources()
            entries.length = 0
            entryPool.length = 0
            packedData = new Float32Array(0)
        },
    }
    return renderer
}
