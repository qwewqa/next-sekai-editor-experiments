// Everything the minimap draws on its content canvas: positions, the
// canonical paint order, the gutter rules, hold and slide bodies, notes and their colours.
// A band redraw and a full redraw paint the same items in this order, so they blend identically.

import { ease } from '../../ease'
import type { State } from '../../state'
import type { ConnectorEntity } from '../../state/entities/slides/connector'
import { createSlideInfoLookup } from '../../state/entities/slides/lookup'
import type { NoteEntity } from '../../state/entities/slides/note'
import { getNoteVisualType } from '../../state/entities/slides/visualType'
import { beatToTime, timeToBeat } from '../../state/integrals/bpms'
import { lerp, safeUnlerpClamped } from '../../utils/math'
import { noteMinimapFill } from '../canvas/notes'
import type { ComposedLayout } from '../composed'
import { isConnectorVisible } from '../entities/visibility'
import { connectorColors } from '../utils/connectorColors'
import { CORE, type MinimapMapping } from './mapping'

export const RULE_COLOR = 'rgba(255,255,255,0.12)'
const BODY_ALPHA = 0.3
const FAKE_FACTOR = 0.5
/** Device rows between a body's samples. */
const SAMPLE_ROWS = 4
/** Device rows a note takes. */
const NOTE_HEIGHT = 2

type Bucket<T> = Map<number, Set<T>>

const slideLookup = createSlideInfoLookup()

/** The keys of `grid` from `lo` to `hi`, ascending. Either bound may be infinite. */
export const keysInRange = (grid: Bucket<unknown>, lo: number, hi: number) => {
    const keys: number[] = []
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi - lo < grid.size) {
        for (let key = lo; key <= hi; key++) if (grid.has(key)) keys.push(key)
        return keys
    }
    for (const key of grid.keys()) if (key >= lo && key <= hi) keys.push(key)
    return keys.sort((a, b) => a - b)
}

/** The visible bodies, in the canonical order: by head beat, then by slide. */
export const orderConnectors = (connectors: Iterable<ConnectorEntity>) =>
    [...connectors]
        .filter(isConnectorVisible)
        .sort((a, b) => a.head.beat - b.head.beat || a.head.slideId - b.head.slideId)

/** The distinct bodies in the buckets from `lo` to `hi`, in the canonical order. */
export const collectConnectors = (grid: Bucket<ConnectorEntity>, lo: number, hi: number) => {
    const found = new Set<ConnectorEntity>()
    for (const key of keysInRange(grid, lo, hi))
        for (const connector of grid.get(key) ?? []) found.add(connector)
    return orderConnectors(found)
}

/** The notes in the buckets from `lo` to `hi`, in the canonical order: by key, then bucket order. */
export const collectNotes = (grid: Bucket<NoteEntity>, lo: number, hi: number) => {
    const notes: NoteEntity[] = []
    for (const key of keysInRange(grid, lo, hi))
        for (const note of grid.get(key) ?? []) if (note.noteType !== 'anchor') notes.push(note)
    return notes
}

export type PaintSource = {
    state: Pick<State, 'bpms' | 'store'>
    /** Set when the chart is shown Composed. */
    layout: ComposedLayout | undefined
    mapping: MinimapMapping
}

/**
 * A connector's lane span at a time on the Basic rule, matching the chart's edgeAt. The times
 * of its attachment ends are the caller's, so a body's samples do not look them up again.
 */
export const basicConnectorSpan = (
    connector: ConnectorEntity,
    attachHeadTime: number,
    attachTailTime: number,
    time: number,
) => {
    const { attachHead, attachTail } = connector
    const q = ease(
        attachHead.connectorEase,
        safeUnlerpClamped(attachHeadTime, attachTailTime, time),
    )
    const size = lerp(attachHead.size, attachTail.size, q)
    return {
        left: lerp(attachHead.left, attachTail.left, q) + Math.min(size, 0) / 2,
        size: Math.max(size, 0),
    }
}

const xs: number[] = []
const xe: number[] = []
const ys: number[] = []

/** Paints into `ctx` in device px. Create one per paint session: it caches the context's style. */
export const createPainter = (ctx: CanvasRenderingContext2D, source: PaintSource) => {
    const { state, layout, mapping } = source
    const { scale } = mapping.geometry
    const { bpms } = state
    const rowOf = (time: number) => mapping.timeToY(time) * scale
    let fill: string | undefined
    let alpha = ctx.globalAlpha
    const style = (color: string, opacity: number) => {
        if (color !== fill) ctx.fillStyle = fill = color
        if (opacity !== alpha) ctx.globalAlpha = alpha = opacity
    }

    return {
        /** 1 device px lines at lanes −6 and 6, the whole height. */
        rules(height: number) {
            style(RULE_COLOR, 1)
            for (const lane of [-CORE, CORE])
                ctx.fillRect(Math.floor(mapping.laneToX(lane) * scale), 0, 1, height)
        },

        connector(connector: ConnectorEntity) {
            const { head, tail, segmentHead, segmentTail } = connector
            const tHead = beatToTime(bpms, head.beat)
            const tTail = beatToTime(bpms, tail.beat)
            const tAttachHead = beatToTime(bpms, connector.attachHead.beat)
            const tAttachTail = beatToTime(bpms, connector.attachTail.beat)
            // On the Basic rule a linear ease is a straight edge, so its two ends are exact.
            const straight = !layout && connector.attachHead.connectorEase === 'linear'
            const count = straight
                ? 1
                : Math.max(1, Math.ceil((rowOf(tHead) - rowOf(tTail)) / SAMPLE_ROWS))
            xs.length = xe.length = ys.length = 0
            for (let i = 0; i <= count; i++) {
                const time = i === 0 ? tHead : i === count ? tTail : lerp(tHead, tTail, i / count)
                const position = layout
                    ? layout.connectorPosition(
                          connector,
                          i === 0 ? head.beat : i === count ? tail.beat : timeToBeat(bpms, time),
                      )
                    : basicConnectorSpan(connector, tAttachHead, tAttachTail, time)
                const [x0, x1] = mapping.spanToX(position.left, position.size)
                xs.push(x0 * scale)
                xe.push(x1 * scale)
                ys.push(rowOf(time))
            }
            const guide = segmentHead.connectorType === 'guide'
            const opacity = guide
                ? BODY_ALPHA *
                  Math.max(segmentHead.connectorGuideAlpha, segmentTail.connectorGuideAlpha)
                : segmentHead.connectorIsFake
                  ? BODY_ALPHA * FAKE_FACTOR
                  : BODY_ALPHA
            style(connectorColors(segmentHead).body, opacity)
            ctx.beginPath()
            ctx.moveTo(xs[0] ?? 0, ys[0] ?? 0)
            for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i] ?? 0, ys[i] ?? 0)
            for (let i = xe.length - 1; i >= 0; i--) ctx.lineTo(xe[i] ?? 0, ys[i] ?? 0)
            ctx.closePath()
            ctx.fill()
        },

        note(note: NoteEntity) {
            const infos = state.store.slides.info.get(note.slideId)
            const type = getNoteVisualType(note, infos, infos && slideLookup(infos))
            if (type === 'anchor') return
            const position = layout ? layout.notePosition(note) : note
            const [a, b] = mapping.spanToX(position.left, position.size)
            const x0 = Math.round(a * scale)
            const x1 = Math.max(x0 + 1, Math.round(b * scale))
            const y = Math.round(rowOf(beatToTime(bpms, note.beat)))
            style(noteMinimapFill(note, type), note.isFake ? FAKE_FACTOR : 1)
            ctx.fillRect(x0, y - NOTE_HEIGHT / 2, x1 - x0, NOTE_HEIGHT)
        },
    }
}

export type Painter = ReturnType<typeof createPainter>
