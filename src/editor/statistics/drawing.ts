import {
    binAt,
    roundParts,
    yScale,
    type ChartModel,
    type Durations,
} from '../../levelData/statistics'
import { formatCount } from '../../utils/size'

// The chart at a plot's size: the coordinates of its layers, Bars' tiles and the gridlines, and
// the readout read from the same coordinates, so the dot and the values sit on the drawn edges.

export type Tile = { x: number; y: number; width: number; height: number; layer: number }

export type Drawing = {
    width: number
    height: number
    yTop: number
    /** Plot x of a time. */
    px: (time: number) => number
    /** Plot y of a value. */
    py: (value: number) => number
    /** Each boundary as a path, bottom first; the last is the total. */
    lines: string[]
    /** Each layer's area, bottom first. */
    areas: string[]
    /** The area under the total, for an ink wash. */
    wash: string
    tiles: Tile[]
    /** Gridlines' y and their thickness in CSS px. */
    grid: { y: number; value: number }[]
    gridWidth: number
    /** A whole number of device pixels from the plot's own origin. */
    snap: (value: number) => number
}

/** A y-axis label: a whole number in the locale. */
export const yLabel = (value: number, locale: string) => formatCount(value, locale)

/**
 * A time label's alignment at plot x `x`: centred, or by its start near the plot's left edge and by
 * its end near the right edge, so it stays within the plot.
 */
export const timeLabelAlign = (x: number, width: number) =>
    x > width - 20 ? 'right' : x < 20 ? 'left' : 'center'

/** Gridlines at each step up to `top`, on whole device rows, the nearest to 1 CSS px thick. */
export const gridLines = (top: number, step: number, height: number, dpr: number) => {
    const snap = (value: number) => Math.round(value * dpr) / dpr
    const gridWidth = Math.max(1, Math.round(dpr)) / dpr
    const grid: { y: number; value: number }[] = []
    for (let k = 0; k * step <= top * (1 + 1e-9); k++)
        grid.push({
            y:
                Math.min(snap((1 - (k * step) / top) * height), snap(height) - gridWidth) +
                gridWidth / 2,
            value: k * step,
        })
    return { grid, gridWidth }
}

/**
 * Draws a model in a plot of `width` x `height` CSS px at `dpr` device pixels per CSS px, edges
 * snapped to whole device pixels from the plot's origin. The y axis reaches at least `floor`.
 */
export const drawChart = (
    model: ChartModel,
    width: number,
    height: number,
    dpr: number,
    yTicks = 4,
    floor = 0,
): Drawing => {
    const total = model.boundaries[model.boundaries.length - 1] ?? new Float64Array()
    let top = floor
    for (const value of total) top = Math.max(top, value)
    const { step: yStep, top: yTop } = yScale(top || 1, yTicks)
    const span = model.x1 - model.x0
    const px = (time: number) => ((time - model.x0) / span) * width
    const py = (value: number) => (1 - value / yTop) * height
    const snap = (value: number) => Math.round(value * dpr) / dpr
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
    const wash = `M${xs[0] ?? 0} ${baseline} L${lines[lines.length - 1]?.slice(1) ?? ''} L${xs[xs.length - 1] ?? 0} ${baseline} Z`

    // Bars: tiles on device pixels, cut at the plot's edges; a one-device-pixel gap between bars
    // from a pitch of 5 device pixels; a nonzero part that would round to nothing takes one device
    // pixel.
    const tiles: Tile[] = []
    const bins = model.bins
    if (bins) {
        const pitch = (px(bins.width) - px(0)) * dpr
        const gap = pitch >= 5 ? 1 / dpr : 0
        for (const bin of bins.bins) {
            if (!bin.count) continue
            const left = Math.max(0, snap(px(bin.a)))
            const right = Math.min(snap(width), snap(px(bin.b)) - gap)
            if (right <= left) continue
            let below = 0
            let base = snap(py(0))
            bin.parts.forEach((count, layer) => {
                if (!count) return
                let y = snap(py((below + count) / bins.width))
                if (y >= base - 1e-9) y = base - 1 / dpr
                tiles.push({ x: left, y, width: right - left, height: base - y, layer })
                below += count
                base = Math.min(base, y)
            })
        }
    }

    const { grid, gridWidth } = gridLines(yTop, yStep, height, dpr)

    return {
        width,
        height,
        yTop,
        px,
        py,
        lines,
        areas,
        wash,
        tiles,
        grid,
        gridWidth,
        snap,
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
        const first = steps[0]
        let index = first ? Math.floor((time - first.a) / (first.b - first.a)) : 0
        index = Math.min(steps.length - 1, Math.max(0, index))
        // Steps from their own indices can differ from the first's width in the last bit.
        while (index > 0 && time < (steps[index]?.a ?? 0)) index--
        while (index < steps.length - 1 && time >= (steps[index]?.b ?? 0)) index++
        const step = steps[index]
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

// --- The distribution: one step per whole count, x the count, y the seconds at it.

// The sweep's margin can leave slivers of a nanosecond beside notes exactly 1 s apart.
const SLIVER_MS = 1e-3
const UNITS = [1, 2, 5]

export type Histogram = {
    width: number
    height: number
    /** The largest count with time in any series: the x axis runs to max + 0.5. */
    max: number
    yTop: number
    px: (value: number) => number
    py: (seconds: number) => number
    grid: { y: number; value: number }[]
    gridWidth: number
    /** Each series' outline: up and along every count from 1 to its own largest, then down. */
    lines: string[]
    /** The first outline closed, for the wash, with one series. */
    wash: string
    /** The last outline closed, the fill behind, with two. */
    fill: string
    /** 0 and multiples of the step of 1, 2 or 5 x 10^k that keeps at most `budget` labels. */
    xTicks: (budget: number) => number[]
    /** Series i's seconds at a count. */
    secondsAt: (i: number, value: number) => number
    /** The y of series i's step at a count, as drawn. */
    topAt: (i: number, value: number) => number
}

/**
 * Draws each series' seconds at each count in a plot of `width` x `height` CSS px. A count with
 * any time stands at least 2 px, so the reach of a short burst shows.
 */
export const drawHistogram = (
    series: readonly Durations[],
    width: number,
    height: number,
    dpr: number,
    yTicks = 4,
): Histogram => {
    const seconds = series.map(({ values, ms }) => {
        const out = new Float64Array((values[values.length - 1] ?? 0) + 1)
        values.forEach((value, i) => {
            const each = ms[i] ?? 0
            if (each >= SLIVER_MS) out[value] = each / 1000
        })
        return out
    })
    const tops = seconds.map((out) => {
        for (let value = out.length - 1; value > 0; value--) if (out[value]) return value
        return 0
    })
    const max = Math.max(1, ...tops)
    let tallest = 0
    for (const out of seconds) for (const value of out) tallest = Math.max(tallest, value)
    const { step, top: yTop } = yScale(tallest || 1, yTicks)
    const px = (value: number) => (value / (max + 0.5)) * width
    const py = (value: number) => (1 - value / yTop) * height
    const baseline = py(0)
    const secondsAt = (i: number, value: number) => seconds[i]?.[value] ?? 0
    const topAt = (i: number, value: number) => {
        const time = secondsAt(i, value)
        return time > 0 ? Math.min(py(time), baseline - 2) : baseline
    }
    const lines = tops.map((last, i) => {
        let d = `M${px(0.5)} ${baseline}`
        for (let value = 1; value <= last; value++) d += ` V${topAt(i, value)} H${px(value + 0.5)}`
        return `${d} V${baseline}`
    })
    const xTicks = (budget: number) => {
        let tick = 1
        for (let k = 1; Math.floor(max / tick) + 1 > budget; k++)
            tick = (UNITS[k % 3] ?? 1) * 10 ** Math.floor(k / 3)
        const out: number[] = []
        for (let value = 0; value <= max; value += tick) out.push(value)
        return out
    }
    return {
        width,
        height,
        max,
        yTop,
        px,
        py,
        ...gridLines(yTop, step, height, dpr),
        lines,
        wash: series.length === 1 ? `${lines[0] ?? ''} Z` : '',
        fill: series.length > 1 ? `${lines[lines.length - 1] ?? ''} Z` : '',
        xTicks,
        secondsAt,
        topAt,
    }
}

/** The whole count from 1 to `max` nearest a fraction of the plot's width. */
export const valueAt = (fraction: number, max: number) =>
    Math.min(max, Math.max(1, Math.round(fraction * (max + 0.5))))
