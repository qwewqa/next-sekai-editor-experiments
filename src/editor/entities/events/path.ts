import type { EventEase } from '../../../chart/events'
import { ease, easeOvershoot, isStepEase, sampleEase } from '../../../ease'
import { DrawPath } from '../../../rendering/path'
import { lerp } from '../../../utils/math'

const curveTolerance = 0.01

// The former SVG parser stops at its first invalid numeric token. Preserve that
// prefix if even finite input coordinates overflow while interpolating a curve.
class EventPath extends DrawPath {
    private failed = false

    private accepts(...values: number[]) {
        this.failed ||= !values.every(Number.isFinite)
        return !this.failed
    }

    override moveTo(x: number, y: number) {
        if (this.accepts(x, y)) super.moveTo(x, y)
    }

    override lineTo(x: number, y: number) {
        if (this.accepts(x, y)) super.lineTo(x, y)
    }

    override quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
        if (this.accepts(cx, cy, x, y)) super.quadraticCurveTo(cx, cy, x, y)
    }
}

/** Same event geometry as the former SVG builder, without number serialization or parsing. */
export const createEventPath = (
    xMin: number,
    xMax: number,
    yMin: number,
    yMax: number,
    eventEase: EventEase,
): DrawPath => {
    const path = new EventPath()
    if (isStepEase(eventEase)) {
        let x = xMin
        if (eventEase === 'outStep') x = xMax
        else if (eventEase === 'outInStep') x = lerp(xMin, xMax, 0.5)
        path.moveTo(x, yMin)
        if (eventEase === 'inOutStep') {
            path.lineTo(xMin, lerp(yMin, yMax, 0.5))
            path.moveTo(xMax, lerp(yMin, yMax, 0.5))
        }
        path.lineTo(eventEase === 'inOutStep' ? xMax : x, yMax)
        return path
    }
    // Other easing families use the adaptive sampling below.
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
    switch (eventEase) {
        case 'linear':
            path.moveTo(xMin, yMin)
            path.lineTo(xMax, yMax)
            return path
        case 'inQuad':
            path.moveTo(xMin, yMin)
            path.quadraticCurveTo(xMin, lerp(yMin, yMax, 0.5), xMax, yMax)
            return path
        case 'outQuad':
            path.moveTo(xMin, yMin)
            path.quadraticCurveTo(xMax, lerp(yMin, yMax, 0.5), xMax, yMax)
            return path
        case 'inOutQuad':
            path.moveTo(xMin, yMin)
            path.quadraticCurveTo(
                xMin,
                lerp(yMin, yMax, 0.25),
                lerp(xMin, xMax, 0.5),
                lerp(yMin, yMax, 0.5),
            )
            path.quadraticCurveTo(xMax, lerp(yMin, yMax, 0.75), xMax, yMax)
            return path
        case 'outInQuad':
            path.moveTo(xMin, yMin)
            path.quadraticCurveTo(
                lerp(xMin, xMax, 0.5),
                lerp(yMin, yMax, 0.25),
                lerp(xMin, xMax, 0.5),
                lerp(yMin, yMax, 0.5),
            )
            path.quadraticCurveTo(lerp(xMin, xMax, 0.5), lerp(yMin, yMax, 0.75), xMax, yMax)
            return path
    }
    // The sampled ease may not start at exactly xMin (notably elastic/back).
    for (const [index, p] of sampleEase(
        eventEase,
        0,
        1,
        curveTolerance / Math.max(Math.abs(xMax - xMin), curveTolerance),
    ).entries()) {
        const x = lerp(xMin, xMax, ease(eventEase, p))
        const y = lerp(yMin, yMax, p)
        if (index) path.lineTo(x, y)
        else path.moveTo(x, y)
    }
    return path
}

/** The engine floors a camera/mask range's width about its interpolated center. */
export const createRangeEventPaths = (
    [leftMin, rightMin]: [number, number],
    [leftMax, rightMax]: [number, number],
    yMin: number,
    yMax: number,
    eventEase: EventEase,
    minWidth: number,
): [DrawPath, DrawPath] => {
    const widthAt = (q: number) => lerp(rightMin - leftMin, rightMax - leftMax, q)
    const overshoot = easeOvershoot(eventEase)
    if (Math.min(widthAt(-overshoot), widthAt(1 + overshoot)) >= minWidth)
        return [
            createEventPath(leftMin, leftMax, yMin, yMax, eventEase),
            createEventPath(rightMin, rightMax, yMin, yMax, eventEase),
        ]
    const edgesAt = (q: number) => {
        const center = lerp((leftMin + rightMin) / 2, (leftMax + rightMax) / 2, q)
        const half = Math.max(minWidth, widthAt(q)) / 2
        return [center - half, center + half] as const
    }
    const paths: [DrawPath, DrawPath] = [new EventPath(), new EventPath()]
    if (isStepEase(eventEase)) {
        const first = ease(eventEase, 0.25)
        const second = ease(eventEase, 0.75)
        const pieces: readonly [from: number, to: number, q: number][] =
            first === second
                ? [[0, 1, first]]
                : [
                      [0, 0.5, first],
                      [0.5, 1, second],
                  ]
        for (const [from, to, q] of pieces) {
            const edges = edgesAt(q)
            for (const side of [0, 1] as const) {
                paths[side].moveTo(edges[side], lerp(yMin, yMax, from))
                paths[side].lineTo(edges[side], lerp(yMin, yMax, to))
            }
        }
        return paths
    }
    const span = Math.max(Math.abs(leftMax - leftMin), Math.abs(rightMax - rightMin))
    for (const [index, p] of sampleEase(
        eventEase,
        0,
        1,
        curveTolerance / Math.max(span, curveTolerance),
    ).entries()) {
        const edges = edgesAt(ease(eventEase, p))
        const y = lerp(yMin, yMax, p)
        for (const side of [0, 1] as const)
            if (index) paths[side].lineTo(edges[side], y)
            else paths[side].moveTo(edges[side], y)
    }
    return paths
}
