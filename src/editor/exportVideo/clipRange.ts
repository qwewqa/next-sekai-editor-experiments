// The clip's range rules: pure. In is inclusive and Out exclusive, both on the frame grid of
// whole multiples of one frame from time 0, so the clip has whole frames.

import { MAX_HIT_EFFECT_DURATION } from '../../preview/engine/frameIndex'
import { preemptTime } from '../../preview/engine/timescale'
import type { State } from '../../state'
import type { Entity } from '../../state/entities'
import { beatToTime } from '../../state/integrals/bpms'
import { MIN_END } from '../minimap/range'

export type ClipRange = { in: number; out: number }
/** `bgm` and `whole` are recomputed at each open; the others are kept as times. */
export type RangeKind = 'bgm' | 'whole' | 'selection' | 'custom'

/** After the last object, so its last hit effect finishes. */
export const LEAD_OUT = MAX_HIT_EFFECT_DURATION
/** Added to the note approach time before the first selected object. */
const LEAD_IN_EXTRA = 0.5

/** Frames between In and Out: `ceil((Out - In) x fps)`, tolerant of rounding. */
export const frameCount = (range: ClipRange, fps: number) =>
    Math.max(0, Math.ceil((range.out - range.in) * fps - 1e-9))

/** The encoded length: whole frames. */
export const clipLength = (range: ClipRange, fps: number) => frameCount(range, fps) / fps

/** A time on the frame grid: the nearest frame, or the one before or after it. */
export const toFrame = (
    time: number,
    fps: number,
    round: 'nearest' | 'down' | 'up' = 'nearest',
) => {
    const frames = time * fps
    const frame =
        round === 'down'
            ? Math.floor(frames + 1e-6)
            : round === 'up'
              ? Math.ceil(frames - 1e-6)
              : Math.round(frames)
    return frame / fps
}

const endBeatOf = (entity: Entity) =>
    entity.type === 'connector' ? Math.max(entity.head.beat, entity.tail.beat) : entity.beat
const startBeatOf = (entity: Entity) =>
    entity.type === 'connector' ? Math.min(entity.head.beat, entity.tail.beat) : entity.beat

const isObject = (type: Entity['type']) => type === 'note' || type.endsWith('EventJoint')

/** The last note or event's beat: holds end at their tails, which are notes. */
export const lastObjectBeat = (state: Pick<State, 'store'>) => {
    let last: number | undefined
    for (const [type, grid] of Object.entries(state.store.grid) as [
        Entity['type'],
        Map<number, Set<Entity>>,
    ][]) {
        if (!isObject(type)) continue
        let key: number | undefined
        for (const [candidate, bucket] of grid)
            if (bucket.size && (key === undefined || candidate > key)) key = candidate
        if (key === undefined) continue
        for (const entity of grid.get(key) ?? [])
            if (last === undefined || entity.beat > last) last = entity.beat
    }
    return last
}

/** The Whole Chart's end: the last object plus the lead-out; 10 s with no objects. */
export const wholeChartEnd = (lastObject: number | undefined) => {
    const end = lastObject === undefined ? MIN_END : Math.max(0, lastObject) + LEAD_OUT
    return Number.isFinite(end) && end > 0 ? end : MIN_END
}

/** The strip covers both ends plus 5 %, at least 2 s. */
export const stripEndOf = (wholeEnd: number, bgmEnd?: number) => {
    const end = Math.max(wholeEnd, bgmEnd ?? 0)
    return end + Math.max(end * 0.05, 2)
}

/** A whole preset: from 0 to its end, rounded up to the frame grid. */
export const wholeRange = (wholeEnd: number, fps: number): ClipRange => ({
    in: 0,
    out: toFrame(wholeEnd, fps, 'up'),
})

/** The selected objects' span in seconds: connectors by head and tail, events by their beat. */
export const selectionSpan = (
    selected: readonly Entity[],
    bpms: State['bpms'],
): { first: number; last: number } | undefined => {
    let first = Infinity
    let last = -Infinity
    for (const entity of selected) {
        first = Math.min(first, startBeatOf(entity))
        last = Math.max(last, endBeatOf(entity))
    }
    if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined
    return { first: beatToTime(bpms, first), last: beatToTime(bpms, last) }
}

/** The approach time at a note speed plus half a second, so the first note is seen entering. */
export const leadIn = (noteSpeed: number) => preemptTime(noteSpeed, 0) + LEAD_IN_EXTRA

/** The Selection preset: the span with the lead-in before it and the lead-out after it. */
export const selectionRange = (
    span: { first: number; last: number },
    noteSpeed: number,
    stripEnd: number,
    fps: number,
): ClipRange =>
    clampRange(
        {
            in: toFrame(Math.max(0, span.first - leadIn(noteSpeed)), fps, 'down'),
            out: toFrame(span.last + LEAD_OUT, fps, 'up'),
        },
        stripEnd,
        fps,
    )

/** Within the strip, on the grid, and at least one frame long. */
export const clampRange = (range: ClipRange, stripEnd: number, fps: number): ClipRange => {
    const end = toFrame(stripEnd, fps, 'down')
    const frame = 1 / fps
    const out = Math.min(end, Math.max(frame, toFrame(range.out, fps)))
    const start = Math.min(out - frame, Math.max(0, toFrame(range.in, fps)))
    return { in: toFrame(start, fps), out }
}

/** Restore the remembered kind, or use Whole BGM when its end is known. */
export const openingRange = (
    remembered: { kind: RangeKind; range: ClipRange } | undefined,
    wholeEnd: number,
    bgmEnd: number | undefined,
    fps: number,
): { kind: RangeKind; range: ClipRange } => {
    let kind = remembered?.kind ?? (bgmEnd === undefined ? 'whole' : 'bgm')
    let range: ClipRange
    if (kind === 'bgm' && bgmEnd !== undefined) range = wholeRange(bgmEnd, fps)
    else if (remembered && (kind === 'selection' || kind === 'custom')) range = remembered.range
    else {
        kind = 'whole'
        range = wholeRange(wholeEnd, fps)
    }
    return { kind, range: clampRange(range, stripEndOf(wholeEnd, bgmEnd), fps) }
}

/**
 * Sets one end, moving the other to keep one frame when they would cross. Both stay in the strip.
 */
export const setEnd = (
    range: ClipRange,
    end: 'in' | 'out',
    time: number,
    stripEnd: number,
    fps: number,
): ClipRange => {
    const last = toFrame(stripEnd, fps, 'down')
    const frame = 1 / fps
    if (end === 'in') {
        const start = Math.min(last - frame, Math.max(0, toFrame(time, fps)))
        return { in: start, out: Math.max(range.out, toFrame(start + frame, fps)) }
    }
    const out = Math.min(last, Math.max(frame, toFrame(time, fps)))
    return { in: Math.min(range.in, toFrame(out - frame, fps)), out }
}

/** Zoom to Range: the range plus 10 % of its length a side, at least 4 s in all, in the strip. */
export const zoomSpan = (range: ClipRange, stripEnd: number): [number, number] => {
    const length = range.out - range.in
    const pad = Math.max(length * 0.1, (4 - length) / 2, 0)
    let from = range.in - pad
    let to = range.out + pad
    // Room cut at one edge goes to the other, so the span stays as long.
    if (from < 0) {
        to = Math.min(stripEnd, to - from)
        from = 0
    }
    if (to > stripEnd) {
        from = Math.max(0, from - (to - stripEnd))
        to = stripEnd
    }
    return [from, to]
}
