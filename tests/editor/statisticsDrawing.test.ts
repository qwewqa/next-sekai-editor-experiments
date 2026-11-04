import assert from 'node:assert/strict'
import test from 'node:test'
import { drawChart, drawHistogram, readAt, valueAt } from '../../src/editor/statistics/drawing'
import {
    chartModel,
    chartSource,
    chartView,
    mergeTimes,
    rollingDurations,
    yScale,
    type Durations,
    type Span,
} from '../../src/levelData/statistics'

// The chart at a plot's size: Bars' tiles on device pixels, the emitted paths, and the readout
// read from the same coordinates as the drawing.

const RATIOS = [1, 1.25, 1.5, 1.75, 2, 3]
const near = (value: number, target: number, tolerance = 1e-6) =>
    Math.abs(value - target) <= tolerance

// Two layers of taps: a dense passage, a lone note in a long silence, and a chord.
const layers = [
    Float64Array.from([0.2, 0.4, 0.45, 1.1, 1.3, 2.7, 3.05, 3.05, 3.05, 40]),
    Float64Array.from([0.3, 1.2, 2.9, 3.1, 7.25]),
]
const every = mergeTimes(layers).times

/** The points of an emitted "M x y L x y ..." path. */
const points = (path: string) =>
    path
        .slice(1)
        .split(' L')
        .map((pair) => pair.split(' ').map(Number) as [number, number])

test('Bars tiles lie on whole device pixels, with one gap rule and a pixel for every part', () => {
    for (const [width, end] of [
        [451.08, 40],
        [295.4, 900],
    ] as const) {
        const model = chartModel('bars', every, layers, end, 2)
        assert.ok(model?.bins)
        for (const dpr of RATIOS) {
            const drawing = drawChart(model, width, 136, dpr)
            const pitch = (drawing.px(model.bins.width) - drawing.px(0)) * dpr
            const gap = pitch >= 5 ? 1 : 0
            for (const tile of drawing.tiles) {
                for (const edge of [tile.x, tile.x + tile.width, tile.y, tile.y + tile.height])
                    assert.ok(near(edge * dpr, Math.round(edge * dpr)), `${dpr}: ${edge}`)
                // A nonzero part never rounds to nothing.
                assert.ok(tile.height * dpr >= 1 - 1e-9)
                assert.ok(tile.width * dpr >= 1 - 1e-9)
            }
            // Neighbouring bars are one gap apart, or touch.
            const bins = model.bins.bins
            bins.forEach((bin, k) => {
                const next = bins[k + 1]
                if (!bin.count || !next?.count) return
                const left = drawing.snap(drawing.px(bin.a))
                const tile = drawing.tiles.find((each) => near(each.x, left))
                assert.ok(tile)
                const nextLeft = drawing.snap(drawing.px(next.a))
                assert.ok(near(nextLeft - (tile.x + tile.width), gap / dpr), `${dpr}: bin ${k}`)
            })
            // Widths differ by at most one device pixel.
            const widths = drawing.tiles.map((tile) => Math.round(tile.width * dpr))
            assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `${dpr}: ${widths}`)
        }
    }
})

test('a lone tap in a wide bin beside a dense one still takes one device pixel', () => {
    // A thousand notes on one beat set the axis; the lone tap's part is under a device pixel.
    const times = Float64Array.from([...Array.from({ length: 1000 }, () => 10), 700])
    const model = chartModel('bars', times, [times], 1800, 2)
    assert.ok(model?.bins)
    assert.equal(model.bins.width, 15)
    for (const dpr of RATIOS) {
        const drawing = drawChart(model, 295, 136, dpr)
        const lone = drawing.tiles.find((tile) => near(tile.x, drawing.snap(drawing.px(690))))
        assert.ok(lone, `${dpr}`)
        assert.ok(near(lone.height * dpr, 1), `${dpr}: ${lone.height * dpr}`)
    }
})

test('the emitted Smooth line encloses the notes, and the readout sits on it', () => {
    for (const width of [295, 850]) {
        const model = chartModel('smooth', every, layers, undefined, Math.round(width * 2))
        assert.ok(model)
        const drawing = drawChart(model, width, 136, 1)
        const total = points(drawing.lines[drawing.lines.length - 1]!)
        // The area under the emitted line, in notes: x back to seconds, y back to notes a second.
        let area = 0
        for (let i = 1; i < total.length; i++) {
            const [x0, y0] = total[i - 1]!
            const [x1, y1] = total[i]!
            const seconds = ((x1 - x0) / width) * (model.x1 - model.x0)
            const value = (y: number) => (1 - y / drawing.height) * drawing.yTop
            area += (seconds * (value(y0) + value(y1))) / 2
        }
        assert.ok(Math.abs(area - every.length) < 0.005 * every.length, `${width}: ${area}`)
        // At every drawn point and halfway between, the dot is on the line and the parts add up.
        for (let i = 1; i < total.length; i++) {
            for (const u of [0, 0.5]) {
                const [xa, ya] = total[i - 1]!
                const [xb, yb] = total[i]!
                const x = xa + u * (xb - xa)
                const time = model.x0 + (x / width) * (model.x1 - model.x0)
                if (time < 0) continue
                const reading = readAt(model, drawing, time)
                assert.ok(Math.abs(reading.y - (ya + u * (yb - ya))) < 0.01, `${width} at ${time}`)
                const shown = Math.round(reading.value * 10) / 10
                const sum = reading.parts.reduce((a, b) => a + b, 0)
                assert.ok(near(sum, shown, 1e-9), `${width} at ${time}: ${sum} vs ${shown}`)
            }
        }
        // Each layer's top edge is the readout's parts added up from the bottom.
        const lower = points(drawing.lines[0]!)
        for (let i = 0; i < lower.length; i += 37) {
            const [x, y] = lower[i]!
            const time = model.x0 + (x / width) * (model.x1 - model.x0)
            if (time < 0 || time > model.x1) continue
            const reading = readAt(model, drawing, time)
            const raw = (1 - y / drawing.height) * drawing.yTop
            assert.ok(Math.abs(raw - (reading.parts[0] ?? 0)) <= 0.05 + 1e-9)
        }
    }
})

test('Bars reads its bin and Rolling its step, whole counts where the values are counts', () => {
    const bars = chartModel('bars', every, layers, undefined, 2)
    const rolling = chartModel('rolling', every, layers, undefined, 2)
    assert.ok(bars?.bins && rolling?.steps)
    const barsDrawing = drawChart(bars, 400, 136, 1)
    const rollingDrawing = drawChart(rolling, 400, 136, 1)
    for (const time of [0, 0.25, 1, 3.05, 3.5, 7.25, 39.9]) {
        const bar = readAt(bars, barsDrawing, time)
        const bin: Span = bars.bins.bins[Math.floor(time + 1e-9)]!
        assert.equal(bar.value, bin.count)
        assert.deepEqual(bar.parts, bin.parts)
        assert.deepEqual(bar.span, [bin.a, bin.b])
        assert.equal(bar.exact, true)
        const step = readAt(rolling, rollingDrawing, time)
        const index = Math.floor(
            ((time - rolling.x0) / (rolling.x1 - rolling.x0)) * rolling.steps.length,
        )
        assert.equal(step.value, rolling.steps[index]!.count)
        assert.equal(
            step.parts.reduce((a, b) => a + b, 0),
            step.value,
        )
    }
})

test('gridlines take whole device rows, at least one, at any ratio', () => {
    const model = chartModel('rolling', every, layers, undefined, 2)
    assert.ok(model)
    for (const dpr of RATIOS) {
        const drawing = drawChart(model, 300, 136, dpr)
        assert.ok(near(drawing.gridWidth * dpr, Math.max(1, Math.round(dpr))))
        for (const line of drawing.grid) {
            const top = line.y - drawing.gridWidth / 2
            assert.ok(near(top * dpr, Math.round(top * dpr)), `${dpr}: ${line.y}`)
        }
    }
})

// --- Over a view.

const longLayers = [
    Float64Array.from({ length: 120 }, (_, i) => i * 0.5 + (i % 3) * 0.05),
    Float64Array.from({ length: 30 }, (_, i) => 20 + i * 0.1),
]
const longSource = chartSource(mergeTimes(longLayers).times, longLayers)

test('the y axis reaches at least the floor it is given, and fits the view without one', () => {
    assert.ok(longSource)
    const model = chartView('rolling', longSource, 2, { x0: 40, x1: 55 }, 15)
    const fitted = drawChart(model, 300, 136, 1)
    const held = drawChart(model, 300, 136, 1, 4, 25)
    assert.ok(fitted.yTop < 25)
    assert.equal(held.yTop, 25)
    assert.equal(drawChart(model, 300, 136, 1, 4, 1).yTop, fitted.yTop)
})

test("Bars tiles are cut at the plot's edges", () => {
    assert.ok(longSource)
    const view = { x0: 20.4, x1: 30.6 }
    const model = chartView('bars', longSource, 2, view, 10)
    for (const dpr of RATIOS) {
        const drawing = drawChart(model, 301.3, 136, dpr)
        assert.ok(drawing.tiles.length > 0)
        for (const tile of drawing.tiles) {
            assert.ok(tile.x >= 0 && tile.x + tile.width <= drawing.snap(301.3) + 1e-9, `${dpr}`)
            assert.ok(tile.width > 0)
        }
        // The cut first bin starts at the plot's left edge.
        assert.ok(drawing.tiles.some((tile) => tile.x === 0))
    }
})

test('Rolling reads the step under a time when the steps start before the view', () => {
    assert.ok(longSource)
    const model = chartView('rolling', longSource, 2, { x0: 20.37, x1: 26.37 }, 6)
    const steps = model.steps
    assert.ok(steps)
    const first = steps[0]!
    assert.ok(first.a < 20.37)
    const drawing = drawChart(model, 300, 136, 1)
    for (const time of [20.37, 21, 23.333, 26.3]) {
        const reading = readAt(model, drawing, time)
        const step: Span | undefined = steps.find((each) => each.a <= time && time < each.b)
        assert.ok(step)
        assert.equal(reading.value, step.count, `${time}`)
    }
})

// --- The distribution.

/** The ys of an outline's vertical moves, one per count from 1. */
const stepTops = (path: string) =>
    [...path.matchAll(/ V(-?[\d.e-]+) H/g)].map((match) => Number(match[1]))

// Taps of a sparse and a dense passage, off any one-second grid, and a few traces among them.
const tapTimes = Float64Array.from(
    [
        ...Array.from({ length: 30 }, (_, i) => 1.013 + i * 0.71),
        ...Array.from({ length: 60 }, (_, i) => 30.017 + i * 0.083),
    ].sort((a, b) => a - b),
)
const traceTimes = Float64Array.from([2.31, 2.37, 31.05, 31.11, 31.17, 31.23])
const durations = (times: Float64Array) => {
    const result = rollingDurations(times)
    assert.ok(result)
    return result
}

test("each count's step stands at the input's seconds, at least 2 px where there are any, and the input adds up to the active time", () => {
    const all = mergeTimes([tapTimes, traceTimes]).times
    const series = [durations(tapTimes), durations(all)]
    // The seconds at each count, read from the input alone.
    const expected = series.map(({ values, ms }) => {
        const out = new Map<number, number>()
        values.forEach((value, k) => out.set(value, (ms[k] ?? 0) / 1000))
        return out
    })
    series.forEach((each, i) => {
        const sum = [...(expected[i]?.values() ?? [])].reduce((a, b) => a + b, 0)
        assert.ok(near(sum, each.active / 1000, 1e-9))
    })
    const largest = Math.max(...series.map((each) => each.values.at(-1) ?? 0))
    let tallest = 0
    for (const each of expected)
        for (const value of each.values()) tallest = Math.max(tallest, value)
    for (const dpr of RATIOS) {
        const drawn = drawHistogram(series, 412.3, 136, dpr)
        assert.equal(drawn.yTop, yScale(tallest).top)
        const py = (value: number) => (1 - value / drawn.yTop) * 136
        const baseline = py(0)
        series.forEach((each, i) => {
            const last = each.values.at(-1) ?? 0
            const tops = stepTops(drawn.lines[i] ?? '')
            assert.equal(tops.length, last)
            for (let value = 1; value <= last; value++) {
                const seconds = expected[i]?.get(value) ?? 0
                assert.ok(near(drawn.secondsAt(i, value), seconds, 1e-12), `${i} ${value}`)
                const top = seconds > 0 ? Math.min(py(seconds), baseline - 2) : baseline
                assert.ok(near(tops[value - 1] ?? NaN, top), `${i} ${value}`)
                assert.ok(near(drawn.topAt(i, value), top), `${i} ${value}`)
            }
        })
        // The axis ends half a step past the largest count of either series.
        assert.equal(drawn.max, largest)
        assert.ok(near(drawn.px(largest + 0.5), 412.3))
    }
})

test("one series has a wash and no fill; two have All's fill behind and no wash", () => {
    const one = drawHistogram([durations(tapTimes)], 300, 136, 1)
    assert.ok(one.wash.endsWith(' Z'))
    assert.equal(one.fill, '')
    const two = drawHistogram(
        [durations(tapTimes), durations(mergeTimes([tapTimes, traceTimes]).times)],
        300,
        136,
        1,
    )
    assert.equal(two.wash, '')
    assert.equal(two.fill, `${two.lines[1]} Z`)
})

const synthetic = (seconds: Record<number, number>): Durations => {
    const values = Int32Array.from(Object.keys(seconds).map(Number))
    const ms = Float64Array.from(values, (value) => (seconds[value] ?? 0) * 1000)
    return { values, ms, active: ms.reduce((a, b) => a + b, 0) }
}

test('the counts are labelled at 0 and multiples of 1, 2 or 5 x 10^k, within the budget', () => {
    const ticks = (max: number, budget: number) =>
        drawHistogram([synthetic({ 1: 10, [max]: 0.03 })], 300, 136, 1).xTicks(budget)
    assert.deepEqual(ticks(19, 6), [0, 5, 10, 15])
    assert.deepEqual(ticks(74, 6), [0, 20, 40, 60])
    assert.deepEqual(ticks(5, 6), [0, 1, 2, 3, 4, 5])
    assert.deepEqual(ticks(5, 4), [0, 2, 4])
    assert.deepEqual(ticks(108, 4), [0, 50, 100])
})

test('a sliver under a microsecond is not drawn and does not reach the axis', () => {
    const drawn = drawHistogram([synthetic({ 1: 5, 2: 2, 3: 1e-9 })], 300, 136, 1)
    assert.equal(drawn.max, 2)
    assert.equal(drawn.secondsAt(0, 3), 0)
    assert.equal(stepTops(drawn.lines[0] ?? '').length, 2)
})

test("the plot's fraction reads the nearest whole count, from 1 to the largest", () => {
    assert.equal(valueAt(0, 10), 1)
    assert.equal(valueAt(-0.2, 10), 1)
    assert.equal(valueAt(1, 10), 10)
    assert.equal(valueAt(1.3, 10), 10)
    // Count v is centred at v / (max + 0.5) of the width.
    for (let value = 1; value <= 10; value++) assert.equal(valueAt(value / 10.5, 10), value)
    assert.equal(valueAt(5.49 / 10.5, 10), 5)
    assert.equal(valueAt(5.51 / 10.5, 10), 6)
})
