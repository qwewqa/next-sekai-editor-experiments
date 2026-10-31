import { binAt, roundParts, yScale, type ChartModel } from '../../levelData/statistics'

// The chart at a plot's size: the coordinates of its layers, Bars' tiles and the gridlines, and
// the readout read from the same coordinates, so the dot and the values sit on the drawn edges.

export type Tile = { x: number; y: number; width: number; height: number; layer: number }

export type Drawing = {
    width: number
    height: number
    yStep: number
    yTop: number
    /** Plot x of a time. */
    px: (time: number) => number
    /** Plot y of a value. */
    py: (value: number) => number
    /** Each boundary as a path, bottom first; the last is the total. */
    lines: string[]
    /** Each layer's area, bottom first. */
    areas: string[]
    tiles: Tile[]
    /** Gridlines' y and their thickness in CSS px. */
    grid: { y: number; value: number }[]
    gridWidth: number
    /** A whole number of device pixels from the plot's own origin. */
    snapX: (x: number) => number
    snapY: (y: number) => number
}

/**
 * Draws a model in a plot of `width` x `height` CSS px whose origin is on a device pixel, at
 * `dpr` device pixels per CSS px.
 */
export const drawChart = (
    model: ChartModel,
    width: number,
    height: number,
    dpr: number,
    yTicks = 4,
): Drawing => {
    const total = model.boundaries[model.boundaries.length - 1] ?? new Float64Array()
    let top = 0
    for (const value of total) top = Math.max(top, value)
    const { step: yStep, top: yTop } = yScale(top || 1, yTicks)
    const span = model.x1 - model.x0
    const px = (time: number) => ((time - model.x0) / span) * width
    const py = (value: number) => (1 - value / yTop) * height
    const snapX = (x: number) => Math.round(x * dpr) / dpr
    const snapY = snapX
    const xs = Array.from(model.xs, px)
    const ys = model.boundaries.map((boundary) => Array.from(boundary, py))
    const line = (values: number[]) => 'M' + xs.map((x, i) => `${x} ${values[i] ?? 0}`).join(' L')
    const lines = ys.map(line)
    const baseline = py(0)
    const areas = ys.map((upper, j) => {
        const lower = ys[j - 1]
        const back = xs.map((x, i) => `${x} ${lower ? (lower[i] ?? baseline) : baseline}`).reverse()
        return `${line(upper)} L${back.join(' L')} Z`
    })

    // Bars: tiles on device pixels; a one-device-pixel gap between bars from a pitch of 5 device
    // pixels; a nonzero part that would round to nothing takes one device pixel.
    const tiles: Tile[] = []
    const bins = model.bins
    if (bins) {
        const pitch = (px(bins.width) - px(0)) * dpr
        const gap = pitch >= 5 ? 1 / dpr : 0
        for (const bin of bins.bins) {
            if (!bin.count) continue
            const left = snapX(px(bin.a))
            const right = snapX(px(bin.b)) - gap
            let below = 0
            let base = snapY(py(0))
            bin.parts.forEach((count, layer) => {
                if (!count) return
                let y = snapY(py((below + count) / bins.width))
                if (y >= base - 1e-9) y = base - 1 / dpr
                tiles.push({ x: left, y, width: right - left, height: base - y, layer })
                below += count
                base = Math.min(base, y)
            })
        }
    }

    // Gridlines take whole device rows, the nearest to 1 CSS px.
    const gridWidth = Math.max(1, Math.round(dpr)) / dpr
    const grid: Drawing['grid'] = []
    for (let k = 0; k * yStep <= yTop * (1 + 1e-9); k++)
        grid.push({
            y: Math.min(snapY(py(k * yStep)), snapY(height) - gridWidth) + gridWidth / 2,
            value: k * yStep,
        })

    return {
        width,
        height,
        yStep,
        yTop,
        px,
        py,
        lines,
        areas,
        tiles,
        grid,
        gridWidth,
        snapX,
        snapY,
    }
}

export type Reading = {
    /** The total as drawn, and each layer's part. */
    value: number
    parts: number[]
    /** Whole counts (Rolling, 1 s bars) or one decimal. */
    exact: boolean
    /** The bin's span in Bars. */
    span?: [number, number]
    /** The dot's y. */
    y: number
}

/** The values drawn at a time: Smooth's from the emitted coordinates, Bars' bin, Rolling's step. */
export const readAt = (model: ChartModel, drawing: Drawing, time: number): Reading => {
    const toValue = (y: number) => (1 - y / drawing.height) * drawing.yTop
    if (model.bins) {
        const { width, bins } = model.bins
        const bin = binAt(bins, width, time)
        const value = (bin?.count ?? 0) / width
        const raw = (bin?.parts ?? []).map((count) => count / width)
        const exact = width === 1
        return {
            value,
            parts: exact ? raw : roundParts(raw, value),
            exact,
            span: [bin?.a ?? 0, bin?.b ?? width],
            y: drawing.py(value),
        }
    }
    if (model.steps) {
        const { steps } = model
        const index = Math.floor(((time - model.x0) / (model.x1 - model.x0)) * steps.length)
        const step = steps[Math.min(steps.length - 1, Math.max(0, index))]
        const value = step?.count ?? 0
        return { value, parts: step?.parts ?? [], exact: true, y: drawing.py(value) }
    }
    // Smooth: the boundaries at the cursor's x, on the straight lines between the drawn points.
    const x = drawing.px(time)
    const xs = model.xs
    const n = xs.length
    let lo = 0
    let hi = n - 1
    let u = 0
    const xAt = (i: number) => drawing.px(xs[i] ?? 0)
    if (x <= xAt(0)) hi = 0
    else if (x >= xAt(n - 1)) lo = hi
    else {
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1
            if (xAt(mid) <= x) lo = mid
            else hi = mid
        }
        const span = xAt(hi) - xAt(lo)
        u = span > 0 ? (x - xAt(lo)) / span : 0
    }
    const ys = model.boundaries.map((boundary) => {
        const a = drawing.py(boundary[lo] ?? 0)
        const b = drawing.py(boundary[hi] ?? 0)
        return a + u * (b - a)
    })
    const values = ys.map(toValue)
    const value = values[values.length - 1] ?? 0
    const raw = values.map((v, j) => v - (j ? (values[j - 1] ?? 0) : 0))
    return {
        value,
        parts: roundParts(raw, value),
        exact: false,
        y: ys[ys.length - 1] ?? drawing.py(0),
    }
}
