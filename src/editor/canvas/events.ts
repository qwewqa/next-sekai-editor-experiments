import type { StageId } from '../../chart/stages'
import { isNoneEase } from '../../ease'
import { easeGlyphPoints } from '../../easeGlyph'
import type { Entity, EntityType } from '../../state/entities'
import { BPM_LABEL } from '../../state/entities/bpm'
import type { EventConnectionEntity } from '../../state/entities/events/connections'
import type { EventJointEntity } from '../../state/entities/events/joints'
import type { StageEventJointEntity } from '../../state/entities/events/joints/stage'
import type { TimeScaleEntity } from '../../state/entities/timeScale'
import { beatToTime } from '../../state/integrals/bpms'
import type { StoreGrid } from '../../state/store/grid'
import { formatBpm, formatTimeScale } from '../../utils/format'
import type { Range } from '../../utils/range'
import { getPathD, getRangePathDs } from '../entities/events/path'
import type { ScopeLookup } from '../scopeRules'
import { drawName, stageNameColor } from './names'
import { drawText, measureCachedText } from './text'
import type { CanvasBounds, EditorDrawContext } from './types'

type DrawnEventEntity = Exclude<Entity, { type: 'note' | 'connector' }>

const connectionPaths = new WeakMap<
    EventConnectionEntity,
    {
        bpms: EditorDrawContext['state']['bpms']
        ups: number
        paths: Path2D[]
    }
>()

const jointXs = (entity: EventJointEntity): number[] => {
    switch (entity.type) {
        case 'cameraEventJoint':
            return [entity.cameraLeft, entity.cameraLeft + entity.cameraSize]
        case 'stageMaskEventJoint':
            return [entity.maskLeft, entity.maskLeft + entity.maskSize]
        case 'stagePivotEventJoint':
            return [entity.pivotLane]
        case 'stageStyleEventJoint':
            return [entity.editorLane]
        case 'stageTransformEventJoint':
            return [entity.xTranslation]
    }
}

// The engine's minimum camera and mask widths, in editor lanes.
const rangeMinWidth = (entity: EventJointEntity) =>
    entity.type === 'cameraEventJoint'
        ? 0.02
        : entity.type === 'stageMaskEventJoint'
          ? 0
          : undefined

const eventColor = (entity: EventJointEntity) => {
    switch (entity.type) {
        case 'cameraEventJoint':
            return '#f00'
        case 'stageMaskEventJoint':
            return '#0f0'
        case 'stagePivotEventJoint':
            return '#00f'
        case 'stageStyleEventJoint':
            return '#0ff'
        case 'stageTransformEventJoint':
            return '#ddd'
    }
}

const line = (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
}

const marker = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    ctx.beginPath()
    ctx.arc(x, y, 0.1, 0, 2 * Math.PI)
    ctx.fill()
    ctx.stroke()
}

const DIAMOND_RADIUS = 0.135

/** Circles change the time scale and diamonds the scroll; hollow ones hide notes. */
const timeScaleMarker = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    isScroll: boolean,
    hideNotes: boolean,
) => {
    ctx.beginPath()
    if (isScroll) {
        ctx.moveTo(x, y - DIAMOND_RADIUS)
        ctx.lineTo(x + DIAMOND_RADIUS, y)
        ctx.lineTo(x, y + DIAMOND_RADIUS)
        ctx.lineTo(x - DIAMOND_RADIUS, y)
        ctx.closePath()
    } else {
        ctx.arc(x, y, 0.1, 0, 2 * Math.PI)
    }
    ctx.fillStyle = '#ff0'
    ctx.strokeStyle = hideNotes ? '#ff0' : '#fff'
    if (!hideNotes) ctx.fill()
    ctx.stroke()
}

const nextTimeScales = new WeakMap<
    StoreGrid['timeScale'],
    Map<TimeScaleEntity, TimeScaleEntity | null>
>()

/**
 * The next time scale of the same group, which its ease transitions to: null
 * for the last one, undefined for one outside the chart such as a preview.
 */
const nextTimeScale = ({ state }: EditorDrawContext, entity: TimeScaleEntity) => {
    const grid = state.store.grid.timeScale
    let next = nextTimeScales.get(grid)
    if (!next) {
        const groups = new Map<TimeScaleEntity['groupId'], TimeScaleEntity[]>()
        for (const entities of grid.values()) {
            for (const timeScale of entities) {
                const group = groups.get(timeScale.groupId)
                if (group) group.push(timeScale)
                else groups.set(timeScale.groupId, [timeScale])
            }
        }
        next = new Map()
        for (const group of groups.values()) {
            group.sort((a, b) => a.beat - b.beat)
            for (const [index, timeScale] of group.entries())
                next.set(timeScale, group[index + 1] ?? null)
        }
        nextTimeScales.set(grid, next)
    }
    return next.get(entity)
}

// Lanes, in proportion to the 0.5-lane label font; nearer its value than its marker.
const EASE_GLYPH = { width: 0.3, height: 0.34, gap: 0.06, stroke: 0.05 }

// From the marker to the ease glyph.
const LABEL_OFFSET = 0.23

/** Labels point outward from the stage, and inward where outward would leave the view. */
const timeScaleLabelDirection = (
    x: number,
    width: number,
    { l, r }: Pick<CanvasBounds, 'l' | 'r'>,
): 1 | -1 => {
    const outward = x > 0 ? 1 : -1
    const fits = (direction: 1 | -1) => (direction > 0 ? x + width <= r : x - width >= l)
    return fits(outward) || !fits(-outward as 1 | -1) ? outward : (-outward as 1 | -1)
}

/** A time scale's label: its text, which way it points and the lanes it spans. */
export const timeScaleLabel = (context: EditorDrawContext, entity: TimeScaleEntity) => {
    const x = entity.editorLane
    const text = formatTimeScale(entity.timeScale, entity.skip)
    const textWidth = measureCachedText(context, text, 0.5)
    const width = LABEL_OFFSET + EASE_GLYPH.width + EASE_GLYPH.gap + textWidth
    const direction = timeScaleLabelDirection(x, width, context.bounds)
    // From the ease glyph to the text's far end.
    const near = x + LABEL_OFFSET * direction
    const far = x + width * direction
    return {
        text,
        textWidth,
        direction,
        min: Math.min(near, far),
        max: Math.max(near, far),
    }
}

// Held steps and segments without a value transition have a quieter indicator.
const INSTANT_ALPHA = 0.7

/**
 * Draws a time scale's ease toward the next change, mirrored when the value
 * decreases, or an equals sign when no value transition follows. Returns its width.
 */
const drawEaseGlyph = (
    context: EditorDrawContext,
    entity: TimeScaleEntity,
    x: number,
    y: number,
    direction: 1 | -1,
    color: string,
) => {
    const { ctx, scale } = context
    const next = nextTimeScale(context, entity)
    const isConstant = next === null || next?.timeScale === entity.timeScale
    const { width, height, gap, stroke } = EASE_GLYPH
    const left = direction > 0 ? x : x - width
    const top = y - height / 2
    ctx.save()
    if (isNoneEase(entity.timeScaleEase) || isConstant) ctx.globalAlpha *= INSTANT_ALPHA
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(stroke, 1 / scale)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    if (isConstant) {
        for (const offset of [-height / 4, height / 4]) {
            ctx.moveTo(left + stroke, y + offset)
            ctx.lineTo(left + width - stroke, y + offset)
        }
    } else {
        for (const [index, [px, py]] of easeGlyphPoints(
            entity.timeScaleEase,
            !!next && next.timeScale < entity.timeScale,
        ).entries()) {
            if (index) ctx.lineTo(left + px * width, top + py * height)
            else ctx.moveTo(left + px * width, top + py * height)
        }
    }
    ctx.stroke()
    ctx.restore()
    return width + gap
}

const drawConnection = (context: EditorDrawContext, entity: EventConnectionEntity) => {
    const { ctx, state, ups } = context
    let cached = connectionPaths.get(entity)
    if (cached?.bpms !== state.bpms || cached.ups !== ups) {
        const minXs = jointXs(entity.min)
        const maxXs = jointXs(entity.max)
        const yMin = beatToTime(state.bpms, entity.min.beat) * ups
        const yMax = beatToTime(state.bpms, entity.max.beat) * ups
        const minWidth = rangeMinWidth(entity.min)
        cached = {
            bpms: state.bpms,
            ups,
            paths:
                minWidth === undefined
                    ? minXs.map(
                          (x, index) =>
                              new Path2D(
                                  getPathD(x, maxXs[index] ?? x, yMin, yMax, entity.min.eventEase),
                              ),
                      )
                    : getRangePathDs(
                          minXs as [number, number],
                          maxXs as [number, number],
                          yMin,
                          yMax,
                          entity.min.eventEase,
                          minWidth,
                      ).map((d) => new Path2D(d)),
        }
        connectionPaths.set(entity, cached)
    }

    ctx.strokeStyle = eventColor(entity.min)
    ctx.globalAlpha *= 0.5
    // Keep separate strokes: coincident left/right edges intentionally overlap.
    for (const path of cached.paths) ctx.stroke(path)
}

/** A BPM's or time scale's line, marker or label, for drawing them in separate layers. */
export type EventPart = 'line' | 'marker' | 'label'

/** Draws one event, or only `part` of it, without retaining reactive editor state. */
export const drawEvent = (
    context: EditorDrawContext,
    entity: DrawnEventEntity,
    highlighted: boolean,
    opacity = 1,
    part?: EventPart,
) => {
    const { ctx, state, ups } = context
    ctx.save()
    ctx.globalAlpha *= opacity
    ctx.lineWidth = 2 / context.scale
    ctx.lineCap = 'butt'
    ctx.lineJoin = 'miter'
    ctx.setLineDash([])

    switch (entity.type) {
        case 'cameraEventConnection':
        case 'stageMaskEventConnection':
        case 'stagePivotEventConnection':
        case 'stageStyleEventConnection':
        case 'stageTransformEventConnection':
            drawConnection(context, entity)
            break
        case 'bpm': {
            const y = beatToTime(state.bpms, entity.beat) * ups
            if (part === undefined || part === 'line') {
                ctx.strokeStyle = '#f0f'
                ctx.globalAlpha *= 0.5
                line(ctx, -6, y, 6, y)
                ctx.globalAlpha *= 2
            }
            if (part === undefined || part === 'label')
                drawText(
                    context,
                    formatBpm(entity.bpm),
                    BPM_LABEL.lane,
                    y,
                    '#f0f',
                    BPM_LABEL.size,
                    'start',
                    context.figureMiddle,
                )
            break
        }
        case 'timeScale': {
            const x = entity.editorLane
            const y = beatToTime(state.bpms, entity.beat) * ups
            const isScroll = entity.timeScaleTransition === 'scroll'
            // Hollow markers keep the line out of their interior.
            const gap = entity.hideNotes ? (isScroll ? DIAMOND_RADIUS : 0.1) : 0
            if (part === undefined || part === 'line') {
                ctx.strokeStyle = '#ff0'
                ctx.globalAlpha *= 0.5
                if (entity.hideNotes) ctx.setLineDash([2 / context.scale, 2 / context.scale])
                ctx.lineDashOffset = 0
                if (x - gap > Math.min(x, -6)) line(ctx, Math.min(x, -6), y, x - gap, y)
                if (x + gap < Math.max(x, 6)) line(ctx, x + gap, y, Math.max(x, 6), y)
                ctx.globalAlpha *= 2
                ctx.setLineDash([])
            }
            if (part === undefined || part === 'marker')
                timeScaleMarker(ctx, x, y, isScroll, entity.hideNotes)
            if (part !== undefined && part !== 'label') break
            const { text, textWidth, direction } = timeScaleLabel(context, entity)
            const labelX = x + LABEL_OFFSET * direction
            const glyphWidth = drawEaseGlyph(context, entity, labelX, y, direction, '#ff0')
            const textX = labelX + glyphWidth * direction
            drawText(
                context,
                text,
                textX,
                y,
                '#ff0',
                0.5,
                direction > 0 ? 'start' : 'end',
                context.figureMiddle,
            )
            if (
                context.showGroupName &&
                entity.groupId !== context.defaultGroupId &&
                (highlighted || context.recentlyActive)
            ) {
                // Opposite the label, unless it turned inward for want of room there.
                const side = direction === (x > 0 ? 1 : -1) ? -direction : direction
                drawName(
                    context,
                    entity,
                    highlighted,
                    state.groups.get(entity.groupId)?.name ?? '',
                    side === direction ? textX + (textWidth + 0.2) * direction : x + 0.2 * side,
                    y,
                    '#0aa',
                    0.4,
                    side > 0 ? 'start' : 'end',
                )
            }
            break
        }
        case 'cameraEventJoint':
        case 'stageMaskEventJoint':
        case 'stagePivotEventJoint':
        case 'stageStyleEventJoint':
        case 'stageTransformEventJoint': {
            const xs = jointXs(entity)
            const x = xs[0] ?? 0
            const y = beatToTime(state.bpms, entity.beat) * ups
            const color = eventColor(entity)
            ctx.strokeStyle = color
            ctx.fillStyle = color
            ctx.globalAlpha *= 0.5
            if (xs[1] !== undefined) line(ctx, x, y, xs[1], y)
            if (entity.type === 'cameraEventJoint') {
                const target =
                    entity.cameraLeft + entity.cameraSize / 2 + entity.cameraZoomTargetLane
                ctx.beginPath()
                ctx.arc(target, y, 0.1, 0, 2 * Math.PI)
                ctx.fill()
            }
            ctx.globalAlpha *= 2
            ctx.strokeStyle = '#fff'
            for (const x of xs) marker(ctx, x, y)
            if (
                entity.type !== 'cameraEventJoint' &&
                context.showStageName &&
                state.isDynamicStages &&
                (highlighted || context.recentlyActive)
            ) {
                const stageName = state.stages.get(entity.stageId)?.name
                if (stageName)
                    drawName(
                        context,
                        entity,
                        highlighted,
                        stageName,
                        (x + (xs[1] ?? x)) / 2,
                        y,
                        stageNameColor(context),
                    )
            }
        }
    }
    ctx.restore()
}

const drawInfinity = (
    context: EditorDrawContext,
    range: Range<EventJointEntity>,
    fromStart: boolean,
    untilEnd: boolean,
    opacity: number,
) => {
    const { ctx, state, ups, bounds } = context
    ctx.save()
    ctx.globalAlpha *= 0.5 * opacity
    ctx.strokeStyle = eventColor(range.min)
    if (fromStart) {
        const y = beatToTime(state.bpms, range.min.beat) * ups
        for (const x of jointXs(range.min)) line(ctx, x, 0, x, y)
    }
    if (untilEnd) {
        const y = beatToTime(state.bpms, range.max.beat) * ups
        for (const x of jointXs(range.max)) line(ctx, x, y, x, bounds.t)
    }
    ctx.restore()
}

const drawStageInfinities = (
    context: EditorDrawContext,
    ranges: Iterable<[StageId, Range<StageEventJointEntity>]>,
    isEventVisible: boolean,
    scope: ScopeLookup,
) => {
    for (const [id, range] of ranges) {
        const visibility = scope.stage(range.min.stageId)
        if (visibility === 'hidden') continue
        const isVisible = isEventVisible && visibility === 'full'

        const stage = context.state.stages.get(id)
        const isMask = range.min.type === 'stageMaskEventJoint'
        drawInfinity(
            context,
            range,
            !isMask || !!stage?.isFromStart,
            !isMask || !!stage?.isUntilEnd,
            isVisible ? 1 : 0.25,
        )
    }
}

const infinityTypes = [
    'cameraEventConnection',
    'stageMaskEventConnection',
    'stagePivotEventConnection',
    'stageStyleEventConnection',
    'stageTransformEventConnection',
] as const

/**
 * Draws the lines extending event ranges to the chart start and end. Stage
 * ranges follow their stage's scope like the event connections they extend;
 * hidden event types are drawn faintly unless other objects are hidden.
 */
export const drawEventInfinities = (
    context: EditorDrawContext,
    visibilities: Record<EntityType, boolean>,
    scope: ScopeLookup,
    showOtherObjects: boolean,
) => {
    const { ctx, state } = context
    const { stageEventRanges } = state.store
    ctx.save()
    ctx.lineWidth = 2 / context.scale
    ctx.lineCap = 'butt'
    ctx.setLineDash([])
    const sortedTypes = [...infinityTypes].sort((a, b) => +visibilities[a] - +visibilities[b])
    for (const type of sortedTypes) {
        const isVisible = visibilities[type]
        if (!isVisible && !showOtherObjects) continue
        switch (type) {
            case 'cameraEventConnection': {
                const range = state.store.globalEventRanges.cameraEventJoint
                if (range) drawInfinity(context, range, true, true, isVisible ? 1 : 0.25)
                break
            }
            case 'stageMaskEventConnection':
                drawStageInfinities(context, stageEventRanges.stageMaskEventJoint, isVisible, scope)
                break
            case 'stagePivotEventConnection':
                drawStageInfinities(
                    context,
                    stageEventRanges.stagePivotEventJoint,
                    isVisible,
                    scope,
                )
                break
            case 'stageStyleEventConnection':
                drawStageInfinities(
                    context,
                    stageEventRanges.stageStyleEventJoint,
                    isVisible,
                    scope,
                )
                break
            case 'stageTransformEventConnection':
                drawStageInfinities(
                    context,
                    stageEventRanges.stageTransformEventJoint,
                    isVisible,
                    scope,
                )
                break
        }
    }
    ctx.restore()
}
