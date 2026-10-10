import { isClockFrame } from '../../frame'
import { timeToBeat } from '../../state/integrals/bpms'
import type { Range } from '../../utils/range'
import type { ScopeLookup } from '../scopeRules'
import { drawComposedStages } from './stages'
import { deviceSize, prepareSurface } from './surface'
import type { EditorDrawContext } from './types'

// Each retained store (the exact view and the moving window) holds at most 32 MiB
// of RGBA pixels, so up to twice that beside the chart. Larger screens draw directly.
const MAX_PIXELS = 8 * 1024 * 1024
// A moving window reaches this far ahead of the view and a quarter of it behind.
const AHEAD = 1
const BEHIND = 0.25
// Frames closer together than this are one motion; spaced steps each draw exactly.
export const SUSTAINED_MS = 100

type Motion = {
    canvas: HTMLCanvasElement
    ctx: CanvasRenderingContext2D
    key: readonly unknown[]
    // Device-pixel translation the window was drawn with.
    e: number
    f: number
}

const sameKey = (a: readonly unknown[] | undefined, b: readonly unknown[]) =>
    a?.length === b.length && b.every((value, i) => value === a[i])

/**
 * Retains the composed stage pixels across note/selection-only chart redraws.
 * While the view moves, frames reuse a larger window shifted by whole device
 * pixels; the first still frame draws the stages exactly again.
 */
export const createStageSurface = () => {
    let canvas: HTMLCanvasElement | undefined
    let surfaceContext: CanvasRenderingContext2D | undefined
    let previous: readonly unknown[] | undefined
    let motion: Motion | undefined
    let stageSet: unknown
    // The last frame's view, to tell motion from a still or changed view.
    let last:
        { key: readonly unknown[]; l: number; t: number; moving: boolean; time: number } | undefined

    const clearMotion = () => {
        if (motion) motion.canvas.width = motion.canvas.height = 0
        motion = undefined
    }
    const clear = () => {
        if (canvas) canvas.width = canvas.height = 0
        canvas = undefined
        surfaceContext = undefined
        previous = undefined
        clearMotion()
        last = undefined
        stageSet = undefined
    }

    // Draws a window around the view, extended along the motion, at the chart's device scale.
    const drawMotion = (
        context: EditorDrawContext,
        key: readonly unknown[],
        width: number,
        height: number,
        dx: number,
        dy: number,
        scope: ScopeLookup,
        laneDivision: number,
    ) => {
        const { bounds, pixelRatio, scale, ups } = context
        const [w, h] = deviceSize(width, height, pixelRatio)
        const sx = scale * (w / width)
        const sy = scale * (h / height)
        // Margins in whole device pixels; scene x grows right and scene y grows down.
        // Large screens get a shallower window within the same pixel budget.
        let reach = 1
        const margin = (delta: number, size: number, forward: boolean) =>
            delta === 0 ? 0 : Math.round(size * reach * (delta > 0 === forward ? AHEAD : BEHIND))
        const area = () =>
            (w + margin(dx, w, false) + margin(dx, w, true)) *
            (h + margin(dy, h, false) + margin(dy, h, true))
        while (area() > MAX_PIXELS && reach > 1 / 16) reach /= 2
        const left = margin(dx, w, false)
        const right = margin(dx, w, true)
        const top = margin(dy, h, false)
        const bottom = margin(dy, h, true)
        const W = w + left + right
        const H = h + top + bottom
        if (W * H > MAX_PIXELS) {
            clearMotion()
            return
        }
        const target = motion?.canvas ?? document.createElement('canvas')
        motion = undefined
        if (target.width !== W) target.width = W
        if (target.height !== H) target.height = H
        const ctx = target.getContext('2d')
        if (!ctx) return
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.save()
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'copy'
        ctx.fillStyle = 'rgba(0, 0, 0, 0)'
        ctx.fillRect(0, 0, W, H)
        ctx.restore()
        const e = -bounds.l * sx + left
        const f = -bounds.t * sy + top
        ctx.setTransform(sx, 0, 0, sy, e, f)
        ctx.lineWidth = 2 / scale
        const extended = {
            ...bounds,
            l: bounds.l - left / sx,
            r: bounds.r + right / sx,
            t: bounds.t - top / sy,
            b: bounds.b + bottom / sy,
            w: bounds.w + (left + right) / sx,
            h: bounds.h + (top + bottom) / sy,
        }
        const bpms = context.state.bpms
        const beats = {
            min: timeToBeat(bpms, Math.max(0, extended.b / ups)),
            max: timeToBeat(bpms, extended.t / ups),
        }
        drawComposedStages({ ...context, ctx, bounds: extended }, beats, scope, laneDivision)
        motion = { canvas: target, ctx, key, e, f }
    }

    // Copies the moving window at the view's offset, rounded to whole device pixels.
    const blitMotion = (
        context: EditorDrawContext,
        key: readonly unknown[],
        width: number,
        height: number,
    ) => {
        if (!motion || !sameKey(motion.key, key)) return false
        const { bounds, pixelRatio, scale } = context
        const [w, h] = deviceSize(width, height, pixelRatio)
        const x = Math.round(motion.e + bounds.l * scale * (w / width))
        const y = Math.round(motion.f + bounds.t * scale * (h / height))
        if (x < 0 || y < 0 || x + w > motion.canvas.width || y + h > motion.canvas.height)
            return false
        context.ctx.save()
        context.ctx.setTransform(1, 0, 0, 1, 0, 0)
        context.ctx.globalAlpha = 1
        context.ctx.drawImage(motion.canvas, x, y, w, h, 0, 0, w, h)
        context.ctx.restore()
        return true
    }

    return {
        /** Returns true when the frame used shifted pixels and needs an exact redraw once still. */
        draw(
            context: EditorDrawContext,
            width: number,
            height: number,
            beats: Range<number>,
            scope: ScopeLookup,
            laneDivision: number,
        ) {
            const { composed, bounds, pixelRatio, scale, ups } = context
            if (!composed) {
                clear()
                return false
            }
            // Older Canvas implementations do not expose context-loss queries.
            /* eslint-disable @typescript-eslint/no-unnecessary-condition */
            if (surfaceContext?.isContextLost?.() || motion?.ctx.isContextLost?.()) clear()
            /* eslint-enable @typescript-eslint/no-unnecessary-condition */
            // New stages reallocate the stores: a 'copy' clear can keep old pixels once a canvas has been read.
            if (composed.stages !== stageSet) {
                clear()
                stageSet = composed.stages
            }
            const [w, h] = deviceSize(width, height, pixelRatio)
            const pixels = w * h
            if (
                !Number.isFinite(pixels) ||
                pixels > MAX_PIXELS ||
                width <= 0 ||
                height <= 0 ||
                pixelRatio <= 0
            ) {
                clear()
                drawComposedStages(context, beats, scope, laneDivision)
                return false
            }
            // Everything but the scroll position; a change here always redraws exactly.
            const viewKey = [
                composed.stages,
                context.state.bpms,
                width,
                height,
                pixelRatio,
                scale,
                ups,
                bounds.w,
                bounds.h,
                laneDivision,
                ...[...composed.stages.keys()].map((id) => scope.stage(id)),
            ]
            const key = [...viewKey, bounds.l, bounds.r, bounds.t, bounds.b, beats.min, beats.max]
            const moved =
                sameKey(last?.key, viewKey) && (last?.l !== bounds.l || last.t !== bounds.t)
            const dx = last ? bounds.l - last.l : 0
            const dy = last ? bounds.t - last.t : 0
            // Clock ticks (playback, eased scrolls, inertia) move every frame, however slow;
            // other moves, such as drags, count when frames follow closely.
            const now = performance.now()
            const wasMoving = !!last?.moving && (isClockFrame() || now - last.time < SUSTAINED_MS)
            last = { key: viewKey, l: bounds.l, t: bounds.t, moving: moved, time: now }
            // A single step redraws exactly; sustained motion reuses a larger window.
            if (!sameKey(previous, key) && moved && wasMoving) {
                if (blitMotion(context, viewKey, width, height)) return true
                drawMotion(context, viewKey, width, height, dx, dy, scope, laneDivision)
                if (blitMotion(context, viewKey, width, height)) return true
            }
            if (!sameKey(previous, key)) {
                canvas ??= document.createElement('canvas')
                const ctx = prepareSurface(canvas, width, height, pixelRatio, bounds)
                if (!ctx) {
                    clear()
                    drawComposedStages(context, beats, scope, laneDivision)
                    return false
                }
                drawComposedStages({ ...context, ctx }, beats, scope, laneDivision)
                surfaceContext = ctx
                previous = key
            }
            if (!canvas) return false
            context.ctx.save()
            // The cached surface uses exactly the chart's backing dimensions and
            // viewport transform; copying at integer pixels adds no resampling.
            context.ctx.setTransform(1, 0, 0, 1, 0, 0)
            context.ctx.globalAlpha = 1
            context.ctx.drawImage(canvas, 0, 0)
            context.ctx.restore()
            return false
        },
        clear,
    }
}
