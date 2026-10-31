import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { Chart } from '../../src/chart'
import type { GroupId } from '../../src/chart/groups'
import type { NoteObject } from '../../src/chart/note'
import { parseLevelDataChart } from '../../src/chart/parse/levelData'
import type { StageId } from '../../src/chart/stages'
import { statisticsStringsOf } from '../../src/editor/statistics/strings'
import en from '../../src/i18n/en/index.json'
import fr from '../../src/i18n/fr/index.json'
import { parseLevelData } from '../../src/levelData/parse'
import { serializeToLevelData } from '../../src/levelData/serialize'
import {
    bars,
    bgmEndOf,
    binWidth,
    CATEGORIES,
    chartModel,
    chartStatistics,
    copyTextLines,
    curveColumns,
    curveSamples,
    denseSamples,
    gridOf,
    kernel,
    mergeTimes,
    oneSecondMax,
    representable,
    rollingFigures,
    roundParts,
    ROWS,
    SAMPLE,
    skyline,
    timelineOf,
    timeTicks,
    yScale,
    type Category,
    type ChartStatistics,
    type Row,
} from '../../src/levelData/statistics'
import { createState, type State } from '../../src/state'

// A 32-bit generator: seeded, uniform, with no short cycle.
const mulberry32 = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const note = (beat: number, overrides: Partial<NoteObject> = {}): NoteObject => ({
    groupId: 1 as GroupId,
    stageId: 1 as StageId,
    beat,
    noteType: 'default',
    isAttached: false,
    left: -1,
    size: 2,
    isCritical: false,
    flickDirection: 'none',
    isFake: false,
    noteStyle: 'default',
    connectorStyle: 'default',
    sfx: 'default',
    isConnectorSeparator: false,
    connectorType: 'active',
    connectorEase: 'linear',
    connectorIsFake: false,
    connectorActiveIsCritical: false,
    connectorGuideAlpha: 1,
    connectorLayer: 'top',
    connectorIsPassThrough: false,
    connectorPresentation: 'default',
    ...overrides,
})

const chart = (slides: NoteObject[][], bpms: Chart['bpms'] = [{ beat: 0, bpm: 120 }]): Chart => ({
    initialLife: 1000,
    isDynamicStages: false,
    bpms,
    groups: new Map([[1 as GroupId, { name: 'A' }]]),
    stages: new Map([
        [
            1 as StageId,
            { name: 'S', isFromStart: true, isUntilEnd: true, generateSimLines: 'global' },
        ],
    ]),
    cameraEvents: [],
    stageMaskEvents: [],
    stagePivotEvents: [],
    stageStyleEvents: [],
    stageTransformEvents: [],
    timeScales: [],
    slides,
})

const statsOf = (state: State) => chartStatistics({ store: state.store, bpms: state.bpms })

// The row of each exported note archetype, by its name alone.
const exportedRow = (archetype: string): Row | undefined => {
    if (archetype === 'TransientHiddenTickNote') return 'hiddenTick'
    if (archetype === 'TransientHiddenDamageTickNote') return 'damageTick'
    const match = /^(Fake)?(Normal|Critical)?([A-Za-z]+)Note$/.exec(archetype)
    if (!match) return undefined
    const base = match[3] ?? ''
    if (base === 'Anchor') return undefined
    if (match[1]) return 'fakeNote'
    const rows: Record<string, Row> = {
        Tap: 'tap',
        HeadTap: 'tap',
        Flick: 'flick',
        HeadFlick: 'flick',
        TailFlick: 'flick',
        TailRelease: 'release',
        Trace: 'trace',
        HeadTrace: 'trace',
        TailTrace: 'trace',
        TraceFlick: 'traceFlick',
        HeadTraceFlick: 'traceFlick',
        TailTraceFlick: 'traceFlick',
        Tick: 'tick',
        Damage: 'damageNote',
    }
    const row = rows[base]
    if (!row) throw new Error(`Unknown archetype ${archetype}`)
    return row
}

const exportCounts = (state: State) => {
    const counts = Object.fromEntries(ROWS.map((row) => [row, 0])) as Record<Row, number>
    const critical: Partial<Record<Row, number>> = {}
    let combo = 0
    for (const { archetype } of serializeToLevelData(
        state.initialLife,
        state.isDynamicStages,
        0,
        state.store,
        state.groups,
        state.stages,
    ).entities) {
        const row = exportedRow(archetype)
        if (!row) continue
        counts[row]++
        if (row !== 'fakeNote') {
            combo++
        }
        if (archetype.startsWith('Critical')) critical[row] = (critical[row] ?? 0) + 1
    }
    return { counts, critical, combo }
}

const assertEqualToExport = (state: State) => {
    const stats = statsOf(state)
    const exported = exportCounts(state)
    assert.deepEqual(stats.counts, exported.counts)
    assert.equal(stats.combo, exported.combo)
    for (const row of ROWS)
        assert.equal(stats.critical[row] ?? 0, exported.critical[row] ?? 0, `${row} critical`)
}

// Deterministic charts with every role, flicks on every role, critical and fake notes, fake and
// guide slides, damage runs with separators, zero-length slides, Force Tick and Non-Tick.
const randomCharts = function* () {
    const random = mulberry32(777)
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)] as T
    for (let round = 0; round < 30; round++) {
        const slides: NoteObject[][] = []
        for (let s = 0; s < 30; s++) {
            const count = 1 + Math.floor(random() * 6)
            const notes: NoteObject[] = []
            let beat = Math.floor(random() * 64 * 8) / 8
            for (let i = 0; i < count; i++) {
                beat += pick([0, 0, 0.125, 0.25, 1 / 3, 0.5, 1, 2])
                notes.push(
                    note(beat, {
                        noteType: pick([
                            'default',
                            'default',
                            'trace',
                            'anchor',
                            'damage',
                            'forceTick',
                            'forceNonTick',
                        ] as const),
                        isAttached: random() < 0.3,
                        isCritical: random() < 0.4,
                        flickDirection: pick(['none', 'none', 'up', 'downLeft'] as const),
                        isFake: random() < 0.15,
                        isConnectorSeparator: random() < 0.3,
                        connectorType: pick(['active', 'active', 'guide', 'damage'] as const),
                        connectorIsFake: random() < 0.15,
                        connectorActiveIsCritical: random() < 0.3,
                    }),
                )
            }
            slides.push(notes)
        }
        yield chart(slides)
    }
}

test('each row and Combo equal the exported entities of their archetypes', () => {
    for (const source of randomCharts()) assertEqualToExport(createState(source, 0))
})

test('the generated large chart counts as Export writes it', () => {
    const entities = parseLevelData(
        JSON.parse(readFileSync('tests/fixtures/generated-large.json', 'utf8')),
    ).entities
    assertEqualToExport(createState(parseLevelDataChart(entities), 0))
})

test('a trace with a flick is a Trace Flick at any place; a slide-end flick is a Flick', () => {
    const flick = { flickDirection: 'up' } as const
    const trace = { noteType: 'trace' } as const
    const stats = statsOf(
        createState(
            chart([
                [
                    note(0, { ...trace, ...flick }),
                    note(1, { ...trace, ...flick }),
                    note(2, { ...trace, ...flick }),
                ],
                [note(0, trace), note(1, { ...trace, ...flick }), note(2)],
                [note(4), note(5, flick)],
                [note(6, { ...trace, ...flick })],
            ]),
            0,
        ),
    )
    assert.equal(stats.counts.traceFlick, 5)
    assert.equal(stats.counts.trace, 1)
    assert.equal(stats.counts.flick, 1)
})

// The hand-derived chart: BPM 120 from beat 0 and 60 from beat 8, each slide on its own.
const handBuilt = (extra: NoteObject[][] = [], tail: Partial<NoteObject> = {}) => {
    const damage = { connectorType: 'damage' } as const
    const anchor = { noteType: 'anchor' } as const
    return createState(
        chart(
            [
                [note(0), note(2, tail)],
                [note(0.25, { noteType: 'trace' }), note(2, { flickDirection: 'up' })],
                [note(0, { isCritical: true }), note(1, { isConnectorSeparator: true }), note(2)],
                [note(0, { ...anchor, ...damage }), note(2, { ...anchor, ...damage })],
                [note(4), note(4)],
                [note(4, { ...anchor, ...damage }), note(4, { ...anchor, ...damage })],
                [note(0), note(1), note(2)],
                [note(0, { connectorIsFake: true }), note(2)],
                [note(0, { connectorType: 'guide' }), note(2, { connectorType: 'guide' })],
                [note(0, { noteType: 'forceNonTick' }), note(2 + 1 / 480)],
                [note(8), note(9, { noteType: 'forceNonTick' }), note(10)],
                [note(5, { noteType: 'forceTick' })],
                [note(6, { isCritical: true })],
                [note(6.5, { flickDirection: 'up' })],
                [note(7, { noteType: 'trace' })],
                [note(7.5, { noteType: 'damage' })],
                [note(12, { isFake: true })],
                [note(12.5, anchor)],
                ...extra,
            ],
            [
                { beat: 0, bpm: 120 },
                { beat: 8, bpm: 60 },
            ],
        ),
        0,
    )
}

test('the hand-derived chart gives the counts, critical counts and times worked out by hand', () => {
    const state = handBuilt()
    const stats = statsOf(state)
    assert.deepEqual(stats.counts, {
        tap: 11,
        flick: 2,
        release: 7,
        trace: 2,
        traceFlick: 0,
        tick: 3,
        hiddenTick: 19,
        damageNote: 1,
        damageTick: 5,
        fakeNote: 1,
    })
    assert.equal(stats.combo, 50)
    assert.deepEqual(stats.critical, {
        tap: 2,
        flick: 0,
        release: 0,
        trace: 0,
        traceFlick: 0,
        tick: 0,
    })
    assert.equal(stats.firstComboNote, 0)
    assert.equal(stats.lastComboNote, 6)
    assert.equal(stats.lastNote, 8.5)
    assertEqualToExport(state)

    const max = (categories: Category[]) =>
        oneSecondMax(mergeTimes(categories.map((category) => stats.times[category])).times)
    assert.equal(max(['tap', 'flick', 'release']), 7)
    assert.equal(max(['tap', 'flick', 'release', 'trace']), 8)
    assert.equal(max(['tap', 'flick', 'release', 'trace', 'tick']), 26)
    assert.equal(mergeTimes(CATEGORIES.map((category) => stats.times[category])).times.length, 50)
})

test('a critical damage note has no breakdown, and a slide end keeps its own flag', () => {
    const stats = statsOf(
        handBuilt([[note(7.75, { noteType: 'damage', isCritical: true })]], { isCritical: true }),
    )
    assert.equal(stats.counts.damageNote, 2)
    assert.equal(stats.critical.damageNote, undefined)
    assert.equal(stats.critical.release, 1)
})

test('BGM End is the length less the offset, and left out when the music ends by 0', () => {
    const meta = { hash: '', filename: '', size: 0, type: '', durationMs: 10000 }
    assert.equal(bgmEndOf({ offset: -0.25, meta }), 10.25)
    assert.equal(bgmEndOf({ offset: 20, meta }), undefined)
    assert.equal(bgmEndOf({ offset: 10, meta }), undefined)
    assert.equal(bgmEndOf({ offset: 0 }), undefined)
})

test('at absurd BPMs the counts and the finite times show, and the chart is not drawn', () => {
    for (const [bpm, times] of [
        [1e-10, [0, 6e16]],
        [1e-310, []],
    ] as const) {
        const stats = statsOf(
            createState(chart([[note(0)], [note(100000)]], [{ beat: 0, bpm }]), 0),
        )
        assert.equal(stats.counts.tap, 2)
        assert.equal(stats.combo, 2)
        const shown = [stats.firstComboNote, stats.lastNote].filter((time) => time !== undefined)
        assert.deepEqual(shown, times)
        assert.equal(representable(stats, undefined), false)
    }
})

test('an empty chart has zeros and no note times', () => {
    const stats = statsOf(createState(chart([]), 0))
    assert.equal(stats.combo, 0)
    assert.equal(stats.firstComboNote, undefined)
    assert.equal(stats.lastComboNote, undefined)
    assert.equal(stats.lastNote, undefined)
})

// --- The four figures.

const figures = (times: number[]) => {
    const result = rollingFigures(Float64Array.from(times))
    assert.ok(result)
    return [Math.round(result.average * 10) / 10, result.median, result.p90, result.p99]
}

test('the four figures are of the Rolling count over the time it is above 0', () => {
    assert.deepEqual(figures([3]), [1, 1, 1, 1])
    assert.deepEqual(figures([0, 10]), [1, 1, 1, 1])
    assert.deepEqual(figures([0, 0.25]), [1.6, 2, 2, 2])
    assert.deepEqual(figures([2, 2, 2]), [3, 3, 3, 3])
    assert.deepEqual(figures([0, 0.1]), [1.8, 2, 2, 2])
    // Thirty single notes and ten five-note chords, 2 s apart: 30 s at 1 and 10 s at 5.
    const singles = Array.from({ length: 30 }, (_, i) => i * 2)
    const chords = Array.from({ length: 50 }, (_, i) => 60 + Math.floor(i / 5) * 2)
    assert.deepEqual(figures([...singles, ...chords]), [2, 1, 5, 5])
    assert.equal(rollingFigures(new Float64Array()), undefined)
})

test('the window rule never adds a note across a one-second boundary', () => {
    const stream = (bpm: number) => Array.from({ length: 200 * 4 }, (_, i) => ((i / 4) * 60) / bpm)
    assert.equal(oneSecondMax(stream(90)), 6)
    assert.equal(oneSecondMax(stream(135)), 9)
    assert.equal(oneSecondMax(stream(180)), 12)
    // 1/48 notes at 135 BPM for a beat, then 180.
    const times = Array.from({ length: 40 * 48 + 1 }, (_, i) => {
        const beat = i / 48
        return beat <= 1 ? (beat * 60) / 135 : 60 / 135 + ((beat - 1) * 60) / 180
    })
    assert.equal(oneSecondMax(times), 144)
})

// --- Smooth.

const drawnArea = (xs: Float64Array, ys: Float64Array) => {
    let area = 0
    for (let i = 1; i < xs.length; i++)
        area += (((xs[i] ?? 0) - (xs[i - 1] ?? 0)) * ((ys[i] ?? 0) + (ys[i - 1] ?? 0))) / 2
    return area
}

test('the kernel keeps a chord within its count and a note within 1.5 s', () => {
    const k0 = kernel(0)
    assert.ok(Math.abs(k0 - 0.793) < 1e-3)
    const chord = Float64Array.from([10, 10, 10, 10, 10])
    const grid = gridOf(chord)
    assert.ok(grid)
    const samples = denseSamples(curveSamples([chord], grid), 0)
    assert.ok(Math.abs(Math.max(...samples) - 5 * k0) < 0.01)
    assert.ok(Math.abs(samples.reduce((sum, value) => sum + value, 0) * SAMPLE - 5) < 1e-9)
    samples.forEach((value, i) => {
        const time = grid.g0 + i * SAMPLE
        if (Math.abs(time - 10) > 1.5 + SAMPLE) assert.equal(value, 0)
    })
    // A steady stream keeps its rate.
    const eight = Float64Array.from({ length: 160 }, (_, i) => i / 8)
    const steady = denseSamples(curveSamples([eight], gridOf(eight)!), 0)
    const middle = steady[Math.round((10 - gridOf(eight)!.g0) / SAMPLE)] ?? 0
    assert.ok(Math.abs(middle - 8) < 0.02)
})

test('the drawn area is the number of notes, at the ends of the chart and after long silences', () => {
    for (const [times, bgmEnd] of [
        [[0], undefined],
        [[3600], undefined],
        [[0], 3600],
        [[0, 0.5, 30], undefined],
    ] as const) {
        const list = Float64Array.from(times)
        const model = chartModel('smooth', list, [list], bgmEnd, 600)
        assert.ok(model)
        const total = model.boundaries[0] ?? new Float64Array()
        assert.ok(total.every(Number.isFinite))
        assert.ok(Math.abs(drawnArea(model.xs, total) - times.length) < 0.005 * times.length)
        if (times.length > 1) continue
        // The bump's peak is at the note.
        const peak = total.indexOf(Math.max(...total))
        const width = (model.x1 - model.x0) / 600
        assert.ok(Math.abs((model.xs[peak] ?? 0) - (times[0] ?? 0)) <= width + 1e-9)
    }
    // A lone note's bump has the same height wherever it is.
    const at = (time: number) => {
        const list = Float64Array.from([time])
        const samples = denseSamples(curveSamples([list], gridOf(list)!), 0)
        return Math.max(...samples)
    }
    assert.ok(Math.abs(at(0) - at(30)) < 1e-12)
})

test('the layers add up to the total, and an entry leaves the other layers as they were', () => {
    const a = Float64Array.from([0.1, 0.4, 2.2, 5])
    const b = Float64Array.from([0.3, 2.21, 7])
    const every = mergeTimes([a, b]).times
    const grid = gridOf(every)!
    const { x0, x1 } = timelineOf(grid, undefined)
    const both = curveColumns(curveSamples([a, b], grid), x0, x1, 400).values
    const alone = curveColumns(curveSamples([a], grid), x0, x1, 400).values
    const merged = curveColumns(curveSamples([every], grid), x0, x1, 400).values
    both[0]?.forEach((value, i) => {
        assert.ok(Math.abs(value - (alone[0]?.[i] ?? 0)) < 1e-12)
        assert.ok(Math.abs(value + (both[1]?.[i] ?? 0) - (merged[0]?.[i] ?? 0)) < 1e-9)
    })
})

test('two notes far apart store only the samples around them', () => {
    const list = Float64Array.from([0, 600000])
    const grid = gridOf(list)
    assert.ok(grid)
    const stored = grid.segments.reduce((sum, [start, end]) => sum + end - start + 1, 0)
    assert.equal(stored, 128)
})

// --- Rolling.

// Every window start on a fine grid across each step's range, counted by binary search.
const bruteSkyline = (times: number[], x0: number, x1: number, count: number) => {
    const ms = times.map((time) => time * 1000)
    const firstAtOrAfter = (value: number) => {
        let lo = 0
        let hi = ms.length
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if ((ms[mid] ?? 0) < value) lo = mid + 1
            else hi = mid
        }
        return lo
    }
    const width = (x1 - x0) / count
    return Array.from({ length: count }, (_, k) => {
        const a = x0 + k * width
        const b = a + width
        if (b <= 0) return 0
        const from = Math.max(0, (a - 0.5) * 1000)
        const to = Math.max((b - 0.5) * 1000, from + 1e-6)
        const starts = [from, ...ms.filter((m) => m >= from && m < to)]
        for (const m of ms) {
            const entry = m - 1000 + 2e-6
            if (entry > from && entry < to) starts.push(entry)
        }
        let best = 0
        for (const start of starts)
            best = Math.max(best, firstAtOrAfter(start + 1000 - 1e-6) - firstAtOrAfter(start))
        return best
    })
}

test('each Rolling step is the busiest window centred in it, and the top is the one-second maximum', () => {
    const random = mulberry32(99)
    for (let round = 0; round < 40; round++) {
        const times = Array.from(
            { length: 5 + Math.floor(random() * 80) },
            () => Math.floor(random() * 3000) / 100,
        ).sort((a, b) => a - b)
        const list = Float64Array.from(times)
        const tagged = mergeTimes([list])
        const grid = gridOf(list)!
        const { x0, x1 } = timelineOf(grid, undefined)
        const steps = skyline(tagged, x0, x1, 300)
        assert.deepEqual(
            steps.map((step) => step.count),
            bruteSkyline(times, x0, x1, 300),
        )
        assert.equal(Math.max(...steps.map((step) => step.count)), oneSecondMax(list))
    }
})

test('Rolling counts from 00:00.000 and splits a step by its earliest busiest window', () => {
    const list = Float64Array.from([0, 0.75])
    const steps = skyline(mergeTimes([list]), -1.55, 2.3, 300)
    const at = (time: number) => steps.find((step) => step.a <= time && time < step.b)
    assert.equal(at(-1)?.count, 0)
    assert.equal(at(0)?.count, 2)
    assert.equal(at(0.5)?.count, 2)
    // Two layers, two equally busy windows: the earliest is kept.
    const split = skyline(
        mergeTimes([Float64Array.from([10]), Float64Array.from([11.2])]),
        10,
        11,
        1,
    )
    assert.deepEqual(split[0]?.parts, [1, 0])
})

// --- Bars.

test('Bars puts each note in one bin by the window rule, with the width from the end of the timeline', () => {
    assert.equal(binWidth(125.4), 1)
    assert.equal(binWidth(149.5), 1)
    assert.equal(binWidth(150), 2)
    assert.equal(binWidth(600), 5)
    assert.equal(binWidth(1800), 15)
    const last = 14.999999999999998
    const lone = bars(mergeTimes([Float64Array.from([last])]), last)
    assert.equal(lone.bins.length, 16)
    assert.equal(lone.bins[15]?.count, 1)
    // Against an exact nanosecond count, notes on and just before boundaries included.
    const times = [0, 0.999999999999, 1, 1.5, 2 - 1e-12, 2, 3.25, 99.999999]
    const result = bars(
        mergeTimes([Float64Array.from(times.slice(0, 4)), Float64Array.from(times.slice(4))]),
        100,
    )
    const expected = new Map<number, number>()
    for (const time of times) {
        const bin = Math.floor(Math.round(time * 1e9) / 1e9)
        expected.set(bin, (expected.get(bin) ?? 0) + 1)
    }
    result.bins.forEach((bin, k) => {
        assert.equal(bin.count, expected.get(k) ?? 0, `bin ${k}`)
        assert.equal(
            bin.parts.reduce((sum, part) => sum + part, 0),
            bin.count,
        )
    })
})

// --- The axes and the readout's rounding.

test('the y axis takes a nice top, and the time labels stay few on any length', () => {
    assert.deepEqual(yScale(21), { step: 5, top: 25 })
    assert.deepEqual(yScale(476), { step: 100, top: 500 })
    assert.deepEqual(yScale(600), { step: 200, top: 600 })
    assert.deepEqual(yScale(10), { step: 5, top: 10 })
    const end = (100000 * 60) / 120
    assert.ok(timeTicks(end, 6).length <= 6)
    assert.ok(timeTicks(end, 3).length <= 3)
})

test('the parts of the readout add up to its total as shown', () => {
    assert.deepEqual(roundParts([4.79, 0.73, 2.25], 7.77), [4.8, 0.7, 2.3])
    const parts = [1.04, 2.04, 3.04]
    const shown = roundParts(parts, 6.12)
    assert.equal(Math.round(shown.reduce((sum, part) => sum + part, 0) * 10), 61)
})

// --- Copy Text.

const copyText = (stats: ChartStatistics, chosen: Category[], locale: 'en' | 'fr', title = '') =>
    copyTextLines(
        {
            title,
            stats,
            chosen,
            figures: rollingFigures(
                mergeTimes(chosen.map((category) => stats.times[category])).times,
            ),
            bgmEnd: 10.25,
        },
        statisticsStringsOf(locale === 'en' ? en : (fr as typeof en)),
        locale,
    )

test('Copy Text gives the title, then each figure in the order of the dialog', () => {
    const stats = statsOf(handBuilt())
    assert.deepEqual(copyText(stats, ['tap', 'flick', 'release'], 'en', ' Hand Built '), [
        'Hand Built',
        'Combo: 50',
        'Tap: 11 (2 critical)',
        'Flick: 2 (0 critical)',
        'Release: 7 (0 critical)',
        'Trace: 2 (0 critical)',
        'Trace Flick: 0',
        'Tick: 3 (0 critical)',
        'Hidden Tick: 19',
        'Damage Note: 1',
        'Damage Tick: 5',
        'Fake Note: 1',
        'Notes per Second: Tap, Flick, Release',
        'Average: 2.9',
        'Median: 2',
        '90th Percentile: 7',
        '99th Percentile: 7',
        'First Combo Note: 00:00.000',
        'Last Combo Note: 00:06.000',
        'Last Note: 00:08.500',
        'BGM End: 00:10.250',
    ])
    const none = copyText(stats, [], 'en')
    assert.equal(none[0], 'Combo: 50')
    assert.ok(none.includes('Notes per Second: No notes to count'))
    assert.ok(!none.some((line) => line.startsWith('Average')))
})

test('Copy Text in French spaces its colons and agrees with the critical count', () => {
    const lines = copyText(statsOf(handBuilt()), ['tap', 'flick', 'release', 'tick'], 'fr')
    assert.ok(lines.includes('Tap\u00a0: 11 (2 critiques)'))
    assert.ok(lines.includes('Relâchement\u00a0: 7 (0 critique)'))
    assert.ok(lines.some((line) => /^Moyenne\u00a0: \d+,\d$/.test(line)))
    assert.ok(lines.includes('Notes par seconde\u00a0: Tap, Flick, Relâchement, Tick'))
})
