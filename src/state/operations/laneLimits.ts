import { alignComputed, clamp } from '../../utils/math'
import type { EditableObject } from './editable'

const fields = [
    ['left', 'size'],
    ['cameraLeft', 'cameraSize'],
    ['maskLeft', 'maskSize'],
    ['pivotLane'],
    ['xTranslation'],
    ['editorLane'],
] as const

export const constrainLaneObject = <T extends EditableObject>(
    object: T,
    maxLane: number,
    resizing = false,
    noteMinimum = 0,
): T => {
    if (!(maxLane > 0) || !Number.isFinite(maxLane)) return object
    for (const [positionKey, sizeKey] of fields) {
        const position = object[positionKey]
        if (position === undefined) continue
        const originalSize = sizeKey ? object[sizeKey] : undefined
        // Level data may hold cameras narrower than the editor makes; a move keeps them.
        const minimum =
            positionKey === 'cameraLeft'
                ? resizing
                    ? 6
                    : Math.min(6, originalSize ?? 6)
                : positionKey === 'left' && resizing
                  ? Math.min(noteMinimum, maxLane * 2)
                  : 0
        const availableSize =
            resizing && originalSize !== undefined
                ? clamp(position + originalSize, -maxLane, maxLane) -
                  clamp(position, -maxLane, maxLane)
                : originalSize
        const fittedSize =
            originalSize === undefined
                ? 0
                : Math.max(minimum, Math.min(availableSize ?? 0, Math.max(minimum, maxLane * 2)))
        // A resize cut at the limit keeps its fixed edge; the size snaps only while it still fits.
        if (
            sizeKey &&
            originalSize !== undefined &&
            resizing &&
            position + originalSize > maxLane &&
            fittedSize === availableSize &&
            position >= -maxLane &&
            position <= maxLane
        ) {
            const aligned = alignComputed(fittedSize)
            return {
                ...object,
                [sizeKey]: position + aligned <= maxLane ? aligned : fittedSize,
            }
        }
        // Fitted edges come from sums, so they drop their float noise; kept values stay exact.
        const size = fittedSize === originalSize ? fittedSize : alignComputed(fittedSize)
        const oversized = size > maxLane * 2
        const fittedLeft = oversized ? -size / 2 : clamp(position, -maxLane, maxLane - size)
        // The snap never takes it past the limit.
        const left =
            fittedLeft === position
                ? position
                : oversized
                  ? alignComputed(fittedLeft)
                  : clamp(alignComputed(fittedLeft), -maxLane, maxLane - size)
        if (left === position && size === (originalSize ?? 0)) return object
        return {
            ...object,
            [positionKey]: left,
            ...(sizeKey && originalSize !== undefined ? { [sizeKey]: size } : {}),
        }
    }
    return object
}

/** The lanes an object covers on its lane axis: a span's edges, or a point twice. */
export const laneSpanOf = (object: EditableObject): readonly [number, number] | undefined => {
    for (const [positionKey, sizeKey] of fields) {
        const position = object[positionKey]
        if (position === undefined) continue
        return [position, position + ((sizeKey && object[sizeKey]) ?? 0)]
    }
}

/**
 * The lane shifts that keep a group of spans within ±maxLane as one: from where its left edge
 * reaches the limit to where its right edge does. A group past the limit can only shift back in,
 * and one wider than the range only while it covers the range. Undefined without a limit or spans.
 */
export const laneShiftRange = (
    spans: Iterable<readonly [number, number]>,
    maxLane: number,
): readonly [number, number] | undefined => {
    if (!(maxLane > 0) || !Number.isFinite(maxLane)) return
    let min = Infinity
    let max = -Infinity
    for (const [start, end] of spans) {
        min = Math.min(min, start)
        max = Math.max(max, end)
    }
    if (!(min <= max)) return
    const toLeft = -maxLane - min
    const toRight = maxLane - max
    return toLeft <= toRight ? [toLeft, toRight] : [toRight, toLeft]
}
