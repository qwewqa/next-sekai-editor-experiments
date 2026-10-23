// The minimap's one coordinate mapping (design §4.2): pure, in CSS px from the canvas's top left.
// The painter, the overlay, input and the annotations all read it.

/** CSS px; device px are CSS px times `scale`. */
export type MinimapGeometry = { width: number; height: number; scale: number }

export type MinimapMapping = {
    end: number
    geometry: MinimapGeometry
    /** CSS px from the canvas top. */
    timeToY: (time: number) => number
    /** Clamped to [0, end]. */
    yToTime: (y: number) => number
    laneToX: (lane: number) => number
    spanToX: (left: number, size: number) => [number, number]
}

/** The tick column (C) at the left edge, which no note reaches. */
export const PAD_LEFT = 4
export const PAD_RIGHT = 2
export const PAD_Y = 4
/** Lanes drawn linearly (−6 to 6). */
export const CORE = 6
/** The share of the width the core lanes take. */
export const CORE_SHARE = 0.8

/** The most device rows a canvas gets. */
export const MAX_BACKING_HEIGHT = 4096
export const MAX_SCALE = 2

export const backingSize = ({ width, height, scale }: MinimapGeometry) => ({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
})

/** The scale for a device pixel ratio: at most 2, and low enough for `MAX_BACKING_HEIGHT`. */
export const capScale = (devicePixelRatio: number, height: number) => {
    const scale = Math.min(devicePixelRatio > 0 ? devicePixelRatio : 1, MAX_SCALE)
    return height > 0 ? Math.min(scale, MAX_BACKING_HEIGHT / height) : scale
}

/**
 * A lane's offset from the middle as a fraction of the width: linear over the core lanes
 * (±0.4 at ±6), then compressed towards ±0.5 without reaching it.
 */
export const laneFraction = (lane: number) => {
    const distance = Math.abs(lane)
    const half = ((CORE_SHARE / 2) * Math.min(distance, CORE)) / CORE
    const beyond = distance - CORE
    const fraction =
        distance <= CORE
            ? half
            : CORE_SHARE / 2 + (0.5 - CORE_SHARE / 2) * (beyond / (beyond + CORE))
    return Math.sign(lane) * fraction
}

export const createMapping = (geometry: MinimapGeometry, end: number): MinimapMapping => {
    const { width, height, scale } = geometry
    const iw = Math.max(1, width - PAD_LEFT - PAD_RIGHT)
    const ih = Math.max(1, height - 2 * PAD_Y)
    const safeEnd = end > 0 ? end : 1
    const timeToY = (time: number) => PAD_Y + ih * (1 - Math.min(Math.max(time / safeEnd, 0), 1))
    const yToTime = (y: number) => safeEnd * (1 - Math.min(Math.max((y - PAD_Y) / ih, 0), 1))
    const laneToX = (lane: number) => PAD_LEFT + iw * (0.5 + laneFraction(lane))
    const minimum = 1 / scale
    const spanToX = (left: number, size: number): [number, number] => {
        let a = laneToX(left)
        let b = laneToX(left + size)
        if (a > b) [a, b] = [b, a]
        if (b - a < minimum) {
            const middle = (a + b) / 2
            a = middle - minimum / 2
            b = middle + minimum / 2
        }
        return [a, b]
    }
    return { end, geometry, timeToY, yToTime, laneToX, spanToX }
}
