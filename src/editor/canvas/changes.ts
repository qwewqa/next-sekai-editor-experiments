import type { Entity } from '../../state/entities'
import { beatToTime } from '../../state/integrals/bpms'
import type { ChangeMarks } from '../history/changes'
import { changeShape, type ChangeShape } from './changeGeometry'
import type { EditorDrawContext } from './types'

// A History entry's changes on the editing chart (Part 1 §1.4.11): an orange ring 3 px outside
// what changed, with an ink edge; `+` and `−` badges for added and removed; ghosts of old notes at
// 35% in a dashed ring; dashed lines where events were removed. Shape carries the meaning, so the
// one colour is the hue none of the chart's objects use. Not drawn in Preview.

export const CHANGE_COLOR = '#ff9b42'
const INK = 'rgba(14, 15, 28, 0.8)'
const GHOST_OPACITY = 0.35
/** Ring and edge, in px: 3 px gap, a 2 px ring, a 1.5 px ink edge. */
const GAP = 3
const RING = 2
const EDGE = 1.5

type Box = { x: number; y: number; w: number; h: number }

let palette: { color: string; ink: string } | undefined
const colors = () => {
    if (typeof matchMedia === 'undefined' || !matchMedia('(forced-colors: active)').matches)
        return { color: CHANGE_COLOR, ink: INK }
    if (!palette) {
        const probe = document.createElement('span')
        probe.style.cssText = 'color:CanvasText;background:Canvas;position:fixed;visibility:hidden'
        document.body.append(probe)
        const style = getComputedStyle(probe)
        palette = { color: style.color, ink: style.backgroundColor }
        probe.remove()
    }
    return palette
}

const grow = (box: Box, by: number): Box => ({
    x: box.x - by,
    y: box.y - by,
    w: box.w + 2 * by,
    h: box.h + 2 * by,
})

const contour = (context: EditorDrawContext, shape: ChangeShape, by: number) => {
    const { ctx } = context
    const box = grow(shape, by)
    const cx = shape.x + shape.w / 2
    const cy = shape.y + shape.h / 2
    ctx.beginPath()
    if (shape.kind === 'note') {
        const radius = (shape.radius ?? 0.1) + by
        ctx.roundRect(box.x, box.y, box.w, box.h, {
            x: Math.min(radius, box.w / 2),
            y: Math.min(radius, box.h / 2),
        })
    } else if (shape.kind === 'circle') {
        ctx.ellipse(cx, cy, box.w / 2, box.h / 2, 0, 0, Math.PI * 2)
    } else if (shape.points) {
        shape.points.forEach(([x, y], i) => {
            const px = cx + ((x - cx) * box.w) / shape.w
            const py = cy + ((y - cy) * box.h) / shape.h
            if (i) ctx.lineTo(px, py)
            else ctx.moveTo(px, py)
        })
        ctx.closePath()
    } else if (shape.kind === 'diamond') {
        ctx.moveTo(cx, box.y)
        ctx.lineTo(box.x + box.w, cy)
        ctx.lineTo(cx, box.y + box.h)
        ctx.lineTo(box.x, cy)
        ctx.closePath()
    } else if (shape.kind === 'range') {
        const r = shape.h / 2 + by
        const left = shape.x + shape.h / 2
        const right = shape.x + shape.w - shape.h / 2
        ctx.moveTo(left + r, cy)
        ctx.lineTo(right - r, cy)
        ctx.moveTo(left + r, cy)
        ctx.arc(left, cy, r, 0, Math.PI * 2)
        ctx.moveTo(right + r, cy)
        ctx.arc(right, cy, r, 0, Math.PI * 2)
    } else {
        ctx.moveTo(box.x + box.w, box.y)
        ctx.lineTo(box.x, box.y)
        ctx.lineTo(box.x, box.y + box.h)
        ctx.lineTo(box.x + box.w, box.y + box.h)
    }
    ctx.stroke()
}

const ring = (context: EditorDrawContext, shape: ChangeShape, dashed: boolean) => {
    const { ctx, scale } = context
    const px = 1 / scale
    ctx.save()
    ctx.setLineDash(dashed ? [4 * px, 3 * px] : [])
    ctx.lineWidth = EDGE * px
    ctx.strokeStyle = colors().ink
    contour(context, shape, (GAP + RING + EDGE / 2) * px)
    ctx.lineWidth = RING * px
    ctx.strokeStyle = colors().color
    contour(context, shape, (GAP + RING / 2) * px)
    ctx.restore()
}

/** A `+` or `−` badge at the box's top right, kept inside the pane. */
const badge = (context: EditorDrawContext, box: Box, glyph: '+' | '−') => {
    const { ctx, scale, bounds } = context
    const px = 1 / scale
    // Smaller on short notes, as on phones.
    const radius = (box.h * scale < 22 ? 7 : 9) * px
    const outer = grow(box, (GAP + RING) * px)
    const top = Math.min(outer.y, outer.y + outer.h)
    const x = Math.min(Math.max(outer.x + outer.w, bounds.l + radius), bounds.r - radius)
    const y = Math.min(Math.max(top, bounds.t + radius), bounds.b - radius)
    ctx.save()
    ctx.setLineDash([])
    ctx.fillStyle = colors().color
    ctx.fillCircle(x, y, radius)
    ctx.lineWidth = EDGE * px
    ctx.strokeStyle = colors().ink
    ctx.strokeCircle(x, y, radius)
    ctx.lineWidth = 2 * px
    ctx.lineCap = 'round'
    const arm = radius * 0.5
    ctx.strokeLine(x - arm, y, x + arm, y)
    if (glyph === '+') ctx.strokeLine(x, y - arm, x, y + arm)
    ctx.restore()
}

/** Only visit the sorted marks in the viewport, including the contour margin. */
const visible = <T extends { entity: Entity }>(marks: readonly T[], min: number, max: number) => {
    let low = 0
    let high = marks.length
    while (low < high) {
        const mid = (low + high) >> 1
        if ((marks[mid]?.entity.beat ?? Infinity) < min) low = mid + 1
        else high = mid
    }
    const result: T[] = []
    for (let i = low; i < marks.length; i++) {
        const mark = marks[i]
        if (!mark || mark.entity.beat > max) break
        result.push(mark)
    }
    return result
}

/**
 * Draws the marks for objects in `[min, max]` beats: ghosts first, then rings and badges.
 * `isShown` leaves out what a hidden group or stage hides; `drawGhost` draws an old note.
 */
export const drawChangeMarks = (
    context: EditorDrawContext,
    marks: ChangeMarks,
    min: number,
    max: number,
    isShown: (entity: Entity) => boolean,
    drawGhost: (context: EditorDrawContext, entity: Entity, opacity: number) => void,
) => {
    const badges: { context: EditorDrawContext; box: Box; glyph: '+' | '−' }[] = []
    if (marks.ghostState) {
        const ghostContext = { ...context, state: marks.ghostState }
        for (const { entity, removed } of visible(marks.ghosts, min, max)) {
            if (!isShown(entity)) continue
            drawGhost(ghostContext, entity, GHOST_OPACITY)
            const box = changeShape(ghostContext, entity)
            if (!box) continue
            ring(ghostContext, box, true)
            if (removed) badges.push({ context: ghostContext, box, glyph: '−' })
        }
    }
    for (const { entity, added } of visible(marks.rings, min, max)) {
        if (!isShown(entity)) continue
        const box = changeShape(context, entity)
        if (!box) continue
        ring(context, box, false)
        if (added) badges.push({ context, box, glyph: '+' })
    }
    const cells = new Set<string>()
    for (const item of badges.reverse()) {
        const key = `${Math.round(((item.box.x + item.box.w) * context.scale) / 14)}:${Math.round((item.box.y * context.scale) / 14)}`
        if (cells.has(key)) continue
        cells.add(key)
        badge(item.context, item.box, item.glyph)
    }
}

/** Edits Here's range: an orange bracket along the left lane edge. */
export const drawHereBracket = (context: EditorDrawContext, from: number, to: number) => {
    const { ctx, scale, bounds, state, ups } = context
    const px = 1 / scale
    const x = context.composed ? bounds.l + 8 * px : -6 - 4 * px
    const y0 = beatToTime(state.bpms, from) * ups
    const y1 = beatToTime(state.bpms, to) * ups
    ctx.save()
    ctx.setLineDash([])
    ctx.strokeStyle = CHANGE_COLOR
    ctx.lineWidth = 3 * px
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x + 6 * px, y0)
    ctx.lineTo(x, y0)
    ctx.lineTo(x, y1)
    ctx.lineTo(x + 6 * px, y1)
    ctx.stroke()
    ctx.restore()
}
