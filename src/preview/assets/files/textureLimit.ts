import { LIMITS } from './limits'

let cached: number | undefined

/**
 * The largest texture side the device takes, at most 4096 (`gl.MAX_TEXTURE_SIZE`);
 * read once from a throwaway context, 4096 where there is none.
 */
export const maxTextureSide = () => {
    if (cached !== undefined) return cached
    cached = LIMITS.textureSide
    try {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
        const side = gl?.getParameter(gl.MAX_TEXTURE_SIZE) as unknown
        if (typeof side === 'number' && side > 0) cached = Math.min(side, LIMITS.textureSide)
        gl?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
        // No WebGL here: the cap alone applies.
    }
    return cached
}
