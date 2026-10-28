import assert from 'node:assert/strict'
import test from 'node:test'
import { createMapping } from '../../../src/editor/minimap/mapping'
import {
    HAIRLINE_MAX_RUN,
    HAIRLINE_MAX_RUNS,
    MIN_TICK_HEIGHT,
    TICK_WIDTH,
    hairlineRuns,
    tickRuns,
} from '../../../src/editor/minimap/tickRuns'
import { beatToTime, calculateBpms, type BpmIntegral } from '../../../src/state/integrals/bpms'

// 60 BPM up to beat 10 (10 s), then 120 BPM: beat 12 is at 11 s.
const bpms: BpmIntegral[] = calculateBpms([
    { x: 0, y: 0, s: 1 },
    { x: 10, y: 10, s: 0.5 },
])
const rowAt = (time: number, scale: number) => (17 + (400 - 21) * (1 - time / 100)) * scale

const runs = (times: number[], scale: number) => {
    const mapping = createMapping({ width: 40, height: 400, scale }, 100)
    const out: [number, number][] = []
    tickRuns(
        times.map((time) => ({ time })),
        mapping,
        (top, height) => out.push([top, height]),
    )
    return out
}

test('places within 2 device px share a tick, farther ones do not', () => {
    // One second is 3.92 CSS px here: 0.4 s is 1.57 px and 0.6 s is 2.35 px.
    assert.equal(runs([10, 10.4], 1).length, 1)
    assert.equal(runs([10, 10.6], 1).length, 2)
    // At 2x, 2 device px are 1 CSS px: 0.2 s is 0.78 px and 0.4 s is 1.57 px.
    assert.equal(runs([10, 10.2], 2).length, 1)
    assert.equal(runs([10, 10.4], 2).length, 2)
    // A chain of near places is one run, and a gap starts the next.
    assert.equal(runs([10, 10.3, 10.6, 10.9], 1).length, 1)
    assert.equal(runs([10, 10.6, 11.2, 11.8], 1).length, 4)
})

test('a run is at least 3 CSS px tall, centred on its places, and spans a long run', () => {
    const [single] = runs([50], 1)
    assert.ok(single)
    assert.equal(single[1], MIN_TICK_HEIGHT)
    assert.ok(Math.abs(single[0] + single[1] / 2 - rowAt(50, 1)) < 1e-9)

    const [long] = runs([20, 20.3, 20.6, 20.9, 21.2], 1)
    assert.ok(long)
    assert.ok(Math.abs(long[1] - (rowAt(20, 1) - rowAt(21.2, 1))) < 1e-9)
    assert.ok(Math.abs(long[0] - rowAt(21.2, 1)) < 1e-9)
})

test('rows follow the time on the tempo the places are in', () => {
    const mapping = createMapping({ width: 40, height: 400, scale: 1 }, 100)
    // Beat 12 is at 11 s; a flat 60 BPM would put it at 12 s.
    const out: [number, number][] = []
    tickRuns([{ time: beatToTime(bpms, 5) }, { time: beatToTime(bpms, 12) }], mapping, (top, h) =>
        out.push([top, h]),
    )
    assert.equal(out.length, 2)
    // Painted from the bottom of the strip up.
    assert.ok(Math.abs((out[0]?.[0] ?? 0) + MIN_TICK_HEIGHT / 2 - rowAt(5, 1)) < 1e-9)
    assert.ok(Math.abs((out[1]?.[0] ?? 0) + MIN_TICK_HEIGHT / 2 - rowAt(11, 1)) < 1e-9)
})

test('places beyond the range clamp to the top row', () => {
    const [run] = runs([250], 1)
    assert.ok(run)
    assert.ok(Math.abs(run[0] + run[1] / 2 - 17) < 1e-9)
})

test('3,400 places merge in one pass to at most one rect per run', () => {
    // A select-all move: each note's old and new places, over the whole chart.
    const times = Array.from({ length: 3400 }, (_, i) => (i / 3400) * 99)
    let calls = 0
    const mapping = createMapping({ width: 40, height: 400, scale: 2 }, 100)
    tickRuns(
        times.map((time) => ({ time })),
        mapping,
        () => calls++,
    )
    // 392 CSS px at 2x is 784 device rows, so at most that many rects.
    assert.ok(calls <= 784, `${calls} rects`)
    assert.ok(calls >= 1)
    // Dense places merge into a single stretch.
    assert.equal(runs(times, 2).length, 1)
})

test('the edge tick is 5 CSS px wide and at least 3 CSS px tall', () => {
    assert.equal(TICK_WIDTH, 5)
    assert.equal(MIN_TICK_HEIGHT, 3)
})

const run = (height: number) => ({ top: 10, height })

test('a few short runs get hairlines, and long stretches do not', () => {
    const runs = [run(3), run(HAIRLINE_MAX_RUN - 0.5), run(HAIRLINE_MAX_RUN), run(120)]
    assert.deepEqual(hairlineRuns(runs), [run(3), run(HAIRLINE_MAX_RUN - 0.5)])
})

test('a select-all move is one long stretch and gets no hairline', () => {
    const times = Array.from({ length: 3400 }, (_, i) => (i / 3400) * 99)
    const mapping = createMapping({ width: 40, height: 400, scale: 2 }, 100)
    const merged: { top: number; height: number }[] = []
    tickRuns(
        times.map((time) => ({ time })),
        mapping,
        (top, height) => merged.push({ top, height }),
    )
    assert.deepEqual(hairlineRuns(merged), [])
})

test('many short runs get no hairlines, so the strip does not haze', () => {
    const runs = Array.from({ length: HAIRLINE_MAX_RUNS }, () => run(3))
    assert.equal(hairlineRuns(runs).length, HAIRLINE_MAX_RUNS)
    assert.deepEqual(hairlineRuns([...runs, run(3)]), [])
})
