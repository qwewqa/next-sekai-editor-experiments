import type { Entity } from '../../state/entities'
import { beatToTime } from '../../state/integrals/bpms'
import type { ChangeMarks } from '../history/changes'
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

const boxOf = (context: EditorDrawContext, entity: Entity): Box | undefined => {
    const hitbox = context.composed?.hitbox(entity) ?? entity.hitbox
    if (!hitbox) return
    const y = beatToTime(context.state.bpms, hitbox.beat) * context.ups
    return { x: hitbox.lane - hitbox.w, y: y - hitbox.h, w: hitbox.w * 2, h: hitbox.h * 2 }
}

const grow = (box: Box, by: number): Box => ({
    x: box.x - by,
    y: box.y - by,
    w: box.w + 2 * by,
    h: box.h + 2 * by,
})

const roundedRect = (context: EditorDrawContext, box: Box) => {
    const { ctx } = context
    ctx.beginPath()
    ctx.roundRect(box.x, box.y, box.w, box.h, Math.min(box.w, box.h) / 2)
    ctx.stroke()
}

const ring = (context: EditorDrawContext, box: Box, dashed: boolean) => {
    const { ctx, scale } = context
    const px = 1 / scale
    ctx.save()
    ctx.setLineDash(dashed ? [4 * px, 3 * px] : [])
    ctx.lineWidth = EDGE * px
    ctx.strokeStyle = INK
    roundedRect(context, grow(box, (GAP + RING + EDGE / 2) * px))
    ctx.lineWidth = RING * px
    ctx.strokeStyle = CHANGE_COLOR
    roundedRect(context, grow(box, (GAP + RING / 2) * px))
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
    ctx.fillStyle = CHANGE_COLOR
    ctx.fillCircle(x, y, radius)
    ctx.lineWidth = EDGE * px
    ctx.strokeStyle = INK
    ctx.strokeCircle(x, y, radius)
    ctx.lineWidth = 2 * px
    ctx.lineCap = 'round'
    const arm = radius * 0.5
    ctx.strokeLine(x - arm, y, x + arm, y)
    if (glyph === '+') ctx.strokeLine(x, y - arm, x, y + arm)
    ctx.restore()
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
    const { ctx, scale } = context
    const inRange = (beat: number) => beat >= min && beat <= max
    if (marks.ghostState) {
        const ghostContext = { ...context, state: marks.ghostState }
        for (const { entity, removed } of marks.ghosts) {
            if (!inRange(entity.beat) || !isShown(entity)) continue
            drawGhost(ghostContext, entity, GHOST_OPACITY)
            const box = boxOf(ghostContext, entity)
            if (!box) continue
            ring(ghostContext, box, true)
            if (removed) badge(ghostContext, box, '−')
        }
    }
    // Removed events: a dashed line across the lanes.
    for (const { beat } of marks.ghostLines) {
        if (!inRange(beat)) continue
        const y = beatToTime(context.state.bpms, beat) * context.ups
        const left = context.composed ? context.bounds.l : -6
        const right = context.composed ? context.bounds.r : 6
        ctx.save()
        ctx.setLineDash([4 / scale, 3 / scale])
        ctx.lineWidth = RING / scale
        ctx.strokeStyle = CHANGE_COLOR
        ctx.strokeLine(left, y, right, y)
        ctx.restore()
        badge(context, { x: right, y, w: 0, h: 0 }, '−')
    }
    for (const { entity, added } of marks.rings) {
        if (!inRange(entity.beat) || !isShown(entity)) continue
        const box = boxOf(context, entity)
        if (!box) continue
        ring(context, box, false)
        if (added) badge(context, box, '+')
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
