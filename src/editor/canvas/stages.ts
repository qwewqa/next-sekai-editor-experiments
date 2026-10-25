import type { StageProps, Transition } from '../../preview/engine/stage'
import { StageTriangles } from '../../rendering/stageMesh'
import { convexDirection } from '../../rendering/triangleClip'
import { timeToBeat } from '../../state/integrals/bpms'
import { clamp, lerp } from '../../utils/math'
import type { Range } from '../../utils/range'
import type { ScopeLookup } from '../scopeRules'
import { sampleComposed } from './composedSampling'
import {
    appendButtStroke,
    appendStageQuad,
    appendStageStroke,
    dividerQuadsAreDisjoint,
    type StageQuad,
} from './stageGeometry'
import type { EditorDrawContext } from './types'

type StagePoint = StageProps & { left: number; right: number; size: number; time: number }

const borderSize = (value: number) => (value === 2 ? 0 : value === 1 ? 1 : value === 3 ? 2 : 3)
const borderWidth = (style: Transition<number>, scale: number) =>
    Math.max(0, lerp(borderSize(style.start), borderSize(style.end), style.progress)) / scale

const sameDivider = (a: StagePoint['division']['start'], b: StagePoint['division']['start']) =>
    a.size === b.size && a.parity === b.parity

// The surface tint of each lane color, by note style code. Default is the usual tint; the others
// follow the colors of the Lane Color swatches, except Blue and Cyan, which are stronger because
// the tint is faint and would match Default.
const laneTints = [
    0x83b6d0, 0xededed, 0xd6737b, 0x73d69d, 0x5a6cf0, 0xd6b362, 0xd673cd, 0x40e0d0, 0x555555,
] as const

const channel = (color: number, shift: number) => (color >> shift) & 0xff

const mixTint = (start: number, end: number, progress: number) => {
    if (start === end) return start
    const mixed = (shift: number) =>
        Math.round(lerp(channel(start, shift), channel(end, shift), progress))
    return (mixed(16) << 16) | (mixed(8) << 8) | mixed(0)
}

const sameLaneColor = (a: Transition<number>, b: Transition<number>) =>
    a.start === b.start &&
    a.end === b.end &&
    (a.progress === b.progress || (a.start === a.end && b.start === b.end))

// The tint over a slice, at the color progress of its two samples.
const sliceTint = (a: Transition<number>, b: Transition<number>) => {
    const progress =
        a.start === b.start && a.end === b.end ? (a.progress + b.progress) / 2 : b.progress
    return mixTint(
        laneTints[b.start] ?? laneTints[0],
        laneTints[b.end] ?? laneTints[0],
        clamp(progress),
    )
}

// Only fields the stage canvas paints. Constant transition endpoints ignore
// progress: an unchanged divider or border does not need a new slice at each sample.
const sameDivision = (a: StagePoint['division'], b: StagePoint['division']) =>
    sameDivider(a.start, b.start) &&
    sameDivider(a.end, b.end) &&
    (a.progress === b.progress || (sameDivider(a.start, a.end) && sameDivider(b.start, b.end)))

const samePaint = (a: StagePoint, b: StagePoint) =>
    a.left === b.left &&
    a.right === b.right &&
    a.pivotLane + a.xLaneTranslate === b.pivotLane + b.xLaneTranslate &&
    a.laneAlpha === b.laneAlpha &&
    sameLaneColor(a.laneColor, b.laneColor) &&
    a.fullWidth === b.fullWidth &&
    a.divisionLineAlpha === b.divisionLineAlpha &&
    sameDivision(a.division, b.division) &&
    borderWidth(a.leftBorderStyle, 1) === borderWidth(b.leftBorderStyle, 1) &&
    borderWidth(a.rightBorderStyle, 1) === borderWidth(b.rightBorderStyle, 1)

/**
 * Where stage paint goes. Queued triangles are in scene coordinates; `flush`
 * receives them in painter order before any ordinary slice that follows.
 */
export type StageOutput = {
    readonly triangles: StageTriangles
    flush(vertices: readonly number[]): void
    /** A slice the triangle stream cannot represent, drawn with the ordinary renderer. */
    slice(draw: (context: EditorDrawContext) => void): void
}

const submit = (output: StageOutput) => {
    output.flush(output.triangles.vertices)
    output.triangles.vertices.length = 0
}

const drawSlice = (
    context: EditorDrawContext,
    a: StagePoint,
    b: StagePoint,
    opacity: number,
    laneDivision: number,
    gridOffset: number,
    output?: StageOutput,
) => {
    const { ctx, ups, scale, bounds } = context
    const triangles = output?.triangles
    const alpha = clamp((a.laneAlpha * (1 - a.fullWidth) + b.laneAlpha * (1 - b.fullWidth)) / 2)
    if (alpha <= 0) return
    // A slice is straight between its sampled endpoints. For offscreen shapes,
    // allow the actual border widths (eases can overshoot) and device-pixel
    // antialiasing, including collapsed stages and fractional DPRs.
    const left = Math.min(a.left, a.right, b.left, b.right)
    const right = Math.max(a.left, a.right, b.left, b.right)
    if (right < bounds.l || left > bounds.r) {
        const padding =
            Math.max(
                borderWidth(a.leftBorderStyle, scale),
                borderWidth(b.leftBorderStyle, scale),
                borderWidth(a.rightBorderStyle, scale),
                borderWidth(b.rightBorderStyle, scale),
            ) /
                2 +
            2 / (context.pixelRatio * scale)
        if (right < bounds.l - padding || left > bounds.r + padding) return
    }
    const yA = a.time * ups
    const yB = b.time * ups
    // Redraws this slice with the ordinary renderer, after the triangles before it.
    const fallback = (output: StageOutput) => {
        submit(output)
        output.slice((target) => {
            drawSlice(target, a, b, opacity, laneDivision, gridOffset)
        })
    }
    if (output) {
        const padding =
            Math.max(
                borderWidth(a.leftBorderStyle, scale),
                borderWidth(b.leftBorderStyle, scale),
                borderWidth(a.rightBorderStyle, scale),
                borderWidth(b.rightBorderStyle, scale),
            ) / 2
        if (
            !output.triangles.supportsBounds(
                left - padding,
                Math.min(yA, yB) - padding,
                right + padding,
                Math.max(yA, yB) + padding,
            )
        ) {
            fallback(output)
            return
        }
    }
    const quad: StageQuad = [a.left, yA, b.left, yB, b.right, yB, a.right, yA]
    const direction = triangles && convexDirection(quad)
    const start = triangles?.vertices.length ?? 0
    let supported = true
    const finish = () => {
        if (output) {
            for (const side of ['left', 'right'] as const) {
                const style = side === 'left' ? 'leftBorderStyle' : 'rightBorderStyle'
                const width = (borderWidth(a[style], scale) + borderWidth(b[style], scale)) / 2
                if (width <= 0) continue
                supported &&= appendButtStroke(
                    output.triangles,
                    a[side],
                    yA,
                    b[side],
                    yB,
                    width,
                    0xb4d6e8,
                    opacity * alpha * 0.65,
                )
            }
            if (!supported) {
                // An unusual crossing or overlapping divider set keeps the native
                // coverage-union path. Submit preceding slices before this fallback.
                output.triangles.vertices.length = start
                fallback(output)
            } else if (output.triangles.vertices.length >= 6 * 65536) submit(output)
        } else drawBorders(context, a, b, opacity * alpha)
    }
    // A collapsed stage keeps only its borders, as in the engine.
    if (a.size <= 0 && b.size <= 0) {
        finish()
        return
    }
    const tint = sliceTint(a.laneColor, b.laneColor)
    if (triangles)
        supported &&= appendStageQuad(triangles, quad, direction, tint, opacity * alpha * 0.16)
    else {
        ctx.save()
        ctx.beginPath()
        ctx.moveTo(a.left, yA)
        ctx.lineTo(b.left, yB)
        ctx.lineTo(b.right, yB)
        ctx.lineTo(a.right, yA)
        ctx.closePath()
        ctx.globalAlpha = opacity * alpha * 0.16
        ctx.fillStyle = `#${tint.toString(16).padStart(6, '0')}`
        ctx.fill()
        ctx.clip()
    }

    // Divider sets crossfade when their spacing or parity changes. The mask clips
    // each slanted line, including a divider entering or leaving a moving edge.
    const division = b.division
    const same =
        division.start.size === division.end.size && division.start.parity === division.end.parity
    const progress =
        a.division.start.size === division.start.size &&
        a.division.end.size === division.end.size &&
        a.division.start.parity === division.start.parity &&
        a.division.end.parity === division.end.parity
            ? (a.division.progress + division.progress) / 2
            : division.progress
    const sets = same
        ? [{ ...division.start, alpha: 1 }]
        : [
              { ...division.start, alpha: clamp(1 - progress) },
              { ...division.end, alpha: clamp(progress) },
          ]
    if (!triangles) {
        ctx.strokeStyle = '#b4d6e8'
        ctx.lineWidth = 1 / scale
    }
    const drawLines = (spacing: number, parity: number, lineAlpha: number) => {
        if (lineAlpha <= 0) return
        const pivotA = a.pivotLane + a.xLaneTranslate + parity
        const pivotB = b.pivotLane + b.xLaneTranslate + parity
        const min = Math.floor(
            Math.min(
                (Math.max(a.left, bounds.l) - pivotA) / spacing,
                (Math.max(b.left, bounds.l) - pivotB) / spacing,
            ),
        )
        const max = Math.ceil(
            Math.max(
                (Math.min(a.right, bounds.r) - pivotA) / spacing,
                (Math.min(b.right, bounds.r) - pivotB) / spacing,
            ),
        )
        if (triangles) {
            if (
                !Number.isSafeInteger(min) ||
                !Number.isSafeInteger(max) ||
                (max > min &&
                    !dividerQuadsAreDisjoint(pivotB - pivotA, yB - yA, spacing, 1 / scale))
            ) {
                supported = false
                return
            }
        } else {
            ctx.globalAlpha = opacity * alpha * lineAlpha
            ctx.beginPath()
        }
        for (let count = 0; count <= max - min && count < 2048; count++) {
            const index = min + count
            const xA = pivotA + index * spacing
            const xB = pivotB + index * spacing
            if (triangles)
                supported &&= appendStageStroke(
                    triangles,
                    xA,
                    yA,
                    xB,
                    yB,
                    1 / scale,
                    quad,
                    direction,
                    0xb4d6e8,
                    opacity * alpha * lineAlpha,
                )
            else {
                ctx.moveTo(xA, yA)
                ctx.lineTo(xB, yB)
            }
        }
        if (!triangles) ctx.stroke()
    }
    // Authoring subdivisions follow the dominant division's parity. Each strip
    // is split at parity switches, so a constant midpoint phase avoids inventing
    // diagonal guides between two discrete lattices during a crossfade.
    if (Number.isFinite(laneDivision) && laneDivision > 0 && scale / laneDivision >= 8) {
        drawLines(
            1 / laneDivision,
            gridOffset,
            clamp((a.divisionLineAlpha + b.divisionLineAlpha) / 2) * 0.1,
        )
    }
    for (const set of sets) {
        if (set.size <= 0 || set.size * scale < 2 || set.alpha <= 0) continue
        drawLines(
            set.size,
            set.parity ? set.size / 2 : 0,
            clamp((a.divisionLineAlpha + b.divisionLineAlpha) / 2) * set.alpha * 0.4,
        )
    }
    if (!triangles) ctx.restore()
    finish()
}

const drawBorders = (context: EditorDrawContext, a: StagePoint, b: StagePoint, alpha: number) => {
    const { ctx, ups, scale } = context
    ctx.save()
    ctx.globalAlpha = alpha * 0.65
    ctx.strokeStyle = '#b4d6e8'
    for (const side of ['left', 'right'] as const) {
        const style = side === 'left' ? 'leftBorderStyle' : 'rightBorderStyle'
        const width = (borderWidth(a[style], scale) + borderWidth(b[style], scale)) / 2
        if (width <= 0) continue
        ctx.lineWidth = width
        ctx.beginPath()
        ctx.moveTo(a[side], a.time * ups)
        ctx.lineTo(b[side], b.time * ups)
        ctx.stroke()
    }
    ctx.restore()
}

/** These sampled stage segments use straight butt strokes. Other inherited
 * stroke/compositing modes retain the ordinary renderer's semantics. */
export const supportsStageTriangles = (context: EditorDrawContext) =>
    context.ctx.lineCap === 'butt' &&
    context.ctx.globalCompositeOperation === 'source-over' &&
    !context.ctx.getLineDash().length

/** The engine Preview's mask shapes and pivot-relative divisions in editor coordinates. */
export const drawComposedStages = (
    context: EditorDrawContext,
    beats: Range<number>,
    scope: ScopeLookup,
    laneDivision = 1,
) => {
    let output: StageOutput | undefined
    if (supportsStageTriangles(context)) {
        const transform = context.ctx.getTransform()
        output = {
            triangles: new StageTriangles([
                transform.a,
                transform.b,
                transform.c,
                transform.d,
                transform.e,
                transform.f,
            ]),
            flush: (vertices) => {
                context.ctx.drawStageTriangles(vertices)
            },
            slice: (draw) => {
                draw(context)
            },
        }
    }
    traceComposedStages(context, beats, scope, laneDivision, output)
}

/**
 * Paints the stages within `beats` to `output` in painter order, or with the
 * ordinary renderer when there is none. Only `bounds.l` and `bounds.r` of the
 * context's bounds limit the paint.
 */
export const traceComposedStages = (
    context: EditorDrawContext,
    beats: Range<number>,
    scope: ScopeLookup,
    laneDivision: number,
    output?: StageOutput,
) => {
    const { composed } = context
    if (!composed) return
    for (const [id, data] of composed.stages) {
        const visibility = scope.stage(id)
        if (visibility === 'hidden') continue
        const from = Math.max(0, beats.min, data.startBeat)
        const to = Math.min(beats.max, data.endBeat)
        if (!(to > from)) continue
        const breaks = [from, ...data.breakpoints.filter((beat) => from < beat && beat < to), to]
        const strips = sampleComposed(
            context.state.bpms,
            breaks,
            (beat, rightLimit) => {
                const props = composed.stage(id, beat, { rightLimit })
                if (!props) throw new Error('Composed stage missing from its layout')
                return { ...props, size: props.right - props.left }
            },
            {
                coordinates: (point) => [point.pivotLane + point.xLaneTranslate],
                maxTimeStep: 8 / Math.abs(context.scale * context.ups),
            },
        )
        for (const points of strips) {
            const first = points[0]
            const last = points.at(-1)
            if (!first || !last) continue
            // Evaluate the actual eased midpoint. Averaging endpoint progress
            // can pick the wrong side near an oscillating ease's discontinuity.
            const gridOffset = composed.gridOffset(
                id,
                timeToBeat(context.state.bpms, (first.time + last.time) / 2),
            )
            for (let index = 1; index < points.length; index++) {
                const previous = points[index - 1]
                let current = points[index]
                if (!previous || !current) continue
                // Preserve sampling and every jump, but paint a stationary run
                // once instead of repeating a fill, clip and strokes every 8px.
                if (samePaint(previous, current)) {
                    while (index + 1 < points.length) {
                        const next = points[index + 1]
                        if (!next || !samePaint(current, next)) break
                        current = next
                        index++
                    }
                }
                drawSlice(
                    context,
                    previous,
                    current,
                    visibility === 'dimmed' ? 0.25 : 1,
                    laneDivision,
                    gridOffset,
                    output,
                )
            }
        }
    }
    if (output) submit(output)
}
