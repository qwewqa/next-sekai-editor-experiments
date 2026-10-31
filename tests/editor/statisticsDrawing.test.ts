import assert from 'node:assert/strict'
import test from 'node:test'
import { drawChart, readAt } from '../../src/editor/statistics/drawing'
import { chartModel, mergeTimes, type Bin } from '../../src/levelData/statistics'

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
                const left = drawing.snapX(drawing.px(bin.a))
                const tile = drawing.tiles.find((each) => near(each.x, left))
                assert.ok(tile)
                const nextLeft = drawing.snapX(drawing.px(next.a))
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
        const lone = drawing.tiles.find((tile) => near(tile.x, drawing.snapX(drawing.px(690))))
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
        const bin: Bin = bars.bins.bins[Math.floor(time + 1e-9)]!
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
