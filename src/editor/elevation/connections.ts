import type { ConnectorLayer, ConnectorType } from '../../chart/note'
import { ease, isStepEase, sampleEase } from '../../ease'
import type { RenderSurface, WebGLDrawContext } from '../../rendering/context'
import { sameBeatAttachmentFraction } from '../../state/entities/slides/attachment'
import type { ConnectorEntity } from '../../state/entities/slides/connector'
import type { NoteEntity } from '../../state/entities/slides/note'
import { beatToTime, type BpmIntegral } from '../../state/integrals/bpms'
import type { StoreSlides } from '../../state/store/slides'
import { clamp, lerp, safeUnlerp, safeUnlerpClamped } from '../../utils/math'
import { connectorColors } from '../utils/connectorColors'
import { guideElevationFraction } from '../utils/guideAlpha'
import type { ElevationRow } from './layout'

export type ElevationConnection = {
    connector: ConnectorEntity
    head: ElevationRow
    tail: ElevationRow
    color: string
    edge?: string
    alpha: number
    tailAlpha?: number
    fake: boolean
    headFraction: number
    tailFraction: number
}

const layerOrder: Record<ConnectorLayer, number> = { under: 0, bottom: 1, top: 2, over: 3 }
const typeOrder: Record<ConnectorType, number> = { active: 0, damage: 1, guide: 2 }

const guideAlpha = (
    connector: ConnectorEntity,
    bpms?: BpmIntegral[],
    marker = connector.head,
    infos?: StoreSlides['info'],
) => {
    const timeAt = (beat: number) => (bpms ? beatToTime(bpms, beat) : beat)
    const start = timeAt(connector.segmentHead.beat)
    const end = timeAt(connector.segmentTail.beat)
    const fraction =
        (connector.segmentHead.beat === connector.segmentTail.beat
            ? guideElevationFraction(
                  marker,
                  connector.segmentHead,
                  connector.segmentTail,
                  infos?.get(connector.head.slideId),
              )
            : undefined) ??
        (Math.abs(end - start) < 1e-6
            ? 0.5
            : clamp((timeAt(connector.head.beat) - start) / (end - start)))
    return (
        clamp(
            lerp(
                connector.segmentHead.connectorGuideAlpha,
                connector.segmentTail.connectorGuideAlpha,
                fraction,
            ),
        ) * 0.5
    )
}

export const getElevationConnections = (
    rows: ElevationRow[],
    connectors: Iterable<ConnectorEntity[]>,
    enabled = true,
    bpms?: BpmIntegral[],
    infos?: StoreSlides['info'],
): ElevationConnection[] => {
    // A ribbon needs both distinct endpoints at this beat. In particular, do
    // not walk a long slide's connectors just to display one of its notes.
    if (!enabled || rows.length < 2) return []
    const byNote = new Map(rows.map((row) => [row.note, row]))
    const result: ElevationConnection[] = []
    for (const slide of connectors) {
        for (const connector of slide) {
            const head = byNote.get(connector.head)
            const tail = byNote.get(connector.tail)
            if (!head || !tail) continue
            const properties = connector.segmentHead
            const guide = properties.connectorType === 'guide'
            const alpha = guide ? guideAlpha(connector, bpms, connector.head, infos) : 0.8
            const tailAlpha =
                guide && connector.segmentHead.beat === connector.segmentTail.beat
                    ? guideAlpha(connector, bpms, connector.tail, infos)
                    : undefined
            if (!alpha && !tailAlpha) continue
            const colors = connectorColors(properties)
            // A zero-beat piece inside a time-based attachment has no parent
            // elevation interval. Ease over that piece's full elevation span.
            const localElevation =
                connector.head.beat === connector.tail.beat &&
                connector.attachHead.beat !== connector.attachTail.beat
            const fraction = (note: NoteEntity, fallback: number) => {
                if (
                    localElevation ||
                    !note.isAttached ||
                    note === connector.attachHead ||
                    note === connector.attachTail
                )
                    return fallback
                const timeAt = (beat: number) => (bpms ? beatToTime(bpms, beat) : beat)
                return (
                    sameBeatAttachmentFraction(connector.attachHead, connector.attachTail, note) ??
                    safeUnlerpClamped(
                        timeAt(connector.attachHead.beat),
                        timeAt(connector.attachTail.beat),
                        timeAt(note.beat),
                    )
                )
            }
            result.push({
                connector,
                head,
                tail,
                color: colors.body,
                edge: colors.edge,
                alpha,
                tailAlpha,
                fake: !guide && properties.connectorIsFake,
                headFraction: fraction(connector.head, 0),
                tailFraction: fraction(connector.tail, 1),
            })
        }
    }
    return result.sort((a, b) => {
        const headA = a.connector.segmentHead
        const headB = b.connector.segmentHead
        return (
            layerOrder[headA.connectorLayer] - layerOrder[headB.connectorLayer] ||
            typeOrder[headA.connectorType] - typeOrder[headB.connectorType]
        )
    })
}

export type ElevationRibbon = {
    headLeft: [number, number]
    headRight: [number, number]
    tailLeft: [number, number]
    tailRight: [number, number]
}

export const getElevationRibbon = (
    connection: ElevationConnection,
): ElevationRibbon | undefined => {
    const { head, tail, connector } = connection
    if (
        isStepEase(connector.attachHead.connectorEase) ||
        head.y === tail.y ||
        (head.w <= 0 && tail.w <= 0)
    )
        return
    return {
        headLeft: [head.x - head.w / 2, head.y],
        headRight: [head.x + head.w / 2, head.y],
        tailLeft: [tail.x - tail.w / 2, tail.y],
        tailRight: [tail.x + tail.w / 2, tail.y],
    }
}

type RibbonPoint = { x: number; y: number; w: number; u: number }

/** Same-beat connectors use elevation as their longitudinal easing axis. */
export const getElevationCurve = (connection: ElevationConnection): RibbonPoint[][] | undefined => {
    const { head, tail, connector, headFraction, tailFraction } = connection
    if (
        connector.head.beat !== connector.tail.beat ||
        head.y === tail.y ||
        (head.w <= 0 && tail.w <= 0)
    )
        return
    const type = connector.attachHead.connectorEase
    if (type === 'linear') return
    const pinned = (fraction: number) =>
        fraction <= 0 ? 0 : fraction >= 1 ? 1 : ease(type, fraction)
    const first = pinned(headFraction)
    const last = pinned(tailFraction)
    const interp = (u: number) =>
        type === 'none' || type === 'inStep'
            ? 0
            : safeUnlerp(
                  first,
                  last,
                  ease(type, lerp(headFraction, tailFraction, u)),
                  isStepEase(type) ? 0 : u,
              )
    const at = (u: number, q = interp(u)): RibbonPoint => ({
        x: lerp(head.x, tail.x, q),
        y: lerp(head.y, tail.y, u),
        w: Math.max(0, lerp(head.w, tail.w, q)),
        u,
    })
    if (isStepEase(type)) {
        const split = safeUnlerp(headFraction, tailFraction, 0.5, -1)
        const breaks = type === 'inOutStep' && split > 0 && split < 1 ? [0, split, 1] : [0, 1]
        return breaks.slice(1).map((to, index) => {
            const from = breaks[index] ?? 0
            const q = interp((from + to) / 2)
            return [
                { ...at(from, q), u: 0 },
                { ...at(to, q), u: 1 },
            ]
        })
    }
    const span = Math.max(
        Math.abs(tail.x - tail.w / 2 - head.x + head.w / 2),
        Math.abs(tail.x + tail.w / 2 - head.x - head.w / 2),
        1,
    )
    if (Math.abs(last - first) < 1e-6) return [[at(0), at(1)]]
    const fractions = sampleEase(
        type,
        Math.min(headFraction, tailFraction),
        Math.max(headFraction, tailFraction),
        (0.25 * Math.abs(last - first)) / span,
    )
    if (headFraction > tailFraction) fractions.reverse()
    return [fractions.map((fraction) => at(safeUnlerp(headFraction, tailFraction, fraction, 0)))]
}

const drawElevationCurve = (
    ctx: WebGLDrawContext,
    connection: ElevationConnection,
    sections: RibbonPoint[][],
) => {
    const body = () => {
        ctx.beginPath()
        for (const points of sections) {
            for (const [index, { x, y, w }] of points.entries()) {
                if (index) ctx.lineTo(x - w / 2, y)
                else ctx.moveTo(x - w / 2, y)
            }
            for (const { x, y, w } of [...points].reverse()) ctx.lineTo(x + w / 2, y)
            ctx.closePath()
        }
    }
    setFillStyle(ctx, connection)
    body()
    ctx.fill()
    const edgeWidth = Math.min(3, Math.min(connection.head.w, connection.tail.w) * 0.12)
    if (connection.edge && edgeWidth > 0) {
        ctx.save()
        body()
        ctx.clip()
        ctx.strokeStyle = connection.edge
        ctx.lineWidth = edgeWidth
        ctx.beginPath()
        for (const points of sections) {
            for (const side of [-1, 1]) {
                for (const [index, { x, y, w }] of points.entries()) {
                    if (index) ctx.lineTo(x + (w / 2) * side, y)
                    else ctx.moveTo(x + (w / 2) * side, y)
                }
            }
        }
        ctx.stroke()
        ctx.restore()
    }
    if (connection.fake) {
        ctx.globalAlpha = 0.8
        ctx.strokeStyle = '#f44'
        ctx.lineWidth = 2
        ctx.beginPath()
        for (const points of sections) {
            for (const side of [-1, 1]) {
                for (const [index, { x, y, w, u }] of points.entries()) {
                    if (index) ctx.lineTo(x + w * (u - 0.5) * side, y)
                    else ctx.moveTo(x + w * (u - 0.5) * side, y)
                }
            }
        }
        ctx.stroke()
    }
}

const setFillStyle = (ctx: WebGLDrawContext, connection: ElevationConnection) => {
    const { alpha, tailAlpha = alpha, color, head, tail } = connection
    if (alpha === tailAlpha || head.y === tail.y) {
        ctx.globalAlpha = (alpha + tailAlpha) / 2
        ctx.fillStyle = color
        return
    }
    const rgba = (opacity: number) =>
        `rgba(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(color.slice(5, 7), 16)}, ${clamp(opacity)})`
    const gradient = ctx.createLinearGradient(0, head.y, 0, tail.y)
    gradient.addColorStop(0, rgba(alpha))
    gradient.addColorStop(1, rgba(tailAlpha))
    ctx.globalAlpha = 1
    ctx.fillStyle = gradient
}

export const drawElevationConnections = (
    ctx: WebGLDrawContext,
    connections: ElevationConnection[],
) => {
    ctx.save()
    ctx.lineCap = 'butt'
    ctx.setLineDash([])
    for (const connection of connections) {
        const curve = getElevationCurve(connection)
        if (curve) {
            drawElevationCurve(ctx, connection, curve)
            continue
        }
        const ribbon = getElevationRibbon(connection)
        if (!ribbon) continue
        const { headLeft, headRight, tailLeft, tailRight } = ribbon
        const body = () => {
            ctx.beginPath()
            ctx.moveTo(...headLeft)
            ctx.lineTo(...tailLeft)
            ctx.lineTo(...tailRight)
            ctx.lineTo(...headRight)
            ctx.closePath()
        }
        setFillStyle(ctx, connection)
        body()
        ctx.fill()
        const edgeWidth = Math.min(3, Math.min(connection.head.w, connection.tail.w) * 0.12)
        if (connection.edge && edgeWidth > 0) {
            ctx.save()
            body()
            ctx.clip()
            ctx.strokeStyle = connection.edge
            ctx.lineWidth = edgeWidth
            ctx.beginPath()
            ctx.moveTo(...headLeft)
            ctx.lineTo(...tailLeft)
            ctx.moveTo(...headRight)
            ctx.lineTo(...tailRight)
            ctx.stroke()
            ctx.restore()
        }
        if (connection.fake) {
            ctx.globalAlpha = 0.8
            ctx.strokeStyle = '#f44'
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.moveTo(...headLeft)
            ctx.lineTo(...tailRight)
            ctx.moveTo(...tailLeft)
            ctx.lineTo(...headRight)
            ctx.stroke()
        }
    }
    ctx.restore()
}

// In lanes, so they scale with the notes.
const arrowGap = 0.08
const arrowHeadLength = 0.35
const arrowHeadHalfWidth = 0.19

/** Head to tail between the endpoint notes' drawn boxes; none when they're too close to show one. */
export const getElevationArrow = (
    connection: ElevationConnection,
    laneScale: number,
): { from: [number, number]; to: [number, number] } | undefined => {
    const { head, tail } = connection
    const dx = tail.x - head.x
    const dy = tail.y - head.y
    const length = Math.hypot(dx, dy)
    if (!length) return
    // The fraction of the way out of a note's 0.6 lane tall box, as its outline and hit area.
    const exit = (w: number) =>
        Math.min(
            dx ? w / 2 / Math.abs(dx) : Infinity,
            dy ? (0.3 * laneScale) / Math.abs(dy) : Infinity,
        )
    const gap = (arrowGap * laneScale) / length
    const start = exit(head.w) + gap
    const end = 1 - exit(tail.w) - gap
    if ((end - start) * length < (arrowHeadLength + 0.1) * laneScale) return
    return {
        from: [head.x + dx * start, head.y + dy * start],
        to: [head.x + dx * end, head.y + dy * end],
    }
}

// Faded arrows' layer, allocated once they're drawn.
let arrowLayer: RenderSurface | undefined
let arrowTarget: WebGLDrawContext | undefined
export const freeElevationArrowLayer = () => {
    arrowLayer?.dispose()
    arrowLayer = undefined
    arrowTarget = undefined
}

export const drawElevationArrows = (
    target: WebGLDrawContext,
    connections: ElevationConnection[],
    laneScale: number,
    opacity = 1,
) => {
    const arrows = connections.flatMap((connection) => {
        const arrow = getElevationArrow(connection, laneScale)
        return arrow ? [arrow] : []
    })
    if (!arrows.length) return
    // A faded arrow composites as one layer, so its overlapping strokes and fills don't show.
    let ctx = target
    let compositeLayer: RenderSurface | undefined
    if (opacity < 1) {
        const { width, height } = target.canvas
        // GPU layers belong to their destination's context. A restored or replaced
        // pane must never reuse a surface allocated by the old context.
        if (arrowTarget !== target) freeElevationArrowLayer()
        arrowTarget = target
        arrowLayer ??= target.createSurface(width, height)
        compositeLayer = arrowLayer
        if (arrowLayer.width !== width) arrowLayer.width = width
        if (arrowLayer.height !== height) arrowLayer.height = height
        const layer = arrowLayer.getContext()
        layer.clear()
        layer.setTransform(target.getTransform())
        ctx = layer
    }
    const headLength = arrowHeadLength * laneScale
    const headHalfWidth = arrowHeadHalfWidth * laneScale
    ctx.save()
    ctx.setLineDash([])
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const path = () => {
        ctx.beginPath()
        for (const { from, to } of arrows) {
            const length = Math.hypot(to[0] - from[0], to[1] - from[1])
            const ux = (to[0] - from[0]) / length
            const uy = (to[1] - from[1]) / length
            const baseX = to[0] - ux * headLength
            const baseY = to[1] - uy * headLength
            ctx.moveTo(...from)
            ctx.lineTo(baseX, baseY)
            ctx.moveTo(...to)
            ctx.lineTo(baseX - uy * headHalfWidth, baseY + ux * headHalfWidth)
            ctx.lineTo(baseX + uy * headHalfWidth, baseY - ux * headHalfWidth)
            ctx.closePath()
        }
    }
    // A dark halo keeps them clear over light ribbons.
    path()
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'
    ctx.lineWidth = 0.15 * laneScale
    ctx.stroke()
    ctx.fillStyle = ctx.strokeStyle
    ctx.fill()
    path()
    ctx.strokeStyle = ctx.fillStyle = '#fff'
    ctx.lineWidth = 0.09 * laneScale
    ctx.stroke()
    ctx.fill()
    ctx.restore()
    if (!compositeLayer) return
    target.save()
    target.setTransform(1, 0, 0, 1, 0, 0)
    target.globalAlpha *= opacity
    target.drawImage(compositeLayer, 0, 0)
    target.restore()
}
