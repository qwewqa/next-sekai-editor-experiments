import type { ZKey } from '../gl'
import type { JudgmentSpriteSet, PreviewSkin, Sprite } from '../skin'
import type { PreviewFrameContext } from './context'
import { LAYER_STAGE, getZ, getZAlt } from './layer'
import {
    approach,
    computeStageTransform,
    currentLayoutTransform,
    identityStageScreenTransform,
    identityStageTransform,
    layoutSekaiStage,
    layoutStageLaneByEdges,
    perspectiveRect,
    stageTransformToAffine,
    tiltDepth,
    tiltWidenedEdge,
    tiltWidthFactor,
    transformedVecAt,
    type StageScreenTransform,
    type StageTransform,
} from './layout'
import {
    clamp,
    eventProgress,
    lerp,
    lerpVec,
    rotateVec,
    transformQuadAffine,
    vec,
    type EaseTypeValue,
    type LimitOptions,
    type Quad,
    type Vec,
} from './math'
import type { PreviewStage } from './model'

export type Transition<T> = {
    start: T
    end: T
    progress: number
}

export type StageProps = {
    lane: number
    width: number
    pivotLane: number
    division: Transition<{ size: number; parity: number }>
    laneColor: Transition<number>
    judgeLineColor: Transition<number>
    judgeLineStyle: Transition<number>
    leftBorderStyle: Transition<number>
    rightBorderStyle: Transition<number>
    order: number
    noteAlpha: number
    maskNotes: boolean
    laneAlpha: number
    judgeLineAlpha: number
    yOffset: number
    fullWidth: number
    divisionLineAlpha: number
    rotate: number
    xLaneTranslate: number
    yLaneTranslate: number
    centerWeight: number
    elevation: number
}

const FULL_WIDTH_HALF_EXTENT = 48
const JUDGE_LINE_BORDER_FACTOR = 5

type Draw = (sprite: Sprite | undefined, quad: Quad, z: ZKey, a: number) => void

const snapDividerEdgeToScreenPixels = (
    context: PreviewFrameContext,
    a: Vec,
    b: Vec,
): [Vec, Vec] => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const width = Math.hypot(dx, dy)
    const pixelSize = context.layout.screenPixelSize
    if (width <= 0 || pixelSize <= 0) return [a, b]

    const snappedWidth = Math.max(1, Math.round(width / pixelSize)) * pixelSize
    const halfScale = snappedWidth / width / 2
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2

    return [
        vec(mx - dx * halfScale, my - dy * halfScale),
        vec(mx + dx * halfScale, my + dy * halfScale),
    ]
}

const snapDividerThicknessToScreenPixels = (context: PreviewFrameContext, quad: Quad): Quad => {
    const [bl, br] = snapDividerEdgeToScreenPixels(context, quad.bl, quad.br)
    const [tl, tr] = snapDividerEdgeToScreenPixels(context, quad.tl, quad.tr)
    return { bl, tl, tr, br }
}

// The last event before t, or at t for the right limit.
const findEvent = (events: { time: number }[], t: number, rightLimit: boolean) => {
    let lo = 0
    let hi = events.length - 1
    let result = -1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const time = events[mid]!.time
        if (rightLimit ? time <= t : time < t) {
            result = mid
            lo = mid + 1
        } else {
            hi = mid - 1
        }
    }
    return result
}

const queryEvents = <T extends { time: number; ease: EaseTypeValue }>(
    events: T[],
    t: number,
    rightLimit: boolean,
): [T | undefined, T | undefined, number] => {
    const index = findEvent(events, t, rightLimit)
    const a = events[index]
    const b = events[index + 1]

    if (!a) return [undefined, b, 0]
    if (!b || b.time <= a.time) return [a, undefined, 0]

    return [a, b, eventProgress(a.ease, t, a.time, b.time, rightLimit)]
}

// Note-time values use the left limit; Play and Watch draw frames at the right limit.
export const getStageProps = (
    stage: PreviewStage,
    t: number,
    { rightLimit = false }: LimitOptions = {},
): StageProps => {
    const props: StageProps = {
        lane: 0,
        width: 0,
        pivotLane: 0,
        division: { start: { size: 0, parity: 0 }, end: { size: 0, parity: 0 }, progress: 0 },
        laneColor: { start: 0, end: 0, progress: 0 },
        judgeLineColor: { start: 0, end: 0, progress: 0 },
        judgeLineStyle: { start: 0, end: 0, progress: 0 },
        leftBorderStyle: { start: 0, end: 0, progress: 0 },
        rightBorderStyle: { start: 0, end: 0, progress: 0 },
        order: stage.order,
        noteAlpha: 1,
        maskNotes: false,
        laneAlpha: 0,
        judgeLineAlpha: 0,
        yOffset: 0,
        fullWidth: 0,
        divisionLineAlpha: 0,
        rotate: 0,
        xLaneTranslate: 0,
        yLaneTranslate: 0,
        centerWeight: 0,
        elevation: 0,
    }

    const [maskA, maskB, maskProgress] = queryEvents(stage.masks, t, rightLimit)
    if (maskA) {
        props.lane = maskA.lane
        props.width = maskA.size
        props.maskNotes = maskA.maskNotes
        if (maskB) {
            const p = maskProgress
            props.lane = lerp(maskA.lane, maskB.lane, p)
            props.width = Math.max(0, lerp(maskA.size, maskB.size, p))
        }
    } else if (maskB) {
        props.lane = maskB.lane
        props.width = maskB.size
        props.maskNotes = maskB.maskNotes
    }

    const [pivotA, pivotB, pivotProgress] = queryEvents(stage.pivots, t, rightLimit)
    if (pivotA) {
        props.pivotLane = pivotA.lane
        props.division.start = {
            size: Math.trunc(pivotA.divisionSize),
            parity: pivotA.divisionParity,
        }
        props.division.end = props.division.start
        props.yOffset = pivotA.yOffset
        if (pivotB) {
            const p = pivotProgress
            props.pivotLane = lerp(pivotA.lane, pivotB.lane, p)
            props.division.end = {
                size: Math.trunc(pivotB.divisionSize),
                parity: pivotB.divisionParity,
            }
            props.division.progress = p
            props.yOffset = lerp(pivotA.yOffset, pivotB.yOffset, p)
        }
    } else if (pivotB) {
        props.pivotLane = pivotB.lane
        props.division.start = {
            size: Math.trunc(pivotB.divisionSize),
            parity: pivotB.divisionParity,
        }
        props.division.end = props.division.start
        props.yOffset = pivotB.yOffset
    }

    const [styleA, styleB, styleProgress] = queryEvents(stage.styles, t, rightLimit)
    if (styleA) {
        props.laneColor = {
            start: styleA.laneColor,
            end: styleA.laneColor,
            progress: 0,
        }
        props.judgeLineColor = {
            start: styleA.judgeLineColor,
            end: styleA.judgeLineColor,
            progress: 0,
        }
        props.judgeLineStyle = {
            start: styleA.judgeLineStyle,
            end: styleA.judgeLineStyle,
            progress: 0,
        }
        props.leftBorderStyle = {
            start: styleA.leftBorderStyle,
            end: styleA.leftBorderStyle,
            progress: 0,
        }
        props.rightBorderStyle = {
            start: styleA.rightBorderStyle,
            end: styleA.rightBorderStyle,
            progress: 0,
        }
        props.noteAlpha = styleA.noteAlpha
        props.laneAlpha = styleA.laneAlpha
        props.judgeLineAlpha = styleA.judgeLineAlpha
        props.fullWidth = styleA.fullWidth
        props.divisionLineAlpha = styleA.divisionLineAlpha
        if (styleB) {
            const p = styleProgress
            props.laneColor.end = styleB.laneColor
            props.laneColor.progress = p
            props.judgeLineColor.end = styleB.judgeLineColor
            props.judgeLineColor.progress = p
            props.judgeLineStyle.end = styleB.judgeLineStyle
            props.judgeLineStyle.progress = p
            props.leftBorderStyle.end = styleB.leftBorderStyle
            props.leftBorderStyle.progress = p
            props.rightBorderStyle.end = styleB.rightBorderStyle
            props.rightBorderStyle.progress = p
            props.noteAlpha = clamp(lerp(styleA.noteAlpha, styleB.noteAlpha, p), 0, 1)
            props.laneAlpha = clamp(lerp(styleA.laneAlpha, styleB.laneAlpha, p), 0, 1)
            props.judgeLineAlpha = clamp(
                lerp(styleA.judgeLineAlpha, styleB.judgeLineAlpha, p),
                0,
                1,
            )
            props.fullWidth = clamp(lerp(styleA.fullWidth, styleB.fullWidth, p), 0, 1)
            props.divisionLineAlpha = clamp(
                lerp(styleA.divisionLineAlpha, styleB.divisionLineAlpha, p),
                0,
                1,
            )
        }
    } else if (styleB) {
        props.laneColor = {
            start: styleB.laneColor,
            end: styleB.laneColor,
            progress: 0,
        }
        props.judgeLineColor = {
            start: styleB.judgeLineColor,
            end: styleB.judgeLineColor,
            progress: 0,
        }
        props.judgeLineStyle = {
            start: styleB.judgeLineStyle,
            end: styleB.judgeLineStyle,
            progress: 0,
        }
        props.leftBorderStyle = {
            start: styleB.leftBorderStyle,
            end: styleB.leftBorderStyle,
            progress: 0,
        }
        props.rightBorderStyle = {
            start: styleB.rightBorderStyle,
            end: styleB.rightBorderStyle,
            progress: 0,
        }
        props.noteAlpha = styleB.noteAlpha
        props.laneAlpha = styleB.laneAlpha
        props.judgeLineAlpha = styleB.judgeLineAlpha
        props.fullWidth = styleB.fullWidth
        props.divisionLineAlpha = styleB.divisionLineAlpha
    }

    const [transformA, transformB, transformProgress] = queryEvents(stage.transforms, t, rightLimit)
    if (transformA) {
        props.rotate = transformA.rotate
        props.xLaneTranslate = transformA.xLaneTranslate
        props.yLaneTranslate = transformA.yLaneTranslate
        props.centerWeight = transformA.centerWeight
        props.elevation = transformA.elevation
        if (transformB) {
            const p = transformProgress
            props.rotate = lerp(transformA.rotate, transformB.rotate, p)
            props.xLaneTranslate = lerp(transformA.xLaneTranslate, transformB.xLaneTranslate, p)
            props.yLaneTranslate = lerp(transformA.yLaneTranslate, transformB.yLaneTranslate, p)
            props.centerWeight = lerp(transformA.centerWeight, transformB.centerWeight, p)
            props.elevation = lerp(transformA.elevation, transformB.elevation, p)
        }
    } else if (transformB) {
        props.rotate = transformB.rotate
        props.xLaneTranslate = transformB.xLaneTranslate
        props.yLaneTranslate = transformB.yLaneTranslate
        props.centerWeight = transformB.centerWeight
        props.elevation = transformB.elevation
    }

    return props
}

/** getStageProps' pivotLane + xLaneTranslate alone, without the other properties. */
export const getStageOffset = (
    stage: PreviewStage,
    t: number,
    { rightLimit = false }: LimitOptions = {},
) => {
    let pivotLane = 0
    const [pivotA, pivotB, pivotProgress] = queryEvents(stage.pivots, t, rightLimit)
    if (pivotA) pivotLane = pivotB ? lerp(pivotA.lane, pivotB.lane, pivotProgress) : pivotA.lane
    else if (pivotB) pivotLane = pivotB.lane

    let xLaneTranslate = 0
    const [transformA, transformB, transformProgress] = queryEvents(stage.transforms, t, rightLimit)
    if (transformA)
        xLaneTranslate = transformB
            ? lerp(transformA.xLaneTranslate, transformB.xLaneTranslate, transformProgress)
            : transformA.xLaneTranslate
    else if (transformB) xLaneTranslate = transformB.xLaneTranslate

    return pivotLane + xLaneTranslate
}

/** getStageProps' yOffset alone. */
export const getStageYOffset = (
    stage: PreviewStage,
    t: number,
    { rightLimit = false }: LimitOptions = {},
) => {
    const [pivotA, pivotB, pivotProgress] = queryEvents(stage.pivots, t, rightLimit)
    if (pivotA) return pivotB ? lerp(pivotA.yOffset, pivotB.yOffset, pivotProgress) : pivotA.yOffset
    return pivotB ? pivotB.yOffset : 0
}

export const stagePropsHasTransform = (props: StageProps) =>
    props.rotate !== 0 ||
    props.xLaneTranslate !== 0 ||
    props.yLaneTranslate !== 0 ||
    props.centerWeight !== 0 ||
    props.elevation !== 0

export const stagePropsTransform = (
    context: PreviewFrameContext,
    props: StageProps,
    elevationOffset = 0,
): StageTransform =>
    stagePropsHasTransform(props) || elevationOffset !== 0
        ? computeStageTransform(
              context.layout,
              currentLayoutTransform(context.layout),
              props.rotate,
              props.xLaneTranslate,
              props.yLaneTranslate,
              props.lane,
              props.centerWeight,
              props.elevation + elevationOffset,
          )
        : identityStageTransform

const transitionWeight = (transition: Transition<number>, target: number) => {
    let weight = 0
    if (transition.start === target) weight += 1 - transition.progress
    if (transition.end === target) weight += transition.progress
    return Math.max(0, weight)
}

const borderStyleWidth = (style: number, normal: number, medium: number, light: number) => {
    switch (style) {
        case 0:
            return normal
        case 1:
            return light
        case 3:
            return medium
        default:
            return 0
    }
}

const borderWidth = (style: Transition<number>, normal: number, medium: number, light: number) =>
    Math.max(
        0,
        lerp(
            borderStyleWidth(style.start, normal, medium, light),
            borderStyleWidth(style.end, normal, medium, light),
            style.progress,
        ),
    )

const borderSpriteTransition = (style: Transition<number>): Transition<number> => {
    let start = style.start === 3 ? 0 : style.start
    let end = style.end === 3 ? 0 : style.end
    if (start === 2) start = end
    if (end === 2) end = start
    return { start, end, progress: start === end ? 0 : style.progress }
}

// Overshooting blends collapse an edge at its midpoint instead of flipping it.
const blendBorderLayout = (start: Quad, end: Quad, progress: number): Quad => {
    const result = {
        bl: lerpVec(start.bl, end.bl, progress),
        br: lerpVec(start.br, end.br, progress),
        tl: lerpVec(start.tl, end.tl, progress),
        tr: lerpVec(start.tr, end.tr, progress),
    }
    const flipped = (a: Vec, b: Vec, startA: Vec, startB: Vec, endA: Vec, endB: Vec) =>
        (b.x - a.x) * (startB.x - startA.x + endB.x - endA.x) +
            (b.y - a.y) * (startB.y - startA.y + endB.y - endA.y) <
        0
    if (flipped(result.bl, result.br, start.bl, start.br, end.bl, end.br)) {
        const mid = lerpVec(result.bl, result.br, 0.5)
        result.bl = mid
        result.br = mid
    }
    if (flipped(result.tl, result.tr, start.tl, start.tr, end.tl, end.tr)) {
        const mid = lerpVec(result.tl, result.tr, 0.5)
        result.tl = mid
        result.tr = mid
    }
    return result
}

// The lane background's body alpha in the skins that have colored lanes.
export const LANE_BACKGROUND_ALPHA = 0.4

// The alphas of two sprites drawn on the same quad, B over A, so that the pair shows `alpha` in
// all and B's share is `progress`. A sprite body with alpha `body` is composited as "over":
// B at alpha * t and A at alpha * (1 - t) / (1 - body * alpha * t).
export const crossfadeAlphas = (alpha: number, progress: number, body = 1): [number, number] => {
    const a = clamp(alpha, 0, 1)
    const t = clamp(progress, 0, 1)
    const denominator = 1 - body * a * t
    return [denominator > 0 ? (a * (1 - t)) / denominator : 0, a * t]
}

// Draws A once when both are the same sprite, else the compensated pair.
export const drawCrossfade = (
    draw: Draw,
    spriteA: Sprite | undefined,
    spriteB: Sprite | undefined,
    quad: Quad,
    zA: ZKey,
    zB: ZKey,
    alpha: number,
    progress: number,
    body = 1,
) => {
    if (spriteA === spriteB) {
        draw(spriteA, quad, zA, clampAlpha(alpha))
        return
    }
    const [alphaA, alphaB] = crossfadeAlphas(alpha, progress, body)
    if (alphaA > 0) draw(spriteA, quad, zA, alphaA)
    if (alphaB > 0) draw(spriteB, quad, zB, alphaB)
}

const clampAlpha = (alpha: number) => clamp(alpha, 0, 1)

const isCollapsedBorder = (q: Quad) =>
    q.bl.x === q.br.x && q.bl.y === q.br.y && q.tl.x === q.tr.x && q.tl.y === q.tr.y

export const resolveJudgeLineStyle = (style: Transition<number>) =>
    style.progress < 0.5 ? style.start : style.end

export const drawStaticStage = (context: PreviewFrameContext, draw: Draw, skin: PreviewSkin) => {
    if (skin.sekaiStage) {
        draw(skin.sekaiStage, layoutSekaiStage(context.layout), getZ(context.now, LAYER_STAGE), 1)
        return
    }

    drawDynamicStage(context, draw, skin, {
        lane: 0,
        width: 6,
        pivotLane: 0,
        division: { start: { size: 2, parity: 0 }, end: { size: 2, parity: 0 }, progress: 0 },
        laneColor: { start: 0, end: 0, progress: 0 },
        judgeLineColor: { start: 5, end: 5, progress: 0 },
        judgeLineStyle: { start: 0, end: 0, progress: 0 },
        leftBorderStyle: { start: 0, end: 0, progress: 0 },
        rightBorderStyle: { start: 0, end: 0, progress: 0 },
        order: 0,
        noteAlpha: 1,
        maskNotes: false,
        laneAlpha: 1,
        judgeLineAlpha: 1,
        yOffset: 0,
        fullWidth: 0,
        divisionLineAlpha: 1,
        rotate: 0,
        xLaneTranslate: 0,
        yLaneTranslate: 0,
        centerWeight: 0,
        elevation: 0,
    })
}

export const drawStageWithProps = (
    context: PreviewFrameContext,
    draw: Draw,
    skin: PreviewSkin,
    props: StageProps,
) => {
    const transform = stagePropsHasTransform(props)
        ? stageTransformToAffine(stagePropsTransform(context, props))
        : identityStageScreenTransform

    drawDynamicStage(context, draw, skin, props, transform)
}

export const drawDynamicStage = (
    context: PreviewFrameContext,
    draw: Draw,
    skin: PreviewSkin,
    props: StageProps,
    transform: StageScreenTransform = identityStageScreenTransform,
) => {
    const {
        lane,
        width,
        pivotLane,
        division,
        laneColor,
        judgeLineColor,
        judgeLineStyle,
        leftBorderStyle: originalLeftBorderStyle,
        rightBorderStyle: originalRightBorderStyle,
        order,
        laneAlpha,
        judgeLineAlpha,
        yOffset,
    } = props

    const place = (q: Quad) => transformQuadAffine(transform, q)

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const spritesA = skin.judgments[judgeLineColor.start] ?? skin.judgments[0]!
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const spritesB = skin.judgments[judgeLineColor.end] ?? skin.judgments[0]!
    // B's share of a judgment line color change.
    const pSprites = judgeLineColor.progress
    const wDivStart = Math.max(0, 1 - division.progress)
    const wDivEnd = Math.max(0, division.progress)

    const wDefault = transitionWeight(judgeLineStyle, 0)
    const wSingleLine = transitionWeight(judgeLineStyle, 1)
    const fw = clamp(props.fullWidth, 0, 1)

    if (!skin.laneBackground) {
        drawFallbackStage(context, draw, skin, props, transform)
        return
    }

    const travel = approach(context.layout, 1 - yOffset)
    const nh = context.layout.noteH
    const l = lane - width
    const r = lane + width
    const halfJl = lerp(width, FULL_WIDTH_HALF_EXTENT, fw)
    const lJl = lane - halfJl
    const rJl = lane + halfJl

    const z = (sub: number) => getZAlt(LAYER_STAGE, order * 17 + sub, transform.elevation)

    const f = JUDGE_LINE_BORDER_FACTOR

    const layoutLaneBorder = (style: number, edge: number, isLeft: boolean): Quad => {
        const borderW = borderStyleWidth(style, 0.08, 0.04, 0.025)
        const left = style === 1 ? edge - borderW / 2 : isLeft ? edge - borderW : edge
        const right = style === 1 ? edge + borderW / 2 : isLeft ? edge : edge + borderW
        const bottom = layoutStageLaneByEdges(context.layout, left, right)
        const top = layoutStageLaneByEdges(
            context.layout,
            tiltWidenedEdge(context.layout, left, edge + 8 * (left - edge)),
            tiltWidenedEdge(context.layout, right, edge + 8 * (right - edge)),
        )
        return { bl: bottom.bl, br: bottom.br, tl: top.tl, tr: top.tr }
    }

    const leftBorderLayout = blendBorderLayout(
        layoutLaneBorder(originalLeftBorderStyle.start, l, true),
        layoutLaneBorder(originalLeftBorderStyle.end, l, true),
        originalLeftBorderStyle.progress,
    )
    const rightBorderLayout = blendBorderLayout(
        layoutLaneBorder(originalRightBorderStyle.start, r, false),
        layoutLaneBorder(originalRightBorderStyle.end, r, false),
        originalRightBorderStyle.progress,
    )

    const drawBorder = (style: number, isLeft: boolean, q: Quad, zKey: ZKey, alpha: number) => {
        if (alpha <= 0 || isCollapsedBorder(q)) return
        switch (style) {
            case 0:
            case 3: {
                if (!isLeft) q = { bl: q.br, br: q.bl, tl: q.tr, tr: q.tl }
                draw(skin.stageBorder, place(q), zKey, clampAlpha(alpha))
                break
            }
            case 1: {
                draw(
                    skin.laneDivider,
                    snapDividerThicknessToScreenPixels(context, place(q)),
                    zKey,
                    clampAlpha(alpha),
                )
                break
            }
        }
    }

    const drawLeftBorder = (style: number, zKey: ZKey, alpha: number) => {
        drawBorder(style, true, leftBorderLayout, zKey, alpha)
    }
    const drawRightBorder = (style: number, zKey: ZKey, alpha: number) => {
        drawBorder(style, false, rightBorderLayout, zKey, alpha)
    }

    const drawDividers = (
        divisionSize: number,
        parity: number,
        pivot: number,
        zKey: ZKey,
        alpha: number,
    ) => {
        if (divisionSize <= 0) return

        const eps = 0.001
        const parityOffset = parity === 1 ? divisionSize / 2 : 0
        const shiftedPivot = pivot + parityOffset

        const kStart = Math.floor((l - shiftedPivot + eps) / divisionSize) + 1
        const kEnd = Math.ceil((r - shiftedPivot - eps) / divisionSize) - 1

        for (let k = kStart; k <= kEnd; k++) {
            const pos = shiftedPivot + k * divisionSize
            const layoutB = layoutStageLaneByEdges(context.layout, pos - 0.0125, pos + 0.0125)
            const layoutT = layoutStageLaneByEdges(
                context.layout,
                tiltWidenedEdge(context.layout, pos - 0.0125, pos - 0.1),
                tiltWidenedEdge(context.layout, pos + 0.0125, pos + 0.1),
            )
            draw(
                skin.laneDivider,
                snapDividerThicknessToScreenPixels(
                    context,
                    place({ bl: layoutB.bl, tl: layoutT.tl, tr: layoutT.tr, br: layoutB.br }),
                ),
                zKey,
                clampAlpha(alpha),
            )
        }
    }

    const thicknessScale = lerp(
        1,
        travel > 0 ? clamp(1 / travel, 1, 4) : 4,
        context.layout.stageTilt,
    )
    const judgmentDividerSize =
        0.014 * thicknessScale * tiltWidthFactor(context.layout, travel) * context.layout.wScale
    const judgmentDividerOffset = rotateVec(vec(judgmentDividerSize, 0), -context.layout.rotate)
    const dividerDepthB = tiltDepth(context.layout, 1 + nh - nh / f + 0.001, travel)
    const dividerDepthT = tiltDepth(context.layout, 1 - nh + nh / f - 0.001, travel)

    const layoutJudgmentDivider = (dividerLane: number): Quad => {
        const b = transformedVecAt(context.layout, dividerLane, dividerDepthB)
        const t = transformedVecAt(context.layout, dividerLane, dividerDepthT)
        return {
            bl: vec(b.x - judgmentDividerOffset.x, b.y - judgmentDividerOffset.y),
            tl: vec(t.x - judgmentDividerOffset.x, t.y - judgmentDividerOffset.y),
            tr: vec(t.x + judgmentDividerOffset.x, t.y + judgmentDividerOffset.y),
            br: vec(b.x + judgmentDividerOffset.x, b.y + judgmentDividerOffset.y),
        }
    }

    const drawJudgmentDividers = (
        sprites: JudgmentSpriteSet,
        halfOffset: boolean,
        pivot: number,
        zLo: ZKey,
        zHi: ZKey,
        alpha: number,
    ) => {
        const eps = 0.001
        const shiftedPivot = pivot + (halfOffset ? 0.5 : 0)

        const kStart = Math.floor(l - shiftedPivot + eps) + 1
        const kEnd = Math.ceil(r - shiftedPivot - eps) - 1

        for (let k = kStart; k <= kEnd; k++) {
            const pos = shiftedPivot + k
            const divLayout = snapDividerThicknessToScreenPixels(
                context,
                place(layoutJudgmentDivider(pos)),
            )
            // The center and the edge are a compensated pair, so each divider shows `alpha`.
            const edgeWeight = width > 0 ? Math.abs(pos - lane) / width : 0
            const [centerAlpha, edgeAlpha] = crossfadeAlphas(alpha, edgeWeight)
            draw(sprites.center, divLayout, zLo, centerAlpha)
            draw(sprites.edge, divLayout, zHi, edgeAlpha)
        }
    }

    const layoutJudgmentBorder = (style: number, edge: number, isLeft: boolean): Quad => {
        if (style === 1) return layoutJudgmentDivider(edge)
        const borderW = style === 2 ? 0 : Math.max(0, Math.min(1 / f / 2, width))
        return perspectiveRect(
            context.layout,
            isLeft ? edge : edge - borderW,
            isLeft ? edge + borderW : edge,
            1 - nh + nh / f,
            1 + nh - nh / f,
            travel,
        )
    }

    const leftJudgmentLayout = blendBorderLayout(
        layoutJudgmentBorder(originalLeftBorderStyle.start, l, true),
        layoutJudgmentBorder(originalLeftBorderStyle.end, l, true),
        originalLeftBorderStyle.progress,
    )
    const rightJudgmentLayout = blendBorderLayout(
        layoutJudgmentBorder(originalRightBorderStyle.start, r, false),
        layoutJudgmentBorder(originalRightBorderStyle.end, r, false),
        originalRightBorderStyle.progress,
    )
    const leftBorderStyle = borderSpriteTransition(originalLeftBorderStyle)
    const rightBorderStyle = borderSpriteTransition(originalRightBorderStyle)

    const drawJudgmentBorder = (
        sprites: JudgmentSpriteSet,
        style: number,
        isLeft: boolean,
        q: Quad,
        zKey: ZKey,
        alpha: number,
    ) => {
        if (alpha <= 0 || isCollapsedBorder(q)) return
        switch (style) {
            case 0:
            case 3: {
                if (!isLeft) q = { bl: q.br, br: q.bl, tl: q.tr, tr: q.tl }
                draw(sprites.edgeLeft, place(q), zKey, clampAlpha(alpha))
                break
            }
            case 1: {
                draw(
                    sprites.edge,
                    snapDividerThicknessToScreenPixels(context, place(q)),
                    zKey,
                    clampAlpha(alpha),
                )
                break
            }
        }
    }

    const drawLeftJudgmentBorder = (
        sprites: JudgmentSpriteSet,
        style: number,
        zKey: ZKey,
        alpha: number,
    ) => {
        drawJudgmentBorder(sprites, style, true, leftJudgmentLayout, zKey, alpha)
    }
    const drawRightJudgmentBorder = (
        sprites: JudgmentSpriteSet,
        style: number,
        zKey: ZKey,
        alpha: number,
    ) => {
        drawJudgmentBorder(sprites, style, false, rightJudgmentLayout, zKey, alpha)
    }

    const drawGradient = (
        sprites: JudgmentSpriteSet,
        zGradient: ZKey,
        zEdge: ZKey,
        alpha: number,
    ) => {
        const bottomL = place(
            perspectiveRect(context.layout, lJl, lane, 1 + nh, 1 + nh - nh / f, travel),
        )
        const bottomR = place(
            perspectiveRect(context.layout, rJl, lane, 1 + nh, 1 + nh - nh / f, travel),
        )
        const topL = place(
            perspectiveRect(context.layout, lJl, lane, 1 - nh, 1 - nh + nh / f, travel),
        )
        const topR = place(
            perspectiveRect(context.layout, rJl, lane, 1 - nh, 1 - nh + nh / f, travel),
        )
        // Full Width swaps the gradient for the edge, as a compensated pair.
        const [gradA, edgeA] = crossfadeAlphas(alpha, fw)
        if (gradA > 0) {
            draw(sprites.gradient, bottomL, zGradient, gradA)
            draw(sprites.gradient, bottomR, zGradient, gradA)
            draw(sprites.gradient, topL, zGradient, gradA)
            draw(sprites.gradient, topR, zGradient, gradA)
        }
        if (edgeA > 0) {
            draw(sprites.edge, bottomL, zEdge, edgeA)
            draw(sprites.edge, bottomR, zEdge, edgeA)
            draw(sprites.edge, topL, zEdge, edgeA)
            draw(sprites.edge, topR, zEdge, edgeA)
        }
    }

    const drawSingleLine = (alpha: number) => {
        const halfThick = nh / f / 2
        const layout = place(
            perspectiveRect(context.layout, lJl, rJl, 1 - halfThick, 1 + halfThick, travel),
        )
        drawCrossfade(
            draw,
            spritesA.singleLine,
            spritesB.singleLine,
            layout,
            z(15),
            z(16),
            alpha,
            pSprites,
        )
    }

    const la = laneAlpha * (1 - fw)
    if (la > 0) {
        drawCrossfade(
            draw,
            skin.laneBackgrounds[laneColor.start],
            skin.laneBackgrounds[laneColor.end],
            place(layoutStageLaneByEdges(context.layout, l, r)),
            z(0),
            z(0.5),
            la,
            laneColor.progress,
            LANE_BACKGROUND_ALPHA,
        )

        const pLeft = leftBorderStyle.progress
        if (leftBorderStyle.start === leftBorderStyle.end) {
            drawLeftBorder(leftBorderStyle.start, z(3), la)
        } else {
            const [alphaStart, alphaEnd] = crossfadeAlphas(la, pLeft)
            drawLeftBorder(leftBorderStyle.start, z(3), alphaStart)
            drawLeftBorder(leftBorderStyle.end, z(4), alphaEnd)
        }

        const pRight = rightBorderStyle.progress
        if (rightBorderStyle.start === rightBorderStyle.end) {
            drawRightBorder(rightBorderStyle.start, z(3), la)
        } else {
            const [alphaStart, alphaEnd] = crossfadeAlphas(la, pRight)
            drawRightBorder(rightBorderStyle.start, z(3), alphaStart)
            drawRightBorder(rightBorderStyle.end, z(4), alphaEnd)
        }

        const laDiv = la * props.divisionLineAlpha
        if (laDiv > 0) {
            if (
                division.start.size === division.end.size &&
                division.start.parity === division.end.parity
            ) {
                drawDividers(division.start.size, division.start.parity, pivotLane, z(3), laDiv)
            } else {
                if (wDivStart > 0) {
                    drawDividers(
                        division.start.size,
                        division.start.parity,
                        pivotLane,
                        z(3),
                        laDiv * wDivStart,
                    )
                }
                if (wDivEnd > 0) {
                    drawDividers(
                        division.end.size,
                        division.end.parity,
                        pivotLane,
                        z(4),
                        laDiv * wDivEnd,
                    )
                }
            }
        }
    }

    const ja = judgeLineAlpha
    const jaBar = ja * wDefault
    const jaDec = jaBar * (1 - fw)
    const jaSingle = ja * wSingleLine

    // A judgment line color change fades each part as a compensated pair: color A under color B,
    // with A and B at `crossfadeAlphas(alpha, pSprites)`. A part whose sprites are the same in both
    // colors is drawn once.
    const sameSprites = (...keys: (keyof JudgmentSpriteSet)[]) =>
        keys.every((key) => spritesA[key] === spritesB[key])

    if (jaBar > 0) {
        const bgLayout = place(perspectiveRect(context.layout, lJl, rJl, 1 - nh, 1 + nh, travel))
        drawCrossfade(
            draw,
            spritesA.background,
            spritesB.background,
            bgLayout,
            z(1),
            z(2),
            jaBar,
            pSprites,
        )
    }

    const startHasHalfOffset = division.start.parity === 1 && division.start.size % 2 === 1
    const endHasHalfOffset = division.end.parity === 1 && division.end.size % 2 === 1
    const judgmentDividersSame = startHasHalfOffset === endHasHalfOffset

    if (jaDec > 0) {
        const dividersSame = sameSprites('center', 'edge')
        // One set of dividers in both colors: A in the first slots and B in the second.
        const drawDividerColors = (
            halfOffset: boolean,
            alpha: number,
            zLoA: number,
            zLoB: number,
        ) => {
            if (dividersSame) {
                drawJudgmentDividers(spritesA, halfOffset, pivotLane, z(zLoA), z(zLoA + 1), alpha)
                return
            }
            const [alphaA, alphaB] = crossfadeAlphas(alpha, pSprites)
            if (alphaA > 0)
                drawJudgmentDividers(spritesA, halfOffset, pivotLane, z(zLoA), z(zLoA + 1), alphaA)
            if (alphaB > 0)
                drawJudgmentDividers(spritesB, halfOffset, pivotLane, z(zLoB), z(zLoB + 1), alphaB)
        }

        if (judgmentDividersSame) {
            drawDividerColors(startHasHalfOffset, jaDec, 5, 9)
        } else {
            // The two sets sit at different positions, so each fades linearly with the division.
            if (wDivStart > 0) drawDividerColors(startHasHalfOffset, jaDec * wDivStart, 5, 9)
            if (wDivEnd > 0) drawDividerColors(endHasHalfOffset, jaDec * wDivEnd, 7, 11)
        }
    }

    if (jaBar > 0) {
        if (sameSprites('gradient', 'edge')) {
            drawGradient(spritesA, z(13), z(13.5), jaBar)
        } else {
            const [alphaA, alphaB] = crossfadeAlphas(jaBar, pSprites)
            if (alphaA > 0) drawGradient(spritesA, z(13), z(13.5), alphaA)
            if (alphaB > 0) drawGradient(spritesB, z(14), z(14.5), alphaB)
        }
    }

    if (jaDec > 0) {
        const bordersSame = sameSprites('edgeLeft', 'edge')
        // One side's border in both colors, each a pair of the start and end styles.
        const drawBorderColors = (
            style: Transition<number>,
            drawSide: (
                sprites: JudgmentSpriteSet,
                style: number,
                zKey: ZKey,
                alpha: number,
            ) => void,
        ) => {
            const drawStyles = (
                sprites: JudgmentSpriteSet,
                alpha: number,
                zStart: number,
                zEnd: number,
            ) => {
                if (style.start === style.end) {
                    drawSide(sprites, style.start, z(zStart), alpha)
                    return
                }
                const [alphaStart, alphaEnd] = crossfadeAlphas(alpha, style.progress)
                drawSide(sprites, style.start, z(zStart), alphaStart)
                drawSide(sprites, style.end, z(zEnd), alphaEnd)
            }

            if (bordersSame) {
                drawStyles(spritesA, jaDec, 5, 7)
                return
            }
            const [alphaA, alphaB] = crossfadeAlphas(jaDec, pSprites)
            drawStyles(spritesA, alphaA, 5, 7)
            drawStyles(spritesB, alphaB, 9, 11)
        }

        drawBorderColors(leftBorderStyle, drawLeftJudgmentBorder)
        drawBorderColors(rightBorderStyle, drawRightJudgmentBorder)
    }

    if (jaSingle > 0) drawSingleLine(jaSingle)
}

const drawFallbackStage = (
    context: PreviewFrameContext,
    draw: Draw,
    skin: PreviewSkin,
    props: StageProps,
    transform: StageScreenTransform,
) => {
    const { lane, width, pivotLane, division, judgeLineStyle, order } = props

    const place = (q: Quad) => transformQuadAffine(transform, q)

    const wDefault = transitionWeight(judgeLineStyle, 0)
    const wSingleLine = transitionWeight(judgeLineStyle, 1)
    const travel = approach(context.layout, 1 - props.yOffset)
    const nh = context.layout.noteH
    const l = lane - width
    const r = lane + width
    const fw = clamp(props.fullWidth, 0, 1)
    const halfJl = lerp(width, FULL_WIDTH_HALF_EXTENT, fw)
    const lJl = lane - halfJl
    const rJl = lane + halfJl
    const zLo = getZAlt(LAYER_STAGE, order * 4, transform.elevation)
    const zMid = getZAlt(LAYER_STAGE, order * 4 + 1, transform.elevation)
    const zHi = getZAlt(LAYER_STAGE, order * 4 + 2, transform.elevation)
    const zSingle = getZAlt(LAYER_STAGE, order * 4 + 3, transform.elevation)
    const la = props.laneAlpha * (1 - fw)
    const ja = props.judgeLineAlpha
    const leftWidth = borderWidth(props.leftBorderStyle, 0.25, 0.125, 0.025)
    const rightWidth = borderWidth(props.rightBorderStyle, 0.25, 0.125, 0.025)

    if (la > 0) {
        if (leftWidth > 0) {
            const layoutB = layoutStageLaneByEdges(context.layout, l - leftWidth, l)
            const layoutT = layoutStageLaneByEdges(
                context.layout,
                tiltWidenedEdge(context.layout, l - leftWidth, l - 4 * leftWidth),
                l,
            )
            draw(
                skin.stageLeftBorder,
                place({ bl: layoutB.bl, tl: layoutT.tl, tr: layoutT.tr, br: layoutB.br }),
                zMid,
                clampAlpha(la),
            )
        }
        if (rightWidth > 0) {
            const layoutB = layoutStageLaneByEdges(context.layout, r, r + rightWidth)
            const layoutT = layoutStageLaneByEdges(
                context.layout,
                r,
                tiltWidenedEdge(context.layout, r + rightWidth, r + 4 * rightWidth),
            )
            draw(
                skin.stageRightBorder,
                place({ bl: layoutB.bl, tl: layoutT.tl, tr: layoutT.tr, br: layoutB.br }),
                zMid,
                clampAlpha(la),
            )
        }

        const eps = 0.001
        const divisionSize = division.end.size
        const parityOffset = division.end.parity === 1 ? divisionSize / 2 : 0
        const shiftedPivot = pivotLane + parityOffset
        let prev = l
        if (divisionSize > 0) {
            const kStart = Math.floor((l - shiftedPivot + eps) / divisionSize) + 1
            const kEnd = Math.ceil((r - shiftedPivot - eps) / divisionSize) - 1
            for (let k = kStart; k <= kEnd; k++) {
                const pos = shiftedPivot + k * divisionSize
                draw(
                    skin.lane,
                    place(layoutStageLaneByEdges(context.layout, prev, pos)),
                    zLo,
                    clampAlpha(la),
                )
                prev = pos
            }
        }
        draw(skin.lane, place(layoutStageLaneByEdges(context.layout, prev, r)), zLo, clampAlpha(la))
    }

    if (ja * wDefault > 0) {
        const layout = place(perspectiveRect(context.layout, lJl, rJl, 1 - nh, 1 + nh, travel))
        draw(skin.judgmentLine, layout, zHi, clampAlpha(ja * wDefault))
    }
    if (ja * wSingleLine > 0) {
        const halfThick = nh / JUDGE_LINE_BORDER_FACTOR / 2
        const layout = place(
            perspectiveRect(context.layout, lJl, rJl, 1 - halfThick, 1 + halfThick, travel),
        )
        draw(skin.judgmentLine, layout, zSingle, clampAlpha(ja * wSingleLine))
    }
}
