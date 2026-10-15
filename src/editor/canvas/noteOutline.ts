import type { WebGLDrawContext } from '../../rendering/context'

/** Draw only the flat edges when both rounded ends are outside the entire viewport. */
export const strokeOffscreenAnchorBody = (ctx: WebGLDrawContext, x: number, width: number) => {
    const { a, b, c, d, e, f } = ctx.getTransform()
    const stroke = ctx.lineWidth
    if (
        b ||
        c ||
        !a ||
        !d ||
        width <= 0 ||
        ![a, d, e, f, x, width, stroke].every(Number.isFinite) ||
        typeof ctx.strokeStyle !== 'string' ||
        ctx.globalCompositeOperation !== 'source-over'
    )
        return false
    // Include the stroke's reach and an antialiasing margin. A layer or an
    // inherited clip can only reduce this full-canvas viewport further.
    const radius = Math.min(0.1, width / 2)
    const left = a * (x + radius + stroke / 2) + e
    const right = a * (x + width - radius - stroke / 2) + e
    if (![left, right, ctx.canvas.width].every(Number.isFinite)) return false
    if (Math.min(left, right) >= -2 || Math.max(left, right) <= ctx.canvas.width + 2) return false
    // Two separate strokes are equivalent only while their coverage is disjoint.
    const pixelWidth = stroke * Math.abs(d)
    if (!Number.isFinite(pixelWidth) || (0.3 - stroke) * Math.abs(d) <= 1 || pixelWidth < 1)
        return false
    const edges = [0.15, 0.45].map((y) => {
        const center = d * y + f
        return [
            Math.round((center - pixelWidth / 2) * 4) / 4,
            Math.round((center + pixelWidth / 2) * 4) / 4,
        ] as const
    })
    if (edges.some(([top, bottom]) => !Number.isFinite(top + bottom) || bottom <= top)) return false
    ctx.save()
    try {
        ctx.resetTransform()
        for (const [top, bottom] of edges) {
            // Resolve the four-sample edge coverage before each note is blended.
            // Repeated coincident outlines must accumulate coverage independently.
            ctx.lineWidth = bottom - top
            ctx.strokeLine(-2, (top + bottom) / 2, ctx.canvas.width + 2, (top + bottom) / 2)
        }
    } finally {
        ctx.restore()
    }
    return true
}
