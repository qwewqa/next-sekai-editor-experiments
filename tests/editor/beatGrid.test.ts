import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { calculateBpms, type GridBpm } from '../../src/state/integrals/bpms'
import {
    ceilGridBeat,
    floorGridBeat,
    GLOBAL_GRID,
    gridLines,
    isGlobalGrid,
    nearGridBeat,
    nearGridsBeat,
    snapBeat,
    snapPhasedBeat,
    stepGridBeat,
    toBeatGrid,
} from '../../src/state/integrals/grid'
import { align, alignNear } from '../../src/utils/math'

const chart = (...changes: [number, number?][]) =>
    calculateBpms(changes.map(([x, meter = 4]) => ({ x, y: 0, s: 0.5, meter })))
const grid = (...changes: [number, number?][]) => toBeatGrid(chart(...changes))

// Seeded, so failures reproduce.
const random = (() => {
    let seed = 0x9e3779b9
    return () => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
})()
const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T
const nextUp = (value: number) => {
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat64(0, value)
    view.setBigInt64(0, view.getBigInt64(0) + (value >= 0 ? 1n : -1n))
    return view.getFloat64(0)
}
const nextDown = (value: number) => {
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat64(0, value)
    view.setBigInt64(0, view.getBigInt64(0) + (value > 0 ? -1n : 1n))
    return view.getFloat64(0)
}

// The definition, brute force: every bar's lines, with a tiny meter's segment as one interval.
const oracleLines = (bpms: GridBpm[], division: number, max: number) => {
    const epsilon = 1e-6 / division
    const lines: number[] = []
    const first = bpms[0]?.x ?? Number.POSITIVE_INFINITY
    for (let k = -30 * division; k / division < first - epsilon; k++) lines.push(k / division)
    for (let i = 0; i < bpms.length; i++) {
        const { x, meter } = bpms[i] as GridBpm
        const next = bpms[i + 1]?.x ?? Number.POSITIVE_INFINITY
        const intervals: { s: number; e: number }[] = []
        if (meter < 2e-6) intervals.push({ s: x, e: next })
        else
            for (let k = 0; ; k++) {
                const s = x + k * meter
                if (s >= next || s > max) break
                intervals.push({ s, e: Math.min(x + (k + 1) * meter, next) })
            }
        for (const { s, e } of intervals) {
            if (!(e - s >= epsilon)) continue
            if (Math.abs(s * division - Math.round(s * division)) < 1e-6) {
                for (let k = Math.round(s * division); k / division < e - epsilon; k++) {
                    if (k / division > max + 2) break
                    lines.push(k / division)
                }
            } else {
                for (let n = 0; s + n / division < e - epsilon; n++) {
                    if (s + n / division > max + 2) break
                    lines.push(s + n / division)
                }
            }
        }
    }
    return lines
}
const oracleNearest = (lines: number[], beat: number) => {
    let best = Number.NaN
    for (const line of lines) {
        const distance = Math.abs(line - beat)
        if (
            Number.isNaN(best) ||
            distance < Math.abs(best - beat) ||
            (distance === Math.abs(best - beat) && line > best)
        )
            best = line
    }
    return best
}

const divisions = [1, 2, 3, 4, 6, 8, 12, 16] as const
const meters = [4, 3, 3.5, 1, 2.25, 7 / 3] as const

// Charts with off-grid, noisy, duplicate and sliver changes.
const adversarialChart = (division: number) => {
    const changes: [number, number][] = [[0, pick(meters)]]
    let x = 0
    for (let i = 0; i < 6; i++) {
        const r = random()
        x +=
            r < 0.2
                ? 0
                : r < 0.35
                  ? random() * 3e-7
                  : r < 0.6
                    ? Math.round(random() * 20 * division) / division
                    : random() * 10
        if (random() < 0.2) x += (random() < 0.5 ? 1 : -1) * 4e-15
        changes.push([Math.max(0, x), pick(meters)])
    }
    return chart(...changes)
}

// Charts whose every change sits on the division's grid, some with float noise.
const onGridChart = (division: number) => {
    const changes: [number, number][] = [[0, 1 + Math.floor(random() * 5)]]
    let x = 0
    for (let i = 0; i < 4; i++) {
        x += Math.floor(random() * 30 + 1) / division
        changes.push([
            random() < 0.3 ? x * (1 + (random() - 0.5) * 1e-15) : x,
            1 + Math.floor(random() * 5),
        ])
    }
    return chart(...changes)
}

test('worked examples snap to the nearest line of each bar, ties to the later line', () => {
    const offGrid = grid([0], [2.5])
    assert.equal(snapBeat(offGrid, 2.2, 1), 2)
    assert.equal(snapBeat(offGrid, 2.25, 1), 2.5)
    assert.equal(snapBeat(offGrid, 2.3, 1), 2.5)
    assert.equal(snapBeat(offGrid, 3, 1), 3.5)
    assert.equal(snapBeat(offGrid, 3.2, 1), 3.5)
    const close = grid([0], [2.5], [2.6])
    assert.equal(snapBeat(close, 2.54, 1), 2.5)
    assert.equal(snapBeat(close, 2.58, 1), 2.6)
    // On the half-beat grid, 2.5 is a line already.
    assert.equal(snapBeat(offGrid, 2.3, 2), 2.5)
    assert.ok(Object.is(snapBeat(offGrid, 3.2, 2), align(3.2, 2)))
    const fractional = grid([0, 3.5])
    assert.equal(snapBeat(fractional, 3.3, 1), 3.5)
    assert.equal(snapBeat(fractional, 3.6, 1), 3.5)
    assert.equal(snapBeat(fractional, 6.8, 1), 7)
    assert.deepEqual(
        gridLines(fractional, 0, 11, 1, 101)?.map(({ beat }) => beat),
        [0, 1, 2, 3, 3.5, 4.5, 5.5, 6.5, 7, 8, 9, 10, 10.5],
    )
    assert.equal(snapBeat(grid([0], [6]), 5.5, 1), 6)
    // Below beat 0 the grid is global.
    assert.equal(snapBeat(offGrid, -1.2, 1), -1)
})

test('empty bars, duplicates, slivers and noisy bars are skipped to the real neighbours', () => {
    // The earlier duplicate's bar is empty; the later one governs.
    const duplicates = grid([0], [2.5, 3], [2.5, 4])
    assert.equal(snapBeat(duplicates, 2.3, 1), 2.5)
    assert.equal(snapBeat(duplicates, 2.4, 1), 2.5)
    assert.equal(snapBeat(duplicates, 6.4, 1), 6.5)
    // A change just past a bar: the sliver holds no line.
    const noisy = grid([0], [nextUp(32)])
    for (const beat of [31.5, 31.9, 32.3])
        assert.ok(Object.is(snapBeat(noisy, beat, 1), align(beat, 1)))
    const chain = grid([0], [2.5], [2.5000001], [2.5000002])
    assert.equal(snapBeat(chain, 2.3, 1), 2.5000002)
    // A bar rounded onto the next change belongs to it.
    const rounded = grid([0], [31.999999999999996])
    for (const beat of [31.999999999999993, 31.6, 32.2])
        assert.ok(Object.is(snapBeat(rounded, beat, 1), align(beat, 1)))
})

test('the global grid, and charts with every bar on the grid, snap exactly as align and alignNear', () => {
    let checked = 0
    for (let t = 0; t < 1500; t++) {
        const division = pick([...divisions, 5, 7])
        const bpms = onGridChart(division)
        const phased = toBeatGrid(bpms)
        for (let j = 0; j < 30; j++) {
            const k = 1 + Math.floor(random() * 120 * division)
            let beat = j % 2 ? (k + 0.5) / division : k / division
            for (let u = 0; u < 4; u++) beat = nextDown(beat)
            for (let u = 0; u < 9; u++) {
                for (const g of [GLOBAL_GRID, phased]) {
                    assert.ok(Object.is(snapBeat(g, beat, division), align(beat, division)))
                    assert.ok(Object.is(nearGridBeat(g, beat, division), alignNear(beat, division)))
                }
                // The general path agrees with the fast path wherever the fast path applies.
                if (isGlobalGrid(phased, division)) {
                    assert.ok(
                        Object.is(snapPhasedBeat(bpms, beat, division), align(beat, division)),
                    )
                    checked++
                }
                beat = nextUp(beat)
            }
        }
    }
    assert.ok(checked > 100_000)
})

test('the fast path only applies where every bar starts on the grid', () => {
    assert.equal(isGlobalGrid(grid([0], [2.5]), 1), false)
    assert.equal(isGlobalGrid(grid([0], [2.5]), 2), true)
    assert.equal(isGlobalGrid(grid([0, 3.5]), 1), false)
    assert.equal(isGlobalGrid(grid([0, 3.5]), 2), true)
    assert.equal(isGlobalGrid(grid([0], [2.125, 3]), 4), false)
    assert.equal(isGlobalGrid(grid([0], [31.999999999999996]), 1), true)
    // Noise within the tolerance, but bars drifting past it, fall to the general path.
    assert.equal(isGlobalGrid(grid([0, 4 + 1e-9], [100000]), 1), false)
    assert.equal(isGlobalGrid(grid([0, 4 + 1e-12], [10]), 1), true)
    // With fractional meters of whole steps and near-noise starts, the general path agrees.
    for (let t = 0; t < 400; t++) {
        const division = pick(divisions)
        const changes: [number, number][] = [[0, pick([4, 3, 3.5, 2.25, 1.5])]]
        let x = 0
        for (let i = 0; i < 4; i++) {
            x += Math.floor(random() * 20 + 1) / division + ((random() - 0.5) * 1e-6) / division
            changes.push([x, pick([4, 3, 3.5, 2.25, 1.5, 7 / 3])])
        }
        const bpms = chart(...changes)
        if (!isGlobalGrid(toBeatGrid(bpms), division)) continue
        for (let j = 0; j < 60; j++) {
            const beat = random() * 120
            assert.ok(Object.is(snapPhasedBeat(bpms, beat, division), align(beat, division)))
        }
    }
})

test('snapping is the nearest line, monotonic and idempotent on adversarial charts', () => {
    for (let t = 0; t < 2000; t++) {
        const division = pick(divisions)
        const bpms = adversarialChart(division)
        const g = toBeatGrid(bpms)
        const lines = oracleLines(bpms, division, 90)
        const lineSet = new Set(lines)
        const beats: number[] = []
        for (let j = 0; j < 40; j++) {
            let beat = random() * 80
            if (j % 3 === 0)
                beat = (bpms[1 + (j % (bpms.length - 1))] as GridBpm).x + (random() - 0.5) * 1e-6
            if (j % 5 === 0) {
                const index = Math.floor(random() * (lines.length - 1))
                beat = ((lines[index] as number) + (lines[index + 1] as number)) / 2
            }
            beats.push(beat)
        }
        for (const beat of beats) {
            const snapped = snapBeat(g, beat, division)
            const nearest = oracleNearest(lines, beat)
            assert.ok(
                Math.abs(snapped - beat) <=
                    Math.abs(nearest - beat) + 1e-12 * Math.max(1, Math.abs(beat)),
                `${JSON.stringify(bpms.map(({ x, meter }) => [x, meter]))} d=${division} ${beat}: ${snapped} vs ${nearest}`,
            )
            assert.ok(
                lineSet.has(snapped),
                `${JSON.stringify(bpms.map(({ x, meter }) => [x, meter]))} d=${division} ${beat}: ${snapped} is a line`,
            )
            assert.ok(
                snapBeat(g, snapped, division) === snapped,
                `${JSON.stringify(bpms.map(({ x, meter }) => [x, meter]))} d=${division} ${beat}: ${snapped} -> ${snapBeat(g, snapped, division)}`,
            )
        }
        beats.sort((a, b) => a - b)
        let previous = Number.NEGATIVE_INFINITY
        for (const beat of beats) {
            const snapped = snapBeat(g, beat, division)
            assert.ok(snapped >= previous)
            previous = snapped
        }
    }
})

test('every change is a line, bitwise when off the grid', () => {
    for (let t = 0; t < 1000; t++) {
        const division = pick(divisions)
        const bpms = adversarialChart(division)
        const g = toBeatGrid(bpms)
        for (const { x } of bpms) {
            // Unless later changes within the tolerance take its place.
            if (bpms.some((other) => other.x > x && other.x - x < 1e-5 / division)) continue
            const snapped = snapBeat(g, x, division)
            if (Math.abs(x * division - Math.round(x * division)) >= 1e-6)
                assert.ok(Object.is(snapped, x))
            else assert.ok(Math.abs(snapped - x) * division < 1e-6)
        }
    }
})

test('absolute moves land on lines and never against the pointer; relative moves keep the phase', () => {
    for (let t = 0; t < 1500; t++) {
        const division = pick(divisions)
        const bpms = adversarialChart(division)
        const g = toBeatGrid(bpms)
        const lines = new Set(oracleLines(bpms, division, 120))
        for (let j = 0; j < 20; j++) {
            const anchor = snapBeat(g, random() * 60, division)
            const delta = (random() - 0.5) * 20
            if (Math.abs(delta) * division < 0.5) continue
            const offset = snapBeat(g, anchor + delta, division) - anchor
            const result = offset === 0 ? anchor : nearGridBeat(g, anchor + offset, division)
            const label = `${JSON.stringify(bpms.map(({ x, meter }) => [x, meter]))} d=${division} ${anchor}+${delta}: ${result}`
            assert.ok(lines.has(result), label)
            assert.ok((result - anchor) * delta >= -1e-6 * Math.abs(delta), label)
        }
    }
    // Inside one off-grid bar, a relative move lands exactly on its line.
    for (let t = 0; t < 1000; t++) {
        const division = pick([1, 2, 3, 4, 6, 8])
        const start = random() * 10 + 0.0123
        const g = grid([0], [start, 400])
        const n = Math.floor(random() * 40 * division)
        const m = Math.floor(random() * 40 * division) - n
        const anchor = start + n / division
        if (!Object.is(snapBeat(g, anchor, division), anchor)) continue
        const offset = align(m / division + ((random() - 0.5) * 0.4) / division, division)
        if (offset === 0) continue
        assert.ok(Object.is(nearGridBeat(g, anchor + offset, division), start + (n + m) / division))
    }
})

test('values off the bar grid fall back to alignNear, keeping same-beat pairs on old content', () => {
    const g = grid([0], [135.5])
    // An old note at 409/3 and one moved there relatively by a third.
    const moved = 136 + 1 / 3
    assert.ok(Object.is(nearGridBeat(g, moved, 3), alignNear(moved, 3)))
    assert.ok(Object.is(nearGridBeat(g, 409 / 3, 3), nearGridBeat(g, moved, 3)))
    assert.equal(nearGridBeat(g, 136.4999999, 1), 136.5)
    assert.equal(nearGridBeat(g, 137.4999999, 1), 137.5)
    assert.equal(nearGridBeat(g, 137.2, 1), 137.2)
})

test('ceil, floor and steps find adjacent lines without walking', () => {
    for (let t = 0; t < 1500; t++) {
        const division = pick(divisions)
        const bpms = adversarialChart(division)
        const g = toBeatGrid(bpms)
        const lines = oracleLines(bpms, division, 90)
        for (let j = 0; j < 20; j++) {
            const beat = random() * 80
            const ceil = lines.find((line) => line >= beat)
            const floor = lines.filter((line) => line <= beat).at(-1)
            const label = `${JSON.stringify(bpms.map(({ x, meter }) => [x, meter]))} d=${division} ${beat}`
            assert.ok(Object.is(ceilGridBeat(g, beat, division), ceil), `${label} ceil`)
            assert.ok(Object.is(floorGridBeat(g, beat, division), floor), `${label} floor`)
            const line = snapBeat(g, beat, division)
            const index = lines.indexOf(line)
            if (index > 0) {
                assert.ok(
                    Object.is(stepGridBeat(g, line, division, 1), lines[index + 1]),
                    `${label} next ${line}`,
                )
                assert.ok(
                    Object.is(stepGridBeat(g, line, division, -1), lines[index - 1]),
                    `${label} previous ${line}`,
                )
            }
        }
    }
    const g = grid([0], [2.5])
    assert.equal(stepGridBeat(g, 2, 1, 1), 2.5)
    assert.equal(stepGridBeat(g, 2.5, 1, 1), 3.5)
    assert.equal(stepGridBeat(g, 3.5, 1, -1), 2.5)
    assert.equal(stepGridBeat(g, 2.5, 1, -1), 2)
    // Off the grid, one step relatively.
    assert.equal(stepGridBeat(g, 3.2, 1, 1), 4.2)
    // On the global grid, as before: one step, de-noised.
    for (const beat of [0, 0.25, 1 / 3, 7.75])
        for (const direction of [1, -1] as const)
            assert.ok(
                Object.is(
                    stepGridBeat(GLOBAL_GRID, beat, 4, direction),
                    alignNear(beat + direction / 4, 4),
                ),
            )
})

test('grid lines match the definition, with beat lines a whole beat from their bar', () => {
    for (let t = 0; t < 800; t++) {
        const division = pick(divisions)
        const bpms = adversarialChart(division)
        const g = toBeatGrid(bpms)
        const min = random() * 40
        const max = min + random() * 30
        const expected = oracleLines(bpms, division, max + 5).filter(
            (line) => line >= min && line <= max,
        )
        const lines = gridLines(g, min, max, division, 100_000)
        assert.deepEqual(
            lines?.map(({ beat }) => beat),
            expected,
        )
        // Beat lines are the bar grid's lines at one step per beat.
        const beats = new Set(oracleLines(bpms, 1, max + 5))
        for (const line of lines ?? [])
            if (line.isBeat)
                assert.ok(
                    [...beats].some((beat) => Math.abs(beat - line.beat) < 1e-6),
                    `${JSON.stringify(bpms.map(({ x, meter }) => [x, meter]))} d=${division} ${line.beat}`,
                )
    }
    const halves = gridLines(grid([0], [2.5]), 2, 4.5, 2, 101)
    assert.deepEqual(halves, [
        { beat: 2, isBeat: true },
        { beat: 2.5, isBeat: true },
        { beat: 3, isBeat: false },
        { beat: 3.5, isBeat: true },
        { beat: 4, isBeat: false },
        { beat: 4.5, isBeat: true },
    ])
    // The global grid: as the drawn grid was, with its limit.
    assert.deepEqual(
        gridLines(GLOBAL_GRID, 0.1, 1, 4, 101)?.map(({ beat }) => beat),
        [0.25, 0.5, 0.75, 1],
    )
    assert.equal(gridLines(GLOBAL_GRID, 0, 25.25, 4, 101), undefined)
    assert.equal(gridLines(GLOBAL_GRID, 0, 25, 4, 101)?.length, 101)
})

test('tiny meters stay bounded', { timeout: 5000 }, () => {
    for (const meter of [1e-8, 1e-12, 1.9e-6]) {
        const g = grid([0], [2.5, meter], [100.25])
        assert.equal(snapBeat(g, 50.3, 1), 50.5)
        assert.equal(snapBeat(g, 2.4, 1), 2.5)
        assert.equal(ceilGridBeat(g, 50.6, 1), 51.5)
        assert.equal(gridLines(g, 0, 200, 4, 2000)?.length, 801)
    }
    // A small meter above it: every bar is a line; seeking stays arithmetic.
    const small = grid([0], [2.5, 1e-5])
    const ceil = ceilGridBeat(small, 1000.000001, 1)
    assert.ok(ceil >= 1000.000001 && ceil - 1000.000001 < 1e-5)
    assert.equal(gridLines(small, 0, 1000, 1, 2000), undefined)
    const last = grid([0, 1e-8])
    assert.equal(snapBeat(last, 7.4, 1), 7)
})

test('moved beats pair with content on the chart bars in the Beat display', () => {
    const bars = grid([0], [2.5])
    const partner = snapBeat(bars, 2.5 + 2 / 3, 3)
    assert.ok(Object.is(partner, 2.5 + 2 / 3))
    // Placed in Measure at 2.5 + 1/3, moved by a third, one step at a time.
    const moved = snapBeat(bars, 2.5 + 1 / 3, 3) + 1 / 3
    assert.notEqual(moved, partner)
    // The Beat display's global grid, then the bars.
    assert.ok(Object.is(nearGridsBeat([GLOBAL_GRID, bars], moved, 3), partner))
    // Off both, as alignNear.
    assert.ok(Object.is(nearGridsBeat([GLOBAL_GRID, bars], 3.2, 3), 3.2))
})

test('global content moves in the Beat display exactly as before', () => {
    for (let t = 0; t < 500; t++) {
        const division = pick(divisions)
        // Changes well off the global grid.
        const changes: [number, number][] = [[0, 4]]
        for (let i = 0; i < 4; i++)
            changes.push([Math.round(random() * 1000) / 100 + 0.003, pick(meters)])
        changes.sort((a, b) => a[0] - b[0])
        const bars = grid(...changes)
        for (let j = 0; j < 50; j++) {
            const beat = Math.floor(random() * 40 * division) / division
            const offset = (Math.floor(random() * 20 * division) - 10 * division) / division
            const moved = beat + offset
            assert.ok(
                Object.is(
                    nearGridsBeat([GLOBAL_GRID, bars], moved, division),
                    alignNear(moved, division),
                ),
            )
        }
    }
})

test('moved beats in Measure clean against the bars once, as nearGridBeat', () => {
    for (let t = 0; t < 200; t++) {
        const division = pick(divisions)
        const changes: [number, number][] = [[0, 4]]
        for (let i = 0; i < 4; i++)
            changes.push([Math.round(random() * 1000) / 100 + 0.003, pick(meters)])
        changes.sort((a, b) => a[0] - b[0])
        const bars = grid(...changes)
        for (let j = 0; j < 50; j++) {
            const line = snapBeat(bars, random() * 40, division)
            const moved = line + (Math.floor(random() * 20) - 10) / division
            for (const beat of [moved, moved + 1e-9, moved + 0.3 / division])
                assert.ok(
                    Object.is(
                        nearGridsBeat([bars, bars], beat, division),
                        nearGridBeat(bars, beat, division),
                    ),
                )
        }
    }
})

test('grid lines are drawn once at the tolerance and up to the top edge', () => {
    const lines = gridLines(grid([0], [17.571428714285712, 6]), 40, 43, 7, 1000)!.map(
        ({ beat }) => beat,
    )
    assert.equal(new Set(lines).size, lines.length)
    const edge = grid([0], [25.00000006491687, 0.37])
    assert.equal(snapBeat(edge, 62, 8), 62)
    assert.ok(gridLines(edge, 61.9, 62.00000006491686, 8, 1000)!.some(({ beat }) => beat === 62))
})

test('beats past 2^32 grid steps snap, step and draw promptly, with no lines between them', () => {
    // Run apart, so a hang fails the test instead of stalling the run.
    const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href)
    const script = `
        import { drawGrid, gridLabels } from ${url('../../src/editor/canvas/grid.ts')}
        import { createState } from ${url('../../src/state/index.ts')}
        import { beatToTime } from ${url('../../src/state/integrals/bpms.ts')}
        import * as g from ${url('../../src/state/integrals/grid.ts')}
        import { align, alignNear } from ${url('../../src/utils/math.ts')}
        const state = createState({
            initialLife: 1000,
            isDynamicStages: false,
            bpms: [{ beat: 0, bpm: 120 }, { beat: 2.3, bpm: 150 }, { beat: 7.1, bpm: 90 }],
            groups: new Map(),
            stages: new Map(),
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [],
            slides: [],
        }, 0)
        const bars = g.toBeatGrid(state.bpms)
        const ctx = new Proxy({}, { get: (target, key) => key in target ? target[key] : () => ({ width: 0 }) })
        const bounds = { l: -10, r: 10, t: -100, b: 0, w: 20, h: 100 }
        const checks = []
        for (const division of [1, 4, 16, 1e9])
            for (const beat of [1e9, 4.5e15, 2 ** 53, -(2 ** 53)]) {
                if (g.isWithinGridSteps(beat, division)) continue
                for (const grid of [bars, g.GLOBAL_GRID]) {
                    checks.push(Object.is(g.ceilGridBeat(grid, beat, division), beat))
                    checks.push(Object.is(g.floorGridBeat(grid, beat, division), beat))
                    for (const direction of [1, -1])
                        checks.push(Number.isFinite(g.stepGridBeat(grid, beat, division, direction)))
                    checks.push(g.gridLines(grid, beat, beat + 10, division, 2000)?.length === 0)
                }
                checks.push(Object.is(g.snapPhasedBeat(state.bpms, beat, division), beat))
                checks.push(Object.is(g.nearGridBeat(bars, beat, division), beat))
                checks.push(Object.is(g.snapBeat(bars, beat, division), beat))
                // The global grid's arithmetic is unchanged.
                checks.push(Object.is(g.snapBeat(g.GLOBAL_GRID, beat, division), align(beat, division)))
                checks.push(Object.is(g.nearGridBeat(g.GLOBAL_GRID, beat, division), alignNear(beat, division)))
                if (beat < 0) continue
                const beats = { min: beat, max: beat + 10 }
                const times = { min: beatToTime(state.bpms, beat), max: beatToTime(state.bpms, beat + 10) }
                for (const display of ['beat', 'measure']) {
                    const labels = gridLabels(state, -10, 10, beats, times, display).right
                    // Labels go by whole beats.
                    checks.push(g.isWithinGridSteps(beat, 1) ? labels.length > 0 : labels.length === 0)
                    drawGrid({ ctx, scale: 10, pixelRatio: 2, bounds, ups: -10, state }, beats, times, division, 1, display)
                }
            }
        console.log(JSON.stringify(checks))
    `
    const run = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        { encoding: 'utf8', timeout: 20_000 },
    )
    assert.equal(run.signal, null, 'timed out')
    assert.equal(run.status, 0, run.stderr)
    const checks = JSON.parse(run.stdout) as boolean[]
    assert.ok(checks.length > 100 && checks.every(Boolean), run.stdout)
})
