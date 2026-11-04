import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { NoteObject } from '../../src/chart/note'
import { parseLevelDataChart } from '../../src/chart/parse/levelData'
import { statisticsStringsOf } from '../../src/editor/statistics/strings'
import en from '../../src/i18n/en/index.json'
import fr from '../../src/i18n/fr/index.json'
import ja from '../../src/i18n/ja/index.json'
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
    figureRows,
    gridOf,
    kernel,
    mergeTimes,
    npsFigures,
    npsSets,
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
    type Samples,
} from '../../src/levelData/statistics'
import { buildPreviewChart } from '../../src/preview/engine/chart'
import { getComboTimes } from '../../src/preview/engine/combo'
import { createState, type State } from '../../src/state'
import { chart, handBuilt, note } from '../helpers/scoring'

// A 32-bit generator: seeded, uniform, with no short cycle.
const mulberry32 = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

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
    const times = getComboTimes(buildPreviewChart(state, 10))
    assert.equal(times.length, stats.combo)
    assert.deepEqual(times, mergeTimes(CATEGORIES.map((category) => stats.times[category])).times)
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
        assert.equal(representable(stats), false)
    }
})

test('a time past a change to an absurd BPM is left out, never replaced by an earlier one', () => {
    const tempo = [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 1e-310 },
    ]
    const late = statsOf(createState(chart([[note(0)], [note(2)], [note(8)]], tempo), 0))
    assert.equal(late.combo, 3)
    assert.equal(late.firstComboNote, 0)
    assert.equal(late.lastComboNote, undefined)
    assert.equal(late.lastNote, undefined)
    // The last combo note in time, and an anchor beyond: Last Note alone is left out.
    const anchored = statsOf(
        createState(chart([[note(0)], [note(2)], [note(8, { noteType: 'anchor' })]], tempo), 0),
    )
    assert.equal(anchored.lastComboNote, 1)
    assert.equal(anchored.lastNote, undefined)
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

/** One layer's samples over the whole grid. */
const denseSamples = (samples: Samples, layer: number) => {
    const out = new Float64Array(samples.n)
    samples.segments.forEach(([start], k) => {
        const array = samples.layers[layer]?.[k]
        if (array) out.set(array, start)
    })
    return out
}

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

test('the y axis takes a nice top in whole steps, and the time labels stay few on any length', () => {
    assert.deepEqual(yScale(21), { step: 5, top: 25 })
    assert.deepEqual(yScale(476), { step: 100, top: 500 })
    assert.deepEqual(yScale(600), { step: 200, top: 600 })
    assert.deepEqual(yScale(10), { step: 5, top: 10 })
    assert.deepEqual(yScale(12), { step: 5, top: 15 })
    assert.deepEqual(yScale(0.4), { step: 1, top: 1 })
    for (let top = 0.05; top < 300; top += 0.35)
        for (const max of [3, 4]) assert.ok(Number.isInteger(yScale(top, max).step), `${top}`)
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

const npsOf = (stats: ChartStatistics, chosen: readonly Category[]) => {
    const sets = npsSets(stats.times, chosen)
    return sets && npsFigures(sets)
}

const copyText = (stats: ChartStatistics, chosen: Category[], locale: 'en' | 'fr', title = '') =>
    copyTextLines(
        {
            title,
            stats,
            chosen,
            figures: npsOf(stats, chosen),
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
    assert.ok(lines.includes('Tap : 11 (2 critiques)'))
    assert.ok(lines.includes('Relâchement : 7 (0 critique)'))
    assert.ok(lines.includes('Moyenne : Principales : 2,9, Toutes : 6,0'))
    assert.ok(lines.includes('Notes par seconde : Tap, Flick, Relâchement, Tick'))
})

test('Copy Text spells out Primary and All when both have notes', () => {
    const lines = copyText(statsOf(handBuilt()), ['tap', 'flick', 'release', 'tick'], 'en')
    const at = lines.indexOf('Notes per Second: Tap, Flick, Release, Tick')
    assert.deepEqual(lines.slice(at + 1, at + 5), [
        'Average: Primary: 2.9, All: 6.0',
        'Median: Primary: 2, All: 3',
        '90th Percentile: Primary: 7, All: 20',
        '99th Percentile: Primary: 7, All: 25',
    ])
    // Only secondary notes: one value, as before.
    const trace = copyText(statsOf(handBuilt()), ['trace'], 'en')
    assert.ok(trace.some((line) => /^Average: \d+\.\d$/.test(line)))
})

// --- Primary and All.

const timesOf = (byCategory: Partial<Record<Category, number[]>>) =>
    Object.fromEntries(
        CATEGORIES.map((category) => [category, Float64Array.from(byCategory[category] ?? [])]),
    ) as Record<Category, Float64Array>

test('Primary is the chosen Tap, Flick and Release; a chosen category with no notes is not present', () => {
    // Only primary: one set, the same array.
    const primaryOnly = npsSets(timesOf({ tap: [0, 0.25], trace: [3] }), ['tap', 'tick'])
    assert.ok(primaryOnly)
    assert.equal(primaryOnly.primary, primaryOnly.all)
    assert.deepEqual([primaryOnly.hasPrimary, primaryOnly.hasSecondary], [true, false])
    assert.deepEqual(npsFigures(primaryOnly).primary, npsFigures(primaryOnly).all)
    // Only secondary: Primary's figures are zeros.
    const secondaryOnly = npsSets(timesOf({ trace: [0, 10] }), ['tap', 'trace'])
    assert.ok(secondaryOnly)
    const zeros = npsFigures(secondaryOnly)
    assert.deepEqual(zeros.primary, { average: 0, median: 0, p90: 0, p99: 0 })
    assert.deepEqual(zeros.all, rollingFigures(Float64Array.from([0, 10])))
    assert.deepEqual([zeros.hasPrimary, zeros.hasSecondary], [false, true])
    // Both.
    const both = npsSets(timesOf({ tap: [0, 0.25], damage: [5] }), ['tap', 'damage'])
    assert.ok(both)
    assert.deepEqual([...both.primary], [0, 0.25])
    assert.deepEqual([...both.all], [0, 0.25, 5])
    const figures = npsFigures(both)
    assert.deepEqual(figures.primary, rollingFigures(Float64Array.from([0, 0.25])))
    assert.deepEqual(figures.all, rollingFigures(Float64Array.from([0, 0.25, 5])))
    // None.
    assert.equal(npsSets(timesOf({ tap: [1] }), []), undefined)
    assert.equal(npsSets(timesOf({ tap: [1] }), ['flick', 'trace']), undefined)
})

const enStrings = statisticsStringsOf(en)
const rowsOf = (byCategory: Partial<Record<Category, number[]>>, chosen: Category[]) => {
    const sets = npsSets(timesOf(byCategory), chosen)
    return figureRows(sets && npsFigures(sets), enStrings, 'en')
}

test('a figure shows <primary> (<all>) with both, else one value; its bubble has Primary, and All with secondary notes', () => {
    const [average, median] = rowsOf({ tap: [0, 0.25], trace: [5] }, ['tap', 'trace'])
    assert.equal(average?.value, '1.6 (1.3)')
    assert.deepEqual(average?.lines, [
        { label: 'Primary', value: '1.6' },
        { label: 'All', value: '1.3' },
    ])
    assert.equal(average?.text, 'Average: Primary: 1.6, All: 1.3')
    assert.equal(median?.value, '2 (1)')

    const [primaryAverage] = rowsOf({ tap: [0, 0.25], trace: [5] }, ['tap'])
    assert.equal(primaryAverage?.value, '1.6')
    assert.deepEqual(primaryAverage?.lines, [{ label: 'Primary', value: '1.6' }])
    assert.equal(primaryAverage?.text, 'Average: 1.6')

    // Only secondary: the value is All's, and the bubble shows where it comes from.
    const [secondaryAverage, secondaryMedian] = rowsOf({ trace: [0, 10] }, ['tap', 'trace'])
    assert.equal(secondaryAverage?.value, '1.0')
    assert.deepEqual(secondaryAverage?.lines, [
        { label: 'Primary', value: '0.0' },
        { label: 'All', value: '1.0' },
    ])
    assert.equal(secondaryAverage?.text, 'Average: 1.0')
    assert.deepEqual(secondaryMedian?.lines, [
        { label: 'Primary', value: '0' },
        { label: 'All', value: '1' },
    ])

    // No chosen notes: the labels stay, with no value, bubble or text.
    assert.deepEqual(
        rowsOf({ tap: [1] }, []).map((row) => [row.label, row.value, row.lines, row.text]),
        ['Average', 'Median', '90th Percentile', '99th Percentile'].map((label) => [
            label,
            '',
            undefined,
            undefined,
        ]),
    )

    // Japanese pairs them in full-width parentheses.
    const sets = npsSets(timesOf({ tap: [0, 0.25], trace: [5] }), ['tap', 'trace'])
    const [jaAverage] = figureRows(
        sets && npsFigures(sets),
        statisticsStringsOf(ja as typeof en),
        'ja',
    )
    assert.equal(jaAverage?.value, '1.6（1.3）')
})

test('Primary can be above All: ten seconds of streams among ninety of lone secondary notes', () => {
    const tap = Array.from({ length: 100 }, (_, i) => i / 10)
    const trace = Array.from({ length: 45 }, (_, i) => 12 + i * 2)
    const [, median] = rowsOf({ tap, trace }, ['tap', 'trace'])
    assert.equal(median?.value, '10 (1)')
})
