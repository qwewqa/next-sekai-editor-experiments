import type { State } from '../../state'
import type { Entity } from '../../state/entities'
import { beatToTime, getMeasureBeats, timeToBeat } from '../../state/integrals/bpms'
import {
    ceilGridBeat,
    GLOBAL_GRID,
    gridLines,
    isGlobalGrid,
    toBeatGrid,
    type BeatGrid,
} from '../../state/integrals/grid'
import { formatIntegerTime } from '../../utils/format'
import type { Range } from '../../utils/range'
import { formatBeatPosition, type BeatDisplay } from '../beatDisplay'
import type { LabelBox } from '../edgeLabels'
import { timeScaleLabel } from './events'
import { drawText, measureText } from './text'
import type { EdgeLabelYs, EditorDrawContext } from './types'

// Half the beat or time (0.4) and BPM or time scale (0.5) label sizes.
const LABEL_CLEARANCE = 0.45

/** Where drawn time scale labels cross into the time and beat columns, past lanes -6.1 and 6.1. */
export const timeScaleEdgeLabelYs = (
    context: EditorDrawContext,
    steps: { entity: Entity; part?: 'line' | 'marker' }[],
): EdgeLabelYs => {
    const ys: EdgeLabelYs = { left: [], right: [] }
    for (const { entity, part } of steps) {
        if (entity.type !== 'timeScale' || part === 'line') continue
        const label = timeScaleLabel(context, entity)
        if (!label) continue
        const y = beatToTime(context.state.bpms, entity.beat) * context.ups
        if (label.min < -6.1) ys.left.push(y)
        if (label.max > 6.1) ys.right.push(y)
    }
    return ys
}

// Beat labels closer than this, in pane pixels, are a smear; skipping them bounds their count.
const MIN_LABEL_SPACING = 2

// Bar grid lines closer than this, in pane pixels, are thinned; at most this many are drawn.
const MIN_LINE_SPACING = 2
const MAX_LINES = 2000

/** The grid a display mode draws: measures restart it at bars. */
export const defaultGrid = (state: State, beatDisplay: BeatDisplay) =>
    beatDisplay === 'beat' ? GLOBAL_GRID : toBeatGrid(state.bpms)

const isWhole = (beat: number) => Math.abs(beat - Math.round(beat)) < 1e-6

export type GridLabels = {
    left: { text: string; y: number }[]
    right: { text: string; y: number }[]
}

/** The time (left) and beat (right) labels the grid draws, by text and y. */
export const gridLabels = (
    state: State,
    ups: number,
    scale: number,
    beats: Range<number>,
    times: Range<number>,
    beatDisplay: BeatDisplay,
    grid = defaultGrid(state, beatDisplay),
): GridLabels => {
    const left: GridLabels['left'] = []
    for (let time = Math.max(1, Math.ceil(times.min)); time <= times.max; time++)
        left.push({ text: formatIntegerTime(time), y: time * ups })
    const right: GridLabels['right'] = []
    const gap = MIN_LABEL_SPACING / Math.abs(ups * scale)
    const bars = grid.bpms ?? state.bpms
    if (isGlobalGrid(grid, 1)) {
        for (let beat = Math.max(1, Math.ceil(beats.min)); beat <= beats.max;) {
            const time = beatToTime(state.bpms, beat)
            right.push({ text: formatBeatPosition(bars, beat, beatDisplay), y: time * ups })
            beat = Math.max(beat + 1, Math.ceil(timeToBeat(state.bpms, time + gap)))
        }
        return { left, right }
    }
    // Beats of the bar grid, sought rather than walked: bars can be dense.
    const clearance = LABEL_CLEARANCE / Math.abs(ups)
    for (let beat = ceilGridBeat(grid, Math.max(beats.min, 1e-6), 1); beat <= beats.max;) {
        const time = beatToTime(state.bpms, beat)
        right.push({ text: formatBeatPosition(bars, beat, beatDisplay), y: time * ups })
        let next = Math.max(
            ceilGridBeat(grid, beat + 5e-7, 1),
            ceilGridBeat(grid, timeToBeat(state.bpms, time + gap), 1),
        )
        // Fractional labels keep clear of their neighbours.
        if ((!isWhole(beat) || !isWhole(next)) && beatToTime(state.bpms, next) - time < clearance)
            next = ceilGridBeat(grid, timeToBeat(state.bpms, time + clearance), 1)
        beat = next
    }
    return { left, right }
}

/** The ys of the time and beat labels under the given boxes, in pane pixels. */
export const coveredLabelYs = (
    context: EditorDrawContext,
    beats: Range<number>,
    times: Range<number>,
    beatDisplay: BeatDisplay,
    boxes: { left: LabelBox[]; right: LabelBox[] },
    labels = gridLabels(context.state, context.ups, context.scale, beats, times, beatDisplay),
): EdgeLabelYs => {
    const { bounds, scale } = context
    // A label's box in pane pixels: drawn from `edge` toward `align`, 0.4 tall.
    const covered = (
        boxes: LabelBox[],
        { text, y }: { text: string; y: number },
        edge: number,
        align: 'start' | 'end',
    ) => {
        const top = (y - 0.2 - bounds.t) * scale
        const bottom = (y + 0.2 - bounds.t) * scale
        // Measure only labels in a box's band.
        const band = boxes.filter((box) => box.top < bottom && box.bottom > top)
        if (!band.length) return false
        const width = measureText(context, text)
        const left = ((align === 'start' ? edge : edge - width) - bounds.l) * scale
        const right = left + width * scale
        return band.some((box) => box.left < right && box.right > left)
    }
    return {
        left: labels.left
            .filter((label) => covered(boxes.left, label, -6.1, 'end'))
            .map(({ y }) => y),
        right: labels.right
            .filter((label) => covered(boxes.right, label, 6.1, 'start'))
            .map(({ y }) => y),
    }
}

export const drawGrid = (
    context: EditorDrawContext,
    beats: Range<number>,
    times: Range<number>,
    division: number,
    laneDivision = 1,
    beatDisplay: BeatDisplay = 'measure',
    isBpmVisible = false,
    edgeLabelYs: EdgeLabelYs = { left: [], right: [] },
    labels = gridLabels(context.state, context.ups, context.scale, beats, times, beatDisplay),
    grid: BeatGrid = defaultGrid(context.state, beatDisplay),
) => {
    const { ctx, bounds, scale, state, ups } = context
    ctx.save()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2 / scale
    // Composed stages supply their own vertical guides. Retain the standard
    // playfield edges only as faint references in the surrounding workspace.
    const composed = !!context.composed
    if (composed) {
        ctx.globalAlpha = 0.12
        ctx.beginPath()
        for (const lane of [-6, 6]) {
            ctx.moveTo(lane, Math.min(0, bounds.b))
            ctx.lineTo(lane, bounds.t)
        }
        ctx.stroke()
    }
    // Batch disjoint grid lines with the same opacity into a single stroke.
    for (const alpha of composed ? [] : [0.5, 0.25, 0.05]) {
        ctx.globalAlpha = alpha
        ctx.beginPath()
        for (let i = 1; i <= 13; i++) {
            if ((i === 1 || i === 13 ? 0.5 : i % 2 ? 0.25 : 0.05) !== alpha) continue
            ctx.moveTo(i - 7, Math.min(0, bounds.b))
            ctx.lineTo(i - 7, bounds.t)
        }
        ctx.stroke()
    }

    if (!composed && laneDivision > 1 && scale / laneDivision >= 8 && laneDivision <= 32) {
        ctx.globalAlpha = 0.025
        ctx.beginPath()
        for (let i = -6 * laneDivision; i <= 6 * laneDivision; i++) {
            if (i % laneDivision === 0) continue
            const lane = i / laneDivision
            ctx.moveTo(lane, Math.min(0, bounds.b))
            ctx.lineTo(lane, bounds.t)
        }
        ctx.stroke()
    }

    const min = Math.ceil(beats.min * division)
    const max = Math.floor(beats.max * division)
    const left = composed ? bounds.l : -6
    const right = composed ? bounds.r : 6
    const showMeasures = beatDisplay !== 'beat'
    if (max - min <= 100 && isGlobalGrid(grid, division) && isGlobalGrid(grid, 1)) {
        for (const isBeat of [false, true]) {
            ctx.globalAlpha = showMeasures ? (isBeat ? 0.35 : 0.15) : isBeat ? 0.5 : 0.25
            ctx.beginPath()
            for (let i = min; i <= max; i++) {
                if ((i % division === 0) !== isBeat) continue
                const y = beatToTime(state.bpms, i / division) * ups
                ctx.moveTo(left, y)
                ctx.lineTo(right, y)
            }
            ctx.stroke()
        }
    } else if (max - min <= 100) {
        const lines = gridLines(grid, beats.min, beats.max, division, MAX_LINES) ?? []
        const ys = lines.map(({ beat }) => beatToTime(state.bpms, beat) * ups)
        const kept = thinLines(lines, ys, MIN_LINE_SPACING / scale)
        for (const isBeat of [false, true]) {
            ctx.globalAlpha = showMeasures ? (isBeat ? 0.35 : 0.15) : isBeat ? 0.5 : 0.25
            ctx.beginPath()
            lines.forEach((line, index) => {
                if (line.isBeat !== isBeat || !kept[index]) return
                ctx.moveTo(left, ys[index] ?? 0)
                ctx.lineTo(right, ys[index] ?? 0)
            })
            ctx.stroke()
        }
    }

    if (showMeasures) {
        ctx.globalAlpha = composed ? 0.4 : 0.7
        ctx.lineWidth = (composed ? 2 : 3) / scale
        ctx.beginPath()
        for (const beat of getMeasureBeats(grid.bpms ?? state.bpms, beats.min, beats.max)) {
            const y = beatToTime(state.bpms, beat) * ups
            ctx.moveTo(left, y)
            ctx.lineTo(right, y)
        }
        ctx.stroke()
    }

    ctx.globalAlpha = 0.5
    // A BPM or edge time scale label takes the place of the beat or time labels
    // it would overlap.
    const bpmYs = isBpmVisible
        ? state.bpms
              .filter(({ x }) => x > beats.min - 1 && x < beats.max + 1)
              .map(({ x }) => beatToTime(state.bpms, x) * ups)
        : []
    const beatYs = [...bpmYs, ...edgeLabelYs.right]
    const near = (ys: number[], y: number) =>
        ys.some((other) => Math.abs(y - other) < LABEL_CLEARANCE)
    for (const { text, y } of labels.right) {
        if (near(beatYs, y)) continue
        drawText(context, text, 6.1, y, '#fff', 0.4, 'start', context.figureMiddle)
    }
    for (const { text, y } of labels.left) {
        if (near(edgeLabelYs.left, y)) continue
        drawText(context, text, -6.1, y, '#fff', 0.4, 'end', context.figureMiddle)
    }
    ctx.restore()
}

/** Keeps beat lines apart by the spacing, then division lines clear of every kept line. */
const thinLines = (lines: { isBeat: boolean }[], ys: number[], spacing: number) => {
    const kept = lines.map(() => false)
    let last = Number.NEGATIVE_INFINITY
    lines.forEach((line, index) => {
        const y = ys[index] ?? 0
        if (!line.isBeat || Math.abs(y - last) < spacing) return
        kept[index] = true
        last = y
    })
    const nextBeat: number[] = []
    let next = Number.POSITIVE_INFINITY
    for (let index = lines.length - 1; index >= 0; index--) {
        nextBeat[index] = next
        if (kept[index]) next = ys[index] ?? 0
    }
    last = Number.NEGATIVE_INFINITY
    lines.forEach((line, index) => {
        const y = ys[index] ?? 0
        if (kept[index]) {
            last = y
            return
        }
        if (line.isBeat) return
        if (Math.abs(y - last) < spacing || Math.abs((nextBeat[index] ?? 0) - y) < spacing) return
        kept[index] = true
        last = y
    })
    return kept
}
