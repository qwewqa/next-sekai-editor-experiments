import { ease, easeMode, isNoneEase, isStepEase, sampleEase, type Ease } from '../../ease'
import type { DrawGradient } from '../../rendering/context'
import { DrawPath } from '../../rendering/path'
import type { ConnectorEntity } from '../../state/entities/slides/connector'
import type { SlideInfos } from '../../state/entities/slides/hiddenTicks'
import { beatToTime, timeToBeat, type BpmIntegral } from '../../state/integrals/bpms'
import { clamp, lerp, safeUnlerp, safeUnlerpClamped } from '../../utils/math'
import { isConnectorVisible } from '../entities/visibility'
import { connectorColors } from '../utils/connectorColors'
import { guideElevationFraction } from '../utils/guideAlpha'
import { sampleComposed, type ComposedSample } from './composedSampling'
import type { EditorDrawContext } from './types'

type Edge = { time: number; left: number; size: number }

/** A stretch of the drawn body: its ends' y and its edges a fraction along it. */
type Region = {
    yHead: number
    yTail: number
    at: (u: number) => Omit<Edge, 'time'>
    /** Held or linear: its cross runs corner to corner. */
    straight: boolean
}

type ComposedLayout = NonNullable<EditorDrawContext['composed']>

/** Composed body strips in lanes and seconds, so zoom reuses them. */
type ComposedGeometry = {
    strips: ComposedSample[][]
    /** Each strip's fake-marker cross points, at CROSS_SAMPLES steps. */
    crosses?: Omit<Edge, 'time'>[][]
}

type ConnectorGraphic = {
    /** Composed geometry depends only on the entity, tempo and stages. */
    stages?: ComposedLayout['stages']
    geometry?: ComposedGeometry
    infos?: SlideInfos
    bpms: BpmIntegral[]
    ups: number
    path: DrawPath
    edges?: DrawPath
    edgeColor?: string
    maxEdgeWidth: number
    fakeMarker?: DrawPath
    color: string
    headAlpha: number
    tailAlpha: number
    headColor: string
    tailColor: string
    gradient?: DrawGradient
    yHead: number
    yTail: number
}

// A fixed power of two keeps the reference lane/time metric close to common
// editor scales while making the normalization independent of the first PPS.
const BODY_REFERENCE_UPS = 8
type ConnectorBody = {
    bpms: BpmIntegral[]
    stages?: ComposedLayout['stages']
    infos?: SlideInfos
    originTime: number
    path: DrawPath
    yHead: number
    yTail: number
    gradient?: DrawGradient
    headColor?: string
    tailColor?: string
}

const rgba = (color: string, alpha: number) =>
    `rgba(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(color.slice(5, 7), 16)}, ${clamp(alpha)})`

const appendEase = (
    path: DrawPath,
    attachHead: Edge,
    attachTail: Edge,
    tHead: number,
    tTail: number,
    connectorEase: 'inQuad' | 'outQuad',
    ups: number,
    edges: DrawPath | undefined,
) => {
    const pHead = safeUnlerp(attachHead.time, attachTail.time, tHead, 0)
    const pTail = safeUnlerp(attachHead.time, attachTail.time, tTail, 1)
    const qHead = ease(connectorEase, pHead)
    const qTail = ease(connectorEase, pTail)
    const qMid = connectorEase === 'inQuad' ? pHead * pTail : 1 - (1 - pHead) * (1 - pTail)

    const lHead = lerp(attachHead.left, attachTail.left, qHead)
    const lTail = lerp(attachHead.left, attachTail.left, qTail)
    const lMid = lerp(attachHead.left, attachTail.left, qMid)
    const sHead = lerp(attachHead.size, attachTail.size, qHead)
    const sTail = lerp(attachHead.size, attachTail.size, qTail)
    const sMid = lerp(attachHead.size, attachTail.size, qMid)
    const yHead = tHead * ups
    const yTail = tTail * ups
    const yMid = ((tHead + tTail) / 2) * ups

    path.moveTo(lHead, yHead)
    path.quadraticCurveTo(lMid, yMid, lTail, yTail)
    path.lineTo(lTail + sTail, yTail)
    path.quadraticCurveTo(lMid + sMid, yMid, lHead + sHead, yHead)
    path.closePath()

    edges?.moveTo(lHead, yHead)
    edges?.quadraticCurveTo(lMid, yMid, lTail, yTail)
    edges?.moveTo(lHead + sHead, yHead)
    edges?.quadraticCurveTo(lMid + sMid, yMid, lTail + sTail, yTail)
}

const appendCurve = (
    path: DrawPath,
    attachHead: Edge,
    attachTail: Edge,
    tHead: number,
    tTail: number,
    connectorEase: Ease,
    ups: number,
    edges: DrawPath | undefined,
) => {
    const span = Math.max(
        Math.abs(attachTail.left - attachHead.left),
        Math.abs(attachTail.left + attachTail.size - attachHead.left - attachHead.size),
    )
    const points = sampleEase(
        connectorEase,
        safeUnlerp(attachHead.time, attachTail.time, tHead, 0),
        safeUnlerp(attachHead.time, attachTail.time, tTail, 1),
        CURVE_TOLERANCE / Math.max(span, CURVE_TOLERANCE),
    ).map((p) => {
        const q = ease(connectorEase, p)
        // Overshooting sizes collapse to the center instead of turning inside out.
        const size = lerp(attachHead.size, attachTail.size, q)
        return {
            left: lerp(attachHead.left, attachTail.left, q) + Math.min(size, 0) / 2,
            size: Math.max(size, 0),
            y: lerp(attachHead.time, attachTail.time, p) * ups,
        }
    })

    for (const [index, { left, y }] of points.entries()) {
        if (index) {
            path.lineTo(left, y)
            edges?.lineTo(left, y)
        } else {
            path.moveTo(left, y)
            edges?.moveTo(left, y)
        }
    }
    for (const [index, { left, size, y }] of [...points].reverse().entries()) {
        path.lineTo(left + size, y)
        if (index) {
            edges?.lineTo(left + size, y)
        } else {
            edges?.moveTo(left + size, y)
        }
    }
    path.closePath()
}

const appendConstant = (
    path: DrawPath,
    { left, size }: Omit<Edge, 'time'>,
    yHead: number,
    yTail: number,
    edges: DrawPath | undefined,
    regions?: Region[],
) => {
    regions?.push({ yHead, yTail, at: () => ({ left, size }), straight: true })
    path.rect(left, yTail, size, yHead - yTail)
    edges?.moveTo(left, yHead)
    edges?.lineTo(left, yTail)
    edges?.moveTo(left + size, yHead)
    edges?.lineTo(left + size, yTail)
}

// Steps hold their interior value; in-out steps jump at the attachment midpoint.
const appendStep = (
    path: DrawPath,
    attachHead: Edge,
    attachTail: Edge,
    tHead: number,
    tTail: number,
    connectorEase: Ease,
    ups: number,
    edges: DrawPath | undefined,
    regions?: Region[],
) => {
    const at = (q: number) => ({
        left: lerp(attachHead.left, attachTail.left, q),
        size: lerp(attachHead.size, attachTail.size, q),
    })
    const tMiddle = (attachHead.time + attachTail.time) / 2
    if (easeMode(connectorEase) === 'inOut' && tHead < tMiddle && tMiddle < tTail) {
        appendConstant(path, attachHead, tHead * ups, tMiddle * ups, edges, regions)
        appendConstant(path, attachTail, tMiddle * ups, tTail * ups, edges, regions)
        return
    }

    const p = safeUnlerp(attachHead.time, attachTail.time, (tHead + tTail) / 2, 0.5)
    appendConstant(path, at(ease(connectorEase, p)), tHead * ups, tTail * ups, edges, regions)
}

// Like the engine, ease each piece between its own ends; steps hold one value per piece.
const appendAttachedPiece = (
    path: DrawPath,
    attachHead: Edge,
    attachTail: Edge,
    tHead: number,
    tTail: number,
    connectorEase: Ease,
    ups: number,
    edges: DrawPath | undefined,
    regions?: Region[],
) => {
    const fHead = safeUnlerp(attachHead.time, attachTail.time, tHead, 0.5)
    const fTail = safeUnlerp(attachHead.time, attachTail.time, tTail, 0.5)
    // Attached notes sit on the curve at their time, with sizes floored at 0 about their centers.
    const edgeAt = (f: number) => {
        const q = ease(connectorEase, f)
        const size = lerp(attachHead.size, attachTail.size, q)
        return {
            left: lerp(attachHead.left, attachTail.left, q) + Math.min(size, 0) / 2,
            size: Math.max(size, 0),
        }
    }
    const head = edgeAt(fHead)
    const tail = edgeAt(fTail)
    const pinned = (f: number) => (f <= 0 ? 0 : f >= 1 ? 1 : ease(connectorEase, f))
    const interpFrac = (f: number, fallback: number) =>
        isNoneEase(connectorEase)
            ? 0
            : safeUnlerp(pinned(fHead), pinned(fTail), ease(connectorEase, f), fallback)
    const at = (interp: number) => {
        const size = lerp(head.size, tail.size, interp)
        return {
            left: lerp(head.left, tail.left, interp) + Math.min(size, 0) / 2,
            size: Math.max(size, 0),
        }
    }

    if (isStepEase(connectorEase)) {
        const constant = (from: number, to: number, tFrom: number, tTo: number) => {
            appendConstant(
                path,
                at(interpFrac((from + to) / 2, 0)),
                tFrom * ups,
                tTo * ups,
                edges,
                regions,
            )
        }
        if (connectorEase === 'inOutStep' && fHead < 0.5 && 0.5 < fTail) {
            const tSplit = lerp(tHead, tTail, (0.5 - fHead) / (fTail - fHead))
            constant(fHead, 0.5, tHead, tSplit)
            constant(0.5, fTail, tSplit, tTail)
        } else {
            constant(fHead, fTail, tHead, tTail)
        }
        return
    }

    regions?.push({
        yHead: tHead * ups,
        yTail: tTail * ups,
        at: (u) => {
            const f = lerp(fHead, fTail, u)
            return at(interpFrac(f, safeUnlerp(fHead, fTail, f, 0)))
        },
        straight: connectorEase === 'linear',
    })
    const span = Math.max(
        Math.abs(tail.left - head.left),
        Math.abs(tail.left + tail.size - head.left - head.size),
    )
    const points = sampleEase(
        connectorEase,
        fHead,
        fTail,
        CURVE_TOLERANCE / Math.max(span, CURVE_TOLERANCE),
    ).map((f) => ({
        ...at(interpFrac(f, safeUnlerp(fHead, fTail, f, 0))),
        y: lerp(attachHead.time, attachTail.time, f) * ups,
    }))
    for (const [index, { left, y }] of points.entries()) {
        if (index) {
            path.lineTo(left, y)
            edges?.lineTo(left, y)
        } else {
            path.moveTo(left, y)
            edges?.moveTo(left, y)
        }
    }
    for (const [index, { left, size, y }] of [...points].reverse().entries()) {
        path.lineTo(left + size, y)
        if (index) {
            edges?.lineTo(left + size, y)
        } else {
            edges?.moveTo(left + size, y)
        }
    }
    path.closePath()
}

const CURVE_TOLERANCE = 0.01

const CROSS_SAMPLES = 32

// An X across a stretch of the body, following its edges.
const appendCross = (marker: DrawPath, { yHead, yTail, at, straight }: Region) => {
    const samples = straight ? 1 : CROSS_SAMPLES
    const points = Array.from({ length: samples + 1 }, (_, index) => {
        const u = index / samples
        return { ...at(u), u, y: lerp(yHead, yTail, u) }
    })
    for (const [index, { left, size, u, y }] of points.entries()) {
        if (index) marker.lineTo(left + size * u, y)
        else marker.moveTo(left + size * u, y)
    }
    for (const [index, { left, size, u, y }] of points.entries()) {
        if (index) marker.lineTo(left + size * (1 - u), y)
        else marker.moveTo(left + size * (1 - u), y)
    }
}

const isFake = ({ segmentHead }: ConnectorEntity) =>
    segmentHead.connectorType !== 'guide' && segmentHead.connectorIsFake

const sampleConnector = (
    entity: ConnectorEntity,
    bpms: BpmIntegral[],
    composed: ComposedLayout,
): ComposedGeometry => {
    const { attachHead, attachTail, head, tail } = entity
    const breaks = new Set([head.beat, tail.beat])
    for (const note of [attachHead, attachTail]) {
        for (const beat of composed.stages.get(note.stageId)?.breakpoints ?? []) {
            if (head.beat < beat && beat < tail.beat) breaks.add(beat)
        }
    }
    if (attachHead.connectorEase === 'inOutStep') {
        const tAttachHead = beatToTime(bpms, attachHead.beat)
        const tAttachTail = beatToTime(bpms, attachTail.beat)
        const middle = timeToBeat(bpms, (tAttachHead + tAttachTail) / 2)
        if (head.beat < middle && middle < tail.beat) breaks.add(middle)
    }
    const strips = sampleComposed(
        bpms,
        [...breaks].sort((a, b) => a - b),
        (beat, rightLimit) => composed.connectorPosition(entity, beat, { rightLimit }),
    )
    if (!isFake(entity)) return { strips }
    const crosses = strips.map((points) => {
        const first = points[0]
        const last = points.at(-1)
        if (!first || !last) return []
        return Array.from({ length: CROSS_SAMPLES + 1 }, (_, index) => {
            const u = index / CROSS_SAMPLES
            return u <= 0
                ? first
                : u >= 1
                  ? last
                  : composed.connectorPosition(
                        entity,
                        timeToBeat(bpms, lerp(first.time, last.time, u)),
                    )
        })
    })
    return { strips, crosses }
}

const createGraphic = (
    entity: ConnectorEntity,
    bpms: BpmIntegral[],
    ups: number,
    composed?: ComposedLayout,
    infos?: SlideInfos,
    geometry = composed && sampleConnector(entity, bpms, composed),
    bodyOnly = false,
): ConnectorGraphic => {
    const { attachHead, attachTail, head, tail, segmentHead, segmentTail } = entity
    const tAttachHead = beatToTime(bpms, attachHead.beat)
    const tAttachTail = beatToTime(bpms, attachTail.beat)
    const tHead = beatToTime(bpms, head.beat)
    const tTail = beatToTime(bpms, tail.beat)
    const yHead = tHead * ups
    const yTail = tTail * ups
    const path = new DrawPath()
    const colors = connectorColors(segmentHead)
    const edges = !bodyOnly && colors.edge ? new DrawPath() : undefined
    const first = {
        time: tAttachHead,
        left: attachHead.left,
        size: attachHead.size,
    }
    const last = {
        time: tAttachTail,
        left: attachTail.left,
        size: attachTail.size,
    }

    const regions: Region[] = []
    if (geometry) {
        for (const [strip, points] of geometry.strips.entries()) {
            for (const [index, { left, time }] of points.entries()) {
                if (index) {
                    path.lineTo(left, time * ups)
                    edges?.lineTo(left, time * ups)
                } else {
                    path.moveTo(left, time * ups)
                    edges?.moveTo(left, time * ups)
                }
            }
            for (const [index, { left, size, time }] of [...points].reverse().entries()) {
                path.lineTo(left + size, time * ups)
                if (index) edges?.lineTo(left + size, time * ups)
                else edges?.moveTo(left + size, time * ups)
            }
            path.closePath()
            const first = points[0]
            const last = points.at(-1)
            const cross = geometry.crosses?.[strip]
            if (!first || !last || !cross) continue
            regions.push({
                yHead: first.time * ups,
                yTail: last.time * ups,
                straight: false,
                // Crosses sample at u = index / CROSS_SAMPLES.
                at: (u) => cross[Math.round(u * CROSS_SAMPLES)] ?? last,
            })
        }
    } else {
        const attached = head.isAttached || tail.isAttached
        if (attached)
            appendAttachedPiece(
                path,
                first,
                last,
                tHead,
                tTail,
                attachHead.connectorEase,
                ups,
                edges,
                regions,
            )
        const pieceEase = attached ? undefined : attachHead.connectorEase
        const pHead = safeUnlerp(tAttachHead, tAttachTail, tHead, 0)
        const pTail = safeUnlerp(tAttachHead, tAttachTail, tTail, 1)
        // Every unattached ease but a step draws one eased stretch, compound quads included.
        if (pieceEase && !isStepEase(pieceEase)) {
            regions.push({
                yHead,
                yTail,
                at: (u) => {
                    const q = ease(pieceEase, lerp(pHead, pTail, u))
                    const size = lerp(first.size, last.size, q)
                    return {
                        left: lerp(first.left, last.left, q) + Math.min(size, 0) / 2,
                        size: Math.max(size, 0),
                    }
                },
                straight: pieceEase === 'linear',
            })
        }
        // Linear and quadratic eases are exact; the rest are sampled.
        // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
        switch (pieceEase) {
            case 'linear': {
                const lHead = lerp(first.left, last.left, pHead)
                const lTail = lerp(first.left, last.left, pTail)
                const sHead = lerp(first.size, last.size, pHead)
                const sTail = lerp(first.size, last.size, pTail)
                path.moveTo(lHead, yHead)
                path.lineTo(lTail, yTail)
                path.lineTo(lTail + sTail, yTail)
                path.lineTo(lHead + sHead, yHead)
                path.closePath()
                edges?.moveTo(lHead, yHead)
                edges?.lineTo(lTail, yTail)
                edges?.moveTo(lHead + sHead, yHead)
                edges?.lineTo(lTail + sTail, yTail)
                break
            }
            case 'inQuad':
            case 'outQuad':
                appendEase(path, first, last, tHead, tTail, pieceEase, ups, edges)
                break
            case 'inOutQuad':
            case 'outInQuad': {
                const middle = {
                    time: (tAttachHead + tAttachTail) / 2,
                    left: (first.left + last.left) / 2,
                    size: (first.size + last.size) / 2,
                }
                if (tHead < middle.time) {
                    appendEase(
                        path,
                        first,
                        middle,
                        tHead,
                        Math.min(middle.time, tTail),
                        pieceEase === 'inOutQuad' ? 'inQuad' : 'outQuad',
                        ups,
                        edges,
                    )
                }
                if (tTail > middle.time) {
                    appendEase(
                        path,
                        middle,
                        last,
                        Math.max(tHead, middle.time),
                        tTail,
                        pieceEase === 'inOutQuad' ? 'outQuad' : 'inQuad',
                        ups,
                        edges,
                    )
                }
                break
            }
            case undefined:
                break
            default: {
                if (isStepEase(pieceEase))
                    appendStep(path, first, last, tHead, tTail, pieceEase, ups, edges, regions)
                else appendCurve(path, first, last, tHead, tTail, pieceEase, ups, edges)
            }
        }
    }

    const color = colors.body
    let headAlpha: number
    let tailAlpha: number
    if (segmentHead.connectorType === 'guide') {
        const tSegmentHead = beatToTime(bpms, segmentHead.beat)
        const tSegmentTail = beatToTime(bpms, segmentTail.beat)
        // As the engine does, a segment under 1e-6 s takes its middle alpha.
        const alphaAt = (time: number, note: typeof head) =>
            lerp(
                segmentHead.connectorGuideAlpha,
                segmentTail.connectorGuideAlpha,
                (segmentHead.beat === segmentTail.beat
                    ? guideElevationFraction(note, segmentHead, segmentTail, infos)
                    : undefined) ?? safeUnlerpClamped(tSegmentHead, tSegmentTail, time),
            ) * 0.5
        headAlpha = alphaAt(tHead, head)
        tailAlpha = alphaAt(tTail, tail)
        // The time canvas collapses a same-beat ribbon to zero height. Its
        // representative alpha is the mean; a degenerate gradient has no axis.
        if (yHead === yTail) headAlpha = tailAlpha = (headAlpha + tailAlpha) / 2
    } else {
        headAlpha = tailAlpha = 0.8
    }

    let fakeMarker: DrawPath | undefined
    if (!bodyOnly && isFake(entity)) {
        fakeMarker = new DrawPath()
        for (const region of regions) appendCross(fakeMarker, region)
    }

    return {
        stages: composed?.stages,
        geometry,
        infos,
        bpms,
        ups,
        path,
        edges,
        edgeColor: colors.edge,
        maxEdgeWidth: Math.min(first.size, last.size) * 0.12,
        fakeMarker,
        color,
        headAlpha,
        tailAlpha,
        headColor: rgba(color, headAlpha),
        tailColor: rgba(color, tailAlpha),
        yHead,
        yTail,
    }
}

/** Only connector body commands are normalized; current stroke paths stay untouched. */
const createBody = (
    entity: ConnectorEntity,
    bpms: BpmIntegral[],
    composed: ComposedLayout | undefined,
    infos: SlideInfos | undefined,
    geometry: ComposedGeometry | undefined,
): ConnectorBody | undefined => {
    const originTime = beatToTime(bpms, entity.head.beat)
    const origin = originTime * BODY_REFERENCE_UPS
    if (!Number.isFinite(origin)) return
    const graphic = createGraphic(entity, bpms, BODY_REFERENCE_UPS, composed, infos, geometry, true)
    const path = new DrawPath()
    for (const command of graphic.path.commands) {
        switch (command[0]) {
            case 'moveTo':
            case 'lineTo': {
                const y = command[2] - origin
                if (!Number.isFinite(y)) return
                path[command[0]](command[1], y)
                break
            }
            case 'quadraticCurveTo': {
                const cy = command[2] - origin
                const y = command[4] - origin
                if (![cy, y].every(Number.isFinite)) return
                path.quadraticCurveTo(command[1], cy, command[3], y)
                break
            }
            case 'rect': {
                const y = command[2] - origin
                if (!Number.isFinite(y)) return
                path.rect(command[1], y, command[3], command[4])
                break
            }
            case 'closePath':
                path.closePath()
                break
            case 'roundRect':
            case 'bezierCurveTo':
            case 'ellipse':
            case 'arcTo':
            case 'svg':
            case 'addPath':
            case 'transform':
                // Keep this a feature contract, not a second generic path transformer.
                return
        }
    }
    const yHead = graphic.yHead - origin
    const yTail = graphic.yTail - origin
    if (![yHead, yTail].every(Number.isFinite)) return
    return { bpms, stages: composed?.stages, infos, originTime, path, yHead, yTail }
}

export const createConnectorRenderer = () => {
    // Entity keys are immutable and weak: deleted charts and old undo states do
    // not leave native paths permanently retained by the renderer. Each entity
    // keeps only its most recent zoom/BPM geometry.
    let graphics = new WeakMap<ConnectorEntity, ConnectorGraphic>()
    let bodies = new WeakMap<ConnectorEntity, ConnectorBody>()

    return {
        draw(
            context: EditorDrawContext,
            entity: ConnectorEntity,
            _highlighted: boolean,
            opacity = 1,
        ) {
            if (opacity <= 0 || !isConnectorVisible(entity)) return

            const { ctx, state, ups, scale } = context
            let graphic = graphics.get(entity)
            // Keyed on stages, not the layout: drag previews keep untouched slides' paths.
            const stages = context.composed?.stages
            const infos =
                entity.segmentHead.connectorType === 'guide' &&
                entity.segmentHead.beat === entity.segmentTail.beat
                    ? state.store.slides.info.get(entity.head.slideId)
                    : undefined
            if (
                graphic?.bpms !== state.bpms ||
                graphic.ups !== ups ||
                graphic.stages !== stages ||
                graphic.infos !== infos
            ) {
                graphic = createGraphic(
                    entity,
                    state.bpms,
                    ups,
                    context.composed,
                    infos,
                    // Zoom only rescales the sampled geometry.
                    graphic?.bpms === state.bpms && graphic.stages === stages
                        ? graphic.geometry
                        : undefined,
                )
                graphics.set(entity, graphic)
            }

            ctx.save()
            let body = bodies.get(entity)
            if (body?.bpms !== state.bpms || body.stages !== stages || body.infos !== infos) {
                body = createBody(entity, state.bpms, context.composed, infos, graphic.geometry)
                if (body) bodies.set(entity, body)
                else bodies.delete(entity)
            }
            // Large absolute coordinates can round a positive time span to the
            // same current Y. Preserve the established collapsed-body behavior.
            if (graphic.yHead === graphic.yTail) body = undefined
            if (graphic.headAlpha === graphic.tailAlpha) {
                ctx.globalAlpha = opacity * clamp(graphic.headAlpha)
                ctx.fillStyle = graphic.color
            } else {
                // Like the path, gradient coordinates follow the drawing
                // transform, so panning can reuse the native gradient object.
                const gradientOwner = body ?? graphic
                if (
                    !gradientOwner.gradient ||
                    (body &&
                        (body.headColor !== graphic.headColor ||
                            body.tailColor !== graphic.tailColor))
                ) {
                    gradientOwner.gradient = ctx.createLinearGradient(
                        0,
                        gradientOwner.yHead,
                        0,
                        gradientOwner.yTail,
                    )
                    gradientOwner.gradient.addColorStop(0, graphic.headColor)
                    gradientOwner.gradient.addColorStop(1, graphic.tailColor)
                    if (body) {
                        body.headColor = graphic.headColor
                        body.tailColor = graphic.tailColor
                    }
                }
                ctx.globalAlpha = opacity
                ctx.fillStyle = gradientOwner.gradient
            }
            if (
                !body ||
                !ctx.fillConnectorBody(body.path, ups / BODY_REFERENCE_UPS, body.originTime * ups)
            ) {
                // Declined transforms use current-UPS gradient coordinates too.
                if (body && graphic.headAlpha !== graphic.tailAlpha) {
                    if (!graphic.gradient) {
                        graphic.gradient = ctx.createLinearGradient(
                            0,
                            graphic.yHead,
                            0,
                            graphic.yTail,
                        )
                        graphic.gradient.addColorStop(0, graphic.headColor)
                        graphic.gradient.addColorStop(1, graphic.tailColor)
                    }
                    ctx.fillStyle = graphic.gradient
                }
                ctx.fill(graphic.path)
            }
            // Only the two sides are outlined: segment boundaries and compound
            // easing midpoints must not acquire horizontal seams. Cap the width
            // for narrow connectors so their selected color remains visible.
            if (graphic.edges && graphic.edgeColor && graphic.maxEdgeWidth > 0) {
                ctx.save()
                ctx.strokeStyle = graphic.edgeColor
                ctx.lineWidth = Math.min(3 / scale, graphic.maxEdgeWidth)
                ctx.lineCap = 'butt'
                ctx.setLineDash([])
                // Preserve the head/tail cuts while caching the intersection;
                // ordinary frames need no separate stencil-mask pass.
                ctx.strokeClipped(graphic.edges, graphic.path)
                ctx.restore()
            }

            if (graphic.fakeMarker) {
                ctx.globalAlpha = opacity * 0.8
                ctx.strokeStyle = '#f44'
                ctx.lineWidth = 2 / scale
                ctx.setLineDash([])
                ctx.strokeFakeMarker(graphic.fakeMarker)
            }
            ctx.restore()
        },
        clear() {
            graphics = new WeakMap()
            bodies = new WeakMap()
        },
    }
}
