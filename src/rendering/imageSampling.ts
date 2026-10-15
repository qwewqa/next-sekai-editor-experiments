type SourceRect = readonly [x: number, y: number, width: number, height: number]
export type ImageRegion = { x: number; y: number; width: number; height: number }
type Mip = {
    texture: WebGLTexture
    width: number
    height: number
    originX: number
    originY: number
    fullWidth: number
    fullHeight: number
}

/** High-quality cover resampling with explicit, tile-consistent mip filtering. */
export class ImageSampler {
    readonly canvas = document.createElement('canvas')
    readonly maxTextureSize: number
    readonly maxSurfaceSize: number

    private readonly gl: WebGL2RenderingContext
    private readonly quad: WebGLBuffer
    private readonly framebuffer: WebGLFramebuffer
    private readonly mipProgram: WebGLProgram
    private readonly sampleProgram: WebGLProgram
    private readonly mips: Mip[] = []
    private disposed = false
    private readonly onContextLost = () => {
        this.dispose()
    }

    constructor() {
        this.canvas.width = this.canvas.height = 1
        const options: WebGLContextAttributes = {
            alpha: true,
            antialias: false,
            depth: false,
            stencil: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: true,
        }
        const gl = this.canvas.getContext('webgl2', options)
        if (!gl) throw new Error('Unable to initialize the WebGL2 cover image sampler')
        this.gl = gl
        // Bound a working RGBA texture to 64 MiB even when the device allows 16K images.
        // Larger sources/outputs use the existing decode and tiled export paths.
        this.maxTextureSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, 4096)
        const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
        this.maxSurfaceSize = Math.min(
            this.maxTextureSize,
            gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
            ...viewport,
        )
        const vertex = `#version 300 es
in vec2 a_position;out vec2 v_uv;uniform float u_flip;
void main(){gl_Position=vec4(a_position,0.,1.);v_uv=vec2((a_position.x+1.)*.5,(1.+a_position.y*(1.-2.*u_flip))*.5);}`
        const mipFragment = `#version 300 es
precision highp float;out vec4 outColor;
uniform sampler2D u_source;uniform vec2 u_sourceSize;uniform vec2 u_kernelSize;uniform vec2 u_offset;
void main(){
    vec2 start=floor(gl_FragCoord.xy)*2.+u_offset;
    vec3 wx=u_kernelSize.x<1.5?vec3(1.,0.,0.):(u_kernelSize.x<2.5?vec3(1.,1.,0.):vec3(1.,2.,1.));
    vec3 wy=u_kernelSize.y<1.5?vec3(1.,0.,0.):(u_kernelSize.y<2.5?vec3(1.,1.,0.):vec3(1.,2.,1.));
    vec4 sum=vec4(0.);
    for(int y=0;y<3;y++)for(int x=0;x<3;x++)sum+=texture(u_source,(start+vec2(float(x),float(y))+.5)/u_sourceSize)*wx[x]*wy[y];
    float divisor=(wx.x+wx.y+wx.z)*(wy.x+wy.y+wy.z);
    outColor=floor(sum*(255./divisor)+.0001)/255.;
}`
        const sampleFragment = `#version 300 es
precision highp float;out vec4 outColor;in vec2 v_uv;
uniform sampler2D u_first;uniform sampler2D u_second;uniform vec4 u_rectFirst;uniform vec4 u_rectSecond;
uniform vec4 u_clampFirst;uniform vec4 u_clampSecond;uniform vec2 u_sourceSize;
uniform float u_mix;uniform float u_cubic;uniform float u_premultiply;
float mitchell(float x){x=abs(x);if(x<1.)return (7.*x*x*x-12.*x*x+16./3.)/6.;if(x<2.)return (-7.*x*x*x/3.+12.*x*x-20.*x+32./3.)/6.;return 0.;}
void main(){
    vec2 uv=u_rectFirst.xy+v_uv*u_rectFirst.zw;
    if(u_cubic>.5){
        vec2 p=uv*u_sourceSize-.5,base=floor(p);vec4 color=vec4(0.);
        for(int y=0;y<4;y++)for(int x=0;x<4;x++){
            vec2 pixel=base+vec2(float(x)-1.,float(y)-1.);
            color+=texture(u_first,clamp((pixel+.5)/u_sourceSize,.5/u_sourceSize,1.-.5/u_sourceSize))*mitchell(p.x-pixel.x)*mitchell(p.y-pixel.y);
        }
        color.a=clamp(color.a,0.,1.);outColor=vec4(clamp(color.rgb,vec3(0.),vec3(color.a)),color.a);
    }else{
        vec4 a=texture(u_first,clamp(uv,u_clampFirst.xy,u_clampFirst.zw));
        vec4 b=texture(u_second,clamp(u_rectSecond.xy+v_uv*u_rectSecond.zw,u_clampSecond.xy,u_clampSecond.zw));
        outColor=mix(a,b,u_mix);
    }
    outColor.rgb*=mix(1.,outColor.a,u_premultiply);
}`
        const createdPrograms: WebGLProgram[] = []
        let quad: WebGLBuffer | null = null
        let framebuffer: WebGLFramebuffer | null = null
        try {
            this.mipProgram = this.compile(vertex, mipFragment)
            createdPrograms.push(this.mipProgram)
            this.sampleProgram = this.compile(vertex, sampleFragment)
            createdPrograms.push(this.sampleProgram)
            quad = this.required(gl.createBuffer(), 'buffer')
            framebuffer = this.required(gl.createFramebuffer(), 'framebuffer')
            this.quad = quad
            this.framebuffer = framebuffer
            gl.bindBuffer(gl.ARRAY_BUFFER, quad)
            gl.bufferData(
                gl.ARRAY_BUFFER,
                new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
                gl.STATIC_DRAW,
            )
            this.checkError('initialize the cover sampler')
            this.canvas.addEventListener('webglcontextlost', this.onContextLost)
        } catch (error) {
            for (const program of createdPrograms) gl.deleteProgram(program)
            if (quad) gl.deleteBuffer(quad)
            if (framebuffer) gl.deleteFramebuffer(framebuffer)
            gl.getExtension('WEBGL_lose_context')?.loseContext()
            throw error
        }
    }

    /** The caller specifies the bitmap's alpha storage; WebGL ignores bitmap unpack flags. */
    setSource(source: ImageBitmap, region?: ImageRegion, straightAlpha = false): void {
        this.assertAvailable()
        this.validateSize(source.width, source.height, this.maxTextureSize)
        if (
            region &&
            (!Object.values(region).every(Number.isInteger) ||
                region.x < 0 ||
                region.y < 0 ||
                region.x + source.width > region.width ||
                region.y + source.height > region.height)
        )
            throw new RangeError('The cover tile is outside its full image')
        const mip = this.allocate(source.width, source.height, false)
        if (region)
            Object.assign(mip, {
                originX: region.x,
                originY: region.y,
                fullWidth: region.width,
                fullHeight: region.height,
            })
        const gl = this.gl
        try {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
            if (gl.getError() !== gl.NO_ERROR) throw new Error('Unable to upload the cover image')
        } catch (error) {
            gl.deleteTexture(mip.texture)
            throw error
        }
        for (const old of this.mips) gl.deleteTexture(old.texture)
        this.mips.length = 0
        this.mips.push(mip)
        if (straightAlpha) {
            // Cropped bitmap-to-bitmap premultiplication is inconsistent across
            // browsers. Materialize straight-alpha tiles and convert exactly once
            // at texel centers before any interpolation or mip filtering.
            this.renderInternal(
                [0, 0, source.width, source.height],
                source.width,
                source.height,
                source.width,
                source.height,
                0,
                0,
                true,
                false,
                true,
            )
            this.replaceWithDrawingBuffer(source.width, source.height, mip)
        }
    }

    render(
        rect: SourceRect,
        width: number,
        height: number,
        drawWidth = width,
        drawHeight = height,
        offsetX = 0,
        offsetY = 0,
    ): void {
        this.renderInternal(
            rect,
            width,
            height,
            drawWidth,
            drawHeight,
            offsetX,
            offsetY,
            false,
            true,
        )
    }

    /** Match the browser's ceil-sized upload prefilter before final trilinear sampling. */
    prefilter(width: number, height: number): void {
        const base = this.mips[0]
        if (!base) throw new Error('The cover image sampler has no source')
        if (
            base.originX ||
            base.originY ||
            base.width !== base.fullWidth ||
            base.height !== base.fullHeight
        )
            throw new Error('Cover prefiltering requires a complete source image')
        this.renderInternal(
            [0, 0, base.width, base.height],
            width,
            height,
            width,
            height,
            0,
            0,
            true,
            false,
        )
        this.replaceWithDrawingBuffer(width, height)
    }

    private replaceWithDrawingBuffer(width: number, height: number, region?: Mip): void {
        const gl = this.gl,
            filtered = this.allocate(width, height)
        if (region)
            Object.assign(filtered, {
                originX: region.originX,
                originY: region.originY,
                fullWidth: region.fullWidth,
                fullHeight: region.fullHeight,
            })
        try {
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height)
            if (gl.getError() !== gl.NO_ERROR)
                throw new Error('Unable to prefilter the cover image')
        } catch (error) {
            gl.deleteTexture(filtered.texture)
            throw error
        }
        for (const mip of this.mips) gl.deleteTexture(mip.texture)
        this.mips.length = 0
        this.mips.push(filtered)
    }

    private renderInternal(
        rect: SourceRect,
        width: number,
        height: number,
        drawWidth: number,
        drawHeight: number,
        offsetX: number,
        offsetY: number,
        nearestMip: boolean,
        flip: boolean,
        premultiply = false,
    ): void {
        this.assertAvailable()
        this.validateSize(width, height, this.maxSurfaceSize)
        const base = this.mips[0]
        if (!base) throw new Error('The cover image sampler has no source')
        const [x, y, sw, sh] = rect
        if (
            !rect.every(Number.isFinite) ||
            sw <= 0 ||
            sh <= 0 ||
            ![drawWidth, drawHeight, offsetX, offsetY].every(Number.isFinite) ||
            drawWidth <= 0 ||
            drawHeight <= 0 ||
            x >= base.width ||
            y >= base.height ||
            x + sw <= 0 ||
            y + sh <= 0
        )
            throw new RangeError('The cover source rectangle is outside the image')
        const cubic = !nearestMip && drawWidth > sw && drawHeight > sh
        const lod = cubic
            ? 0
            : Math.max(
                  Math.log2(
                      nearestMip
                          ? Math.sqrt((sw / drawWidth) * (sh / drawHeight))
                          : Math.max(sw / drawWidth, sh / drawHeight),
                  ) - 0.5,
                  0,
              )
        const firstLevel = Math.min(
            nearestMip ? Math.round(lod) : Math.floor(lod),
            Math.floor(Math.log2(Math.max(base.fullWidth, base.fullHeight))),
        )
        const secondLevel = Math.min(
            nearestMip ? Math.round(lod) : Math.ceil(lod),
            Math.floor(Math.log2(Math.max(base.fullWidth, base.fullHeight))),
        )
        this.ensureMip(secondLevel)
        const first = this.mips[firstLevel],
            second = this.mips[secondLevel]
        if (!first || !second) throw new Error('Unable to prepare the cover mip levels')
        this.canvas.width = width
        this.canvas.height = height
        const gl = this.gl,
            program = this.sampleProgram
        if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height)
            throw new Error('Unable to allocate the cover drawing buffer')
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, width, height)
        this.use(program)
        gl.uniform1f(gl.getUniformLocation(program, 'u_flip'), flip ? 1 : 0)
        const bind = (mip: Mip, index: number) => {
            gl.activeTexture(gl.TEXTURE0 + index)
            gl.bindTexture(gl.TEXTURE_2D, mip.texture)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, cubic ? gl.NEAREST : gl.LINEAR)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, cubic ? gl.NEAREST : gl.LINEAR)
        }
        bind(first, 0)
        bind(second, 1)
        gl.uniform1i(gl.getUniformLocation(program, 'u_first'), 0)
        gl.uniform1i(gl.getUniformLocation(program, 'u_second'), 1)
        const rectangle = (name: string, mip: Mip) => {
            const scaleX = mip.fullWidth / base.fullWidth,
                scaleY = mip.fullHeight / base.fullHeight
            gl.uniform4f(
                gl.getUniformLocation(program, name),
                ((x + base.originX + (offsetX * sw) / drawWidth) * scaleX - mip.originX) /
                    mip.width,
                ((y + base.originY + (offsetY * sh) / drawHeight) * scaleY - mip.originY) /
                    mip.height,
                (((sw * width) / drawWidth) * scaleX) / mip.width,
                (((sh * height) / drawHeight) * scaleY) / mip.height,
            )
        }
        rectangle('u_rectFirst', first)
        rectangle('u_rectSecond', second)
        const clamp = (name: string, mip: Mip) => {
            const scaleX = mip.fullWidth / base.fullWidth,
                scaleY = mip.fullHeight / base.fullHeight
            const left =
                    Math.max(0, ((x + base.originX) * scaleX - mip.originX) / mip.width) +
                    0.5 / mip.width,
                right =
                    Math.min(1, ((x + sw + base.originX) * scaleX - mip.originX) / mip.width) -
                    0.5 / mip.width
            const top =
                    Math.max(0, ((y + base.originY) * scaleY - mip.originY) / mip.height) +
                    0.5 / mip.height,
                bottom =
                    Math.min(1, ((y + sh + base.originY) * scaleY - mip.originY) / mip.height) -
                    0.5 / mip.height
            gl.uniform4f(
                gl.getUniformLocation(program, name),
                Math.min(left, (left + right) / 2),
                Math.min(top, (top + bottom) / 2),
                Math.max(right, (left + right) / 2),
                Math.max(bottom, (top + bottom) / 2),
            )
        }
        clamp('u_clampFirst', first)
        clamp('u_clampSecond', second)
        gl.uniform2f(gl.getUniformLocation(program, 'u_sourceSize'), base.width, base.height)
        gl.uniform1f(
            gl.getUniformLocation(program, 'u_mix'),
            secondLevel === firstLevel ? 0 : lod - Math.floor(lod),
        )
        gl.uniform1f(gl.getUniformLocation(program, 'u_cubic'), cubic ? 1 : 0)
        gl.uniform1f(gl.getUniformLocation(program, 'u_premultiply'), premultiply ? 1 : 0)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        this.checkError('draw the cover image')
    }

    /** Returns top-down, straight-alpha RGBA for the PNG stripe encoder. */
    readPixels(x: number, y: number, width: number, height: number): Uint8Array {
        this.assertAvailable()
        this.validateSize(width, height, this.maxSurfaceSize)
        if (
            !Number.isInteger(x) ||
            !Number.isInteger(y) ||
            x < 0 ||
            y < 0 ||
            x + width > this.canvas.width ||
            y + height > this.canvas.height
        )
            throw new RangeError('The cover readback rectangle is outside the canvas')
        const gl = this.gl,
            bytes = new Uint8Array(width * height * 4),
            output = new Uint8Array(bytes.length)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.readPixels(
            x,
            this.canvas.height - y - height,
            width,
            height,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            bytes,
        )
        this.assertAvailable()
        this.checkError('read the cover image')
        for (let row = 0; row < height; row++) {
            const offset = (height - row - 1) * width * 4
            for (let column = 0; column < width; column++) {
                const from = offset + column * 4,
                    to = (row * width + column) * 4,
                    alpha = bytes[from + 3] ?? 0
                output[to + 3] = alpha
                if (!alpha) continue
                for (let channel = 0; channel < 3; channel++)
                    output[to + channel] = Math.min(
                        255,
                        Math.round(((bytes[from + channel] ?? 0) * 255) / alpha),
                    )
            }
        }
        return output
    }

    /** Keep the small shader/quad resources, but no source pixels or large drawing buffer. */
    releaseSource(): void {
        this.assertAvailable()
        const gl = this.gl
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        for (const mip of this.mips) gl.deleteTexture(mip.texture)
        this.mips.length = 0
        for (let unit = 0; unit < 2; unit++) {
            gl.activeTexture(gl.TEXTURE0 + unit)
            gl.bindTexture(gl.TEXTURE_2D, null)
        }
        this.canvas.width = this.canvas.height = 1
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
        const gl = this.gl
        for (const mip of this.mips) gl.deleteTexture(mip.texture)
        this.mips.length = 0
        gl.deleteFramebuffer(this.framebuffer)
        gl.deleteBuffer(this.quad)
        gl.deleteProgram(this.mipProgram)
        gl.deleteProgram(this.sampleProgram)
        this.canvas.width = this.canvas.height = 1
        gl.getExtension('WEBGL_lose_context')?.loseContext()
    }

    isContextLost(): boolean {
        return this.disposed || this.gl.isContextLost()
    }

    private ensureMip(level: number): void {
        const gl = this.gl
        while (this.mips.length <= level) {
            const source = this.mips[this.mips.length - 1]
            if (!source) throw new Error('The cover image sampler has no source')
            const axis = (size: number, origin: number, full: number) => {
                if (full === 1) return { size: 1, origin: 0, full: 1, offset: 0, kernel: 1 }
                const nextOrigin = Math.ceil(origin / 2),
                    offset = nextOrigin * 2 - origin,
                    kernel = full % 2 ? 3 : 2
                const nextSize = Math.min(
                    Math.floor(full / 2) - nextOrigin,
                    Math.floor((size - offset - kernel) / 2) + 1,
                )
                if (nextSize < 1) throw new Error('The cover tile has insufficient mip padding')
                return {
                    size: nextSize,
                    origin: nextOrigin,
                    full: Math.floor(full / 2),
                    offset,
                    kernel,
                }
            }
            const x = axis(source.width, source.originX, source.fullWidth),
                y = axis(source.height, source.originY, source.fullHeight)
            const target = this.allocate(x.size, y.size)
            Object.assign(target, {
                originX: x.origin,
                originY: y.origin,
                fullWidth: x.full,
                fullHeight: y.full,
            })
            try {
                gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
                gl.framebufferTexture2D(
                    gl.FRAMEBUFFER,
                    gl.COLOR_ATTACHMENT0,
                    gl.TEXTURE_2D,
                    target.texture,
                    0,
                )
                if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
                    throw new Error('Incomplete cover mip target')
                gl.viewport(0, 0, target.width, target.height)
                this.use(this.mipProgram)
                gl.activeTexture(gl.TEXTURE0)
                gl.bindTexture(gl.TEXTURE_2D, source.texture)
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
                gl.uniform1i(gl.getUniformLocation(this.mipProgram, 'u_source'), 0)
                gl.uniform2f(
                    gl.getUniformLocation(this.mipProgram, 'u_sourceSize'),
                    source.width,
                    source.height,
                )
                gl.uniform2f(
                    gl.getUniformLocation(this.mipProgram, 'u_kernelSize'),
                    x.kernel,
                    y.kernel,
                )
                gl.uniform2f(gl.getUniformLocation(this.mipProgram, 'u_offset'), x.offset, y.offset)
                gl.drawArrays(gl.TRIANGLES, 0, 6)
                this.checkError('generate a cover mip level')
                this.mips.push(target)
            } catch (error) {
                gl.deleteTexture(target.texture)
                throw error
            } finally {
                gl.framebufferTexture2D(
                    gl.FRAMEBUFFER,
                    gl.COLOR_ATTACHMENT0,
                    gl.TEXTURE_2D,
                    null,
                    0,
                )
            }
        }
    }

    private allocate(width: number, height: number, pixels = true): Mip {
        const gl = this.gl,
            texture = this.required(gl.createTexture(), 'texture')
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        if (pixels)
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
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        try {
            this.checkError('allocate a cover texture')
        } catch (error) {
            gl.deleteTexture(texture)
            throw error
        }
        return {
            texture,
            width,
            height,
            originX: 0,
            originY: 0,
            fullWidth: width,
            fullHeight: height,
        }
    }

    private use(program: WebGLProgram): void {
        const gl = this.gl
        gl.useProgram(program)
        gl.disable(gl.BLEND)
        gl.disable(gl.DEPTH_TEST)
        gl.disable(gl.STENCIL_TEST)
        gl.disable(gl.SCISSOR_TEST)
        gl.disable(gl.DITHER)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
        const position = gl.getAttribLocation(program, 'a_position')
        gl.enableVertexAttribArray(position)
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    }

    private compile(vertex: string, fragment: string): WebGLProgram {
        const gl = this.gl,
            program = this.required(gl.createProgram(), 'shader program'),
            shaders: WebGLShader[] = []
        try {
            for (const [type, source] of [
                [gl.VERTEX_SHADER, vertex],
                [gl.FRAGMENT_SHADER, fragment],
            ] as const) {
                const shader = gl.createShader(type)
                if (!shader) throw new Error('Unable to allocate a cover shader')
                shaders.push(shader)
                gl.shaderSource(shader, source)
                gl.compileShader(shader)
                if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
                    throw new Error(
                        gl.getShaderInfoLog(shader) ?? 'Cover shader compilation failed',
                    )
                gl.attachShader(program, shader)
            }
            gl.linkProgram(program)
            if (!gl.getProgramParameter(program, gl.LINK_STATUS))
                throw new Error(gl.getProgramInfoLog(program) ?? 'Cover shader linking failed')
            return program
        } catch (error) {
            gl.deleteProgram(program)
            throw error
        } finally {
            for (const shader of shaders) gl.deleteShader(shader)
        }
    }

    private validateSize(width: number, height: number, limit: number): void {
        if (
            !Number.isInteger(width) ||
            !Number.isInteger(height) ||
            width <= 0 ||
            height <= 0 ||
            width > limit ||
            height > limit
        )
            throw new RangeError(`Cover image dimensions must be integers in 1..${limit}`)
    }

    private required<T>(value: T | null, label: string): T {
        if (!value) throw new Error(`Unable to allocate a cover ${label}`)
        return value
    }

    private checkError(action: string): void {
        const error = this.gl.getError()
        if (error !== this.gl.NO_ERROR)
            throw new Error(`Unable to ${action} (WebGL error ${error})`)
    }

    private assertAvailable(): void {
        if (this.disposed) throw new Error('The cover image sampler has been disposed')
        if (this.gl.isContextLost()) throw new Error('The cover image sampler context is lost')
    }
}
