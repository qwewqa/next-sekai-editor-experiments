export type GraphicsLimits = {
    viewport: readonly [number, number]
    renderbuffer: number
    texture: number
}

/** Read in the export worker, where the frames will be drawn. */
export const readGraphicsLimits = (): GraphicsLimits | undefined => {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2')
    if (!gl) return undefined
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
    const limits = {
        viewport: [viewport[0] ?? 0, viewport[1] ?? 0] as const,
        renderbuffer: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
        texture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return limits
}

export const fitsGraphicsLimits = (
    size: { width: number; height: number },
    scale: number,
    antialias: boolean,
    limits: GraphicsLimits,
) => {
    const w = Math.round(size.width * scale)
    const h = Math.round(size.height * scale)
    return (
        w > 0 &&
        h > 0 &&
        w <= limits.viewport[0] &&
        h <= limits.viewport[1] &&
        Math.max(w, h) <= limits.texture &&
        Math.max(size.width, size.height) <= limits.renderbuffer &&
        (!antialias || Math.max(w, h) <= limits.renderbuffer)
    )
}
