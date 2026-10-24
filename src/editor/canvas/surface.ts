import { cancelFrame, isFrameOpen, requestFrame } from '../../frame'
import { onResetState } from '../../history/resetHooks'
import {
    getDrawContext,
    releaseUnusedPaths,
    type RenderSurface,
    type WebGLDrawContext,
} from '../../rendering/context'
import type { CanvasBounds } from './types'

// A new or opened chart leaves the previous one's geometry unused.
onResetState(releaseUnusedPaths)

/** Erases a surface in backing pixels, independently of the scene transform. */
export const clearSurface = (ctx: WebGLDrawContext, width: number, height: number) => {
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.restore()
}

/** Backing dimensions of a surface at least one device pixel across. */
export const deviceSize = (width: number, height: number, pixelRatio: number) =>
    [
        Math.max(1, Math.round(width * pixelRatio)),
        Math.max(1, Math.round(height * pixelRatio)),
    ] as const

// Changing the backing dimensions clears all drawing state and allocates a new
// surface. Only do that on a real resize, never on an ordinary scroll or edit.
export const prepareSurface = (
    canvas: HTMLCanvasElement | RenderSurface,
    width: number,
    height: number,
    pixelRatio: number,
    bounds: CanvasBounds,
    acquire?: () => WebGLDrawContext | undefined,
) => {
    const [w, h] = deviceSize(width, height, pixelRatio)
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const ctx = acquire ? acquire() : getDrawContext(canvas)
    if (!ctx?.isReady || ctx.isContextLost()) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clear()
    const scale = width / bounds.w
    // CSS dimensions and DPR can both be fractional. Use the actual backing
    // dimensions so browser scaling keeps the scene aligned with pointer and
    // DOM coordinates, including at the far edges of the surface.
    const sx = scale * (w / width)
    const sy = scale * (h / height)
    ctx.setTransform(sx, 0, 0, sy, -bounds.l * sx, -bounds.t * sy)
    ctx.lineWidth = 2 / scale
    return ctx
}

// Coalesce all invalidations into the next frame. In particular, do not cancel
// and reschedule on playback updates, which could starve a pending draw. Clock
// updates draw within their own frame (see `requestFrame`).
export const createFrameScheduler = () => {
    let id = 0
    let draw: ((timestamp: number) => void) | undefined
    return {
        schedule(next: (timestamp: number) => void) {
            draw = next
            // A tick takes over a draw requested before it, so that draw counts as the tick's.
            if (id > 0 && isFrameOpen()) cancelFrame(id)
            else if (id) return
            id = requestFrame((timestamp) => {
                id = 0
                const current = draw
                draw = undefined
                current?.(timestamp)
            })
        },
        cancel() {
            cancelFrame(id)
            id = 0
            draw = undefined
        },
    }
}
