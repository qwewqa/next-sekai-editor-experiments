/** For test builds. The bytes the preview's atlas textures hold in one realm. */
export type TextureAccount = {
    /**
     * The bytes of the skin, particle and background textures, every mip level included, and of
     * the background blur's buffers, in contexts that are not lost.
     */
    bytes: () => number
    /** The preview's `deleteTexture`, `deleteFramebuffer` and `flush` calls, in order. */
    calls: string[]
}

/**
 * Wraps the realm's WebGL2 calls to keep a `TextureAccount`. The page's specs install it from its
 * source, so it refers to nothing outside itself. An atlas is a texture that received an
 * `ImageBitmap`. A blur buffer is storage allocated from the background pass.
 */
export const installTextureAccount = (
    isPreview: (gl: WebGL2RenderingContext) => boolean,
): TextureAccount => {
    // Each texture's levels, as width and height.
    const contexts = new Map<WebGL2RenderingContext, Map<WebGLTexture, [number, number][]>>()
    const calls: string[] = []
    const prototype = WebGL2RenderingContext.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
    >
    const wrap = (name: string, see: (gl: WebGL2RenderingContext, args: unknown[]) => void) => {
        const original = prototype[name]
        if (!original) return
        prototype[name] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
            const result: unknown = Reflect.apply(original, this, args)
            see(this, args)
            return result
        }
    }
    const levelsOf = (gl: WebGL2RenderingContext) => {
        const texture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null
        if (!texture) return
        let textures = contexts.get(gl)
        if (!textures) contexts.set(gl, (textures = new Map<WebGLTexture, [number, number][]>()))
        let levels = textures.get(texture)
        if (!levels) textures.set(texture, (levels = []))
        return levels
    }
    const chain = (levels: [number, number][], width: number, height: number, count: number) => {
        for (let level = 0; level < count; level++) {
            levels[level] = [width, height]
            if (width === 1 && height === 1) break
            width = Math.max(1, width >> 1)
            height = Math.max(1, height >> 1)
        }
    }
    wrap('texImage2D', (gl, args) => {
        const source = args[5]
        if (!isPreview(gl) || args.length !== 6 || !(source instanceof ImageBitmap)) return
        const levels = levelsOf(gl)
        if (levels) levels[args[1] as number] = [source.width, source.height]
    })
    wrap('generateMipmap', (gl) => {
        if (!isPreview(gl)) return
        const levels = levelsOf(gl)
        const base = levels?.[0]
        if (levels && base) chain(levels, base[0], base[1], Infinity)
    })
    wrap('texStorage2D', (gl, [, count, , width, height]) => {
        if (!isPreview(gl) || !new Error().stack?.includes('backgroundPass')) return
        const levels = levelsOf(gl)
        if (levels) chain(levels, width as number, height as number, count as number)
    })
    wrap('deleteTexture', (gl, [texture]) => {
        if (isPreview(gl)) calls.push('deleteTexture')
        contexts.get(gl)?.delete(texture as WebGLTexture)
    })
    wrap('deleteFramebuffer', (gl) => {
        if (isPreview(gl)) calls.push('deleteFramebuffer')
    })
    wrap('flush', (gl) => {
        if (isPreview(gl)) calls.push('flush')
    })
    return {
        bytes: () => {
            let total = 0
            for (const [gl, textures] of contexts)
                if (!gl.isContextLost())
                    for (const levels of textures.values())
                        for (const [width, height] of levels) total += width * height * 4
            return total
        },
        calls,
    }
}
