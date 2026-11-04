import { languageTag } from '../i18n/plural'
import type { Bgm } from '../state/bgm'
import { beatToTime, type BpmIntegral } from '../state/integrals/bpms'
import type { Store } from '../state/store'
import { formatTime } from '../utils/format'
import { fill } from '../utils/interpolate'
import { formatCount, formatTenths } from '../utils/size'
import {
    CATEGORIES,
    categoryOf,
    forEachExported,
    inCombo,
    ROWS,
    type Category,
    type Row,
} from './scoring'

// Statistics: the chart's counts by what the player does, its times, and the Notes per
// Second chart's three modes and four figures. The dialog and the share card both draw from
// here, so the two always agree.

export { CATEGORIES, ROWS, type Category, type Row } from './scoring'

const CRITICAL_ROWS: readonly Row[] = ['tap', 'flick', 'release', 'trace', 'traceFlick', 'tick']

export const DEFAULT_CATEGORIES: readonly Category[] = CATEGORIES

export type ChartStatistics = {
    counts: Record<Row, number>
    /** Critical counts of the rows that have a variant. */
    critical: Partial<Record<Row, number>>
    combo: number
    /** Sorted chart times in seconds, per category. */
    times: Record<Category, Float64Array>
    firstComboNote?: number
    lastComboNote?: number
    /** The latest note of any kind, anchors and fake notes included. */
    lastNote?: number
}

const emptyCounts = () => Object.fromEntries(ROWS.map((row) => [row, 0])) as Record<Row, number>

/** Counts every row as Export writes the chart: hidden ticks from the serializer's own schedule. */
export const chartStatistics = ({
    store,
    bpms,
}: {
    store: Pick<Store, 'slides'>
    bpms: BpmIntegral[]
}): ChartStatistics => {
    const counts = emptyCounts()
    const critical: Partial<Record<Row, number>> = Object.fromEntries(
        CRITICAL_ROWS.map((row) => [row, 0]),
    )
    const beats = Object.fromEntries(
        CATEGORIES.map((category) => [category, [] as number[]]),
    ) as Record<Category, number[]>
    let lastBeat = -Infinity
    for (const infos of store.slides.info.values()) {
        for (const info of infos) {
            if (info.note.beat > lastBeat) lastBeat = info.note.beat
        }
        forEachExported(infos, (row, beat, info) => {
            counts[row]++
            if (!inCombo(row)) return
            if (info?.note.isCritical && critical[row] !== undefined) critical[row]++
            beats[categoryOf(row)].push(beat)
        })
    }

    let firstBeat = Infinity
    let lastComboBeat = -Infinity
    const times = Object.fromEntries(
        CATEGORIES.map((category) => {
            for (const beat of beats[category]) {
                firstBeat = Math.min(firstBeat, beat)
                lastComboBeat = Math.max(lastComboBeat, beat)
            }
            return [
                category,
                Float64Array.from(beats[category], (beat) => beatToTime(bpms, beat)).sort(),
            ]
        }),
    ) as Record<Category, Float64Array>

    let combo = 0
    for (const row of ROWS) if (inCombo(row)) combo += counts[row]
    // Absurd BPMs can make a time infinite or NaN: each time shows only when its own is finite.
    const timeOf = (beat: number) => {
        if (!Number.isFinite(beat)) return undefined
        const time = beatToTime(bpms, beat)
        return Number.isFinite(time) ? time : undefined
    }
    return {
        counts,
        critical,
        combo,
        times,
        firstComboNote: timeOf(firstBeat),
        lastComboNote: timeOf(lastComboBeat),
        lastNote: timeOf(lastBeat),
    }
}

/** Where the music ends in chart time, or undefined with no BGM length or one that ends by 0. */
export const bgmEndOf = (bgm: Pick<Bgm, 'offset' | 'meta' | 'buffer'>) => {
    const ms = bgm.meta?.durationMs ?? (bgm.buffer ? bgm.buffer.duration * 1000 : undefined)
    if (ms === undefined || !Number.isFinite(ms)) return undefined
    const end = ms / 1000 - bgm.offset
    return end > 0 ? end : undefined
}

/** Chosen notes merged in time order, each tagged with its layer: its index among the chosen. */
export type Tagged = { times: Float64Array; layers: Uint8Array; layerCount: number }

/** Merges sorted category lists in O(n); at equal times the lower layer comes first. */
export const mergeTimes = (lists: readonly Float64Array[]): Tagged => {
    const count = lists.reduce((sum, list) => sum + list.length, 0)
    const times = new Float64Array(count)
    const layers = new Uint8Array(count)
    const at = lists.map(() => 0)
    for (let i = 0; i < count; i++) {
        let best = -1
        let time = Infinity
        for (let j = 0; j < lists.length; j++) {
            const value = lists[j]?.[at[j] ?? 0]
            if (value !== undefined && (best === -1 || value < time)) {
                best = j
                time = value
            }
        }
        times[i] = time
        layers[i] = best
        at[best] = (at[best] ?? 0) + 1
    }
    return { times, layers, layerCount: lists.length }
}

// Times a chart reaches only at absurd BPMs: past 2^53 samples of 50 ms the grid loses precision.
const LIMIT = 2 ** 53 * 0.05

/** Whether the chart's times can be drawn: all finite and within the grid's precision. */
export const representable = (stats: ChartStatistics) =>
    CATEGORIES.every((category) =>
        stats.times[category].every((time) => Number.isFinite(time) && Math.abs(time) < LIMIT),
    )

/** Chart times in seconds, sorted where a function says so. */
export type Times = Float64Array | readonly number[]

// --- The window rule: note j is in the one-second window from s when s <= t[j] < s + 1 s - 1e-6 ms.

const MARGIN_MS = 1e-6

/** The most notes in any one-second window: Rolling's top. */
export const oneSecondMax = (times: Times) => {
    let best = 0
    for (let i = 0, j = 0; i < times.length; i++) {
        const end = (times[i] ?? 0) * 1000 + 1000 - MARGIN_MS
        while (j < times.length && (times[j] ?? 0) * 1000 < end) j++
        if (j - i > best) best = j - i
    }
    return best
}

export type Figures = { average: number; median: number; p90: number; p99: number }

/** The time the Rolling count spends at each value above 0: ascending values, the ms at each, their total. */
export type Durations = { values: Int32Array; ms: Float64Array; active: number }

/** The Rolling count r(s) as a list of durations, from one sweep of its breakpoints. */
export const rollingDurations = (times: Times): Durations | undefined => {
    const n = times.length
    if (!n) return undefined
    // r is constant between breakpoints: each note enters at n - 1 s + 1e-6 ms and leaves at n.
    const enter = new Float64Array(n)
    const leave = new Float64Array(n)
    for (let i = 0; i < n; i++) {
        const ms = (times[i] ?? 0) * 1000
        enter[i] = ms - 1000 + MARGIN_MS
        leave[i] = ms
    }
    const at = new Map<number, number>()
    let r = 0
    let active = 0
    let i = 0
    let j = 0
    let previous = 0
    while (i < n || j < n) {
        // At equal times a note enters before another leaves.
        const isEnter = i < n && (j >= n || (enter[i] ?? 0) <= (leave[j] ?? 0))
        const time = isEnter ? (enter[i++] ?? 0) : (leave[j++] ?? 0)
        if (r > 0 && time > previous) {
            at.set(r, (at.get(r) ?? 0) + time - previous)
            active += time - previous
        }
        r += isEnter ? 1 : -1
        previous = time
    }
    const values = Int32Array.from([...at.keys()].sort((a, b) => a - b))
    return { values, ms: Float64Array.from(values, (value) => at.get(value) ?? 0), active }
}

const figuresOf = ({ values, ms, active }: Durations, count: number): Figures => {
    const percentile = (p: number) => {
        let sum = 0
        for (let i = 0; i < values.length; i++) {
            sum += ms[i] ?? 0
            if (sum >= p * active - 1e-9) return values[i] ?? 0
        }
        return values[values.length - 1] ?? 0
    }
    return {
        average: count / (active / 1000),
        median: percentile(0.5),
        p90: percentile(0.9),
        p99: percentile(0.99),
    }
}

/**
 * The four figures, of the Rolling count r(s) over the time it is above 0: Average is the
 * notes over that time; the percentiles are time-weighted, whole numbers.
 */
export const rollingFigures = (times: Times): Figures | undefined => {
    const durations = rollingDurations(times)
    return durations && figuresOf(durations, times.length)
}

/** Tap and Flick. The other categories count only in All. */
export const PRIMARY_CATEGORIES: readonly Category[] = ['tap', 'flick']

/** The chosen notes merged (All), and the chosen Tap and Flick notes. */
export type NpsSets = {
    all: Float64Array
    /** The same array as `all` when no chosen category besides Tap and Flick has notes. */
    primary: Float64Array
    hasPrimary: boolean
    hasSecondary: boolean
}

/** Undefined when no chosen category has notes. */
export const npsSets = (
    times: Record<Category, Float64Array>,
    chosen: readonly Category[],
): NpsSets | undefined => {
    const kinds = CATEGORIES.filter((category) => chosen.includes(category))
    const isPrimary = (category: Category) => PRIMARY_CATEGORIES.includes(category)
    const all = mergeTimes(kinds.map((category) => times[category])).times
    if (!all.length) return undefined
    const primaryKinds = kinds.filter(isPrimary)
    const hasPrimary = primaryKinds.some((category) => times[category].length > 0)
    const hasSecondary = kinds.some(
        (category) => !isPrimary(category) && times[category].length > 0,
    )
    const primary = hasSecondary
        ? mergeTimes(primaryKinds.map((category) => times[category])).times
        : all
    return { all, primary, hasPrimary, hasSecondary }
}

/** The durations of All and of Tap and Flick; the latter are undefined with no such notes. */
export type NpsDurations = { all: Durations; primary: Durations | undefined }

export const npsDurations = ({ all, primary }: NpsSets): NpsDurations | undefined => {
    const allDurations = rollingDurations(all)
    if (!allDurations) return undefined
    return {
        all: allDurations,
        primary: primary === all ? allDurations : rollingDurations(primary),
    }
}

/** The four figures over All and over Tap and Flick; the latter are zeros with no such notes. */
export type NpsFigures = {
    all: Figures
    primary: Figures
    hasSecondary: boolean
}

const NO_FIGURES: Figures = { average: 0, median: 0, p90: 0, p99: 0 }

export const npsFigures = (sets: NpsSets, durations = npsDurations(sets)): NpsFigures => {
    const { all, primary, hasSecondary } = sets
    const allFigures = durations ? figuresOf(durations.all, all.length) : NO_FIGURES
    return {
        all: allFigures,
        primary:
            primary === all
                ? allFigures
                : durations?.primary
                  ? figuresOf(durations.primary, primary.length)
                  : NO_FIGURES,
        hasSecondary,
    }
}

// --- Smooth: a one-second box convolved with a biweight of radius 1 s, on a 50 ms grid.

export const SAMPLE = 0.05
const RADIUS = 1
const REACH = Math.round((0.5 + RADIUS) / SAMPLE)

const biweightCdf = (x: number) => {
    const u = Math.max(-1, Math.min(1, x / RADIUS))
    return 0.5 + (15 / 16) * (u - (2 * u ** 3) / 3 + u ** 5 / 5)
}
/** The continuous kernel: the box convolved with the biweight. */
export const kernel = (t: number) => biweightCdf(t + 0.5) - biweightCdf(t - 0.5)

// 61 taps, normalised so that the sample width times their sum is 1.
const TAPS = (() => {
    const raw = Array.from({ length: 2 * REACH + 1 }, (_, k) => kernel((k - REACH) * SAMPLE))
    const norm = raw.reduce((sum, tap) => sum + tap, 0) * SAMPLE
    return Float64Array.from(raw, (tap) => tap / norm)
})()

/** The occupied stretches of the grid, [first, last] sample indices, merged where they touch. */
export type Grid = { g0: number; n: number; segments: [number, number][] }

/** The grid over every time given: each note occupies its 61 taps, its split and a zero each side. */
export const gridOf = (gridTimes: Times): Grid | undefined => {
    let first = Infinity
    let last = -Infinity
    for (const time of gridTimes) {
        if (time < first) first = time
        if (time > last) last = time
    }
    if (first === Infinity) return undefined
    const lo = Math.floor((first - REACH * SAMPLE) / SAMPLE) - 2
    const hi = Math.ceil((last + REACH * SAMPLE) / SAMPLE) + 3
    const g0 = lo * SAMPLE
    const n = hi - lo + 1
    const bins = Float64Array.from(gridTimes, (time) => Math.floor((time - g0) / SAMPLE)).sort()
    const segments: [number, number][] = []
    for (const bin of bins) {
        const start = Math.max(0, bin - REACH - 1)
        const end = Math.min(n - 1, bin + REACH + 2)
        const previous = segments[segments.length - 1]
        if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end)
        else segments.push([start, end])
    }
    return { g0, n, segments }
}

export type Samples = Grid & {
    /** Per layer, per segment, its samples. */
    layers: Float64Array[][]
}

/** Samples per layer on the grid of every category, so a toggle leaves the other layers as they were. */
export const curveSamples = (layers: readonly Times[], grid: Grid): Samples => {
    const { g0, segments } = grid
    const starts = segments.map(([start]) => start)
    const segmentOf = (index: number) => {
        let l = 0
        let r = segments.length - 1
        while (l < r) {
            const m = (l + r + 1) >> 1
            if ((starts[m] ?? 0) <= index) l = m
            else r = m - 1
        }
        return l
    }
    return {
        ...grid,
        layers: layers.map((times) => {
            const arrays = segments.map(([start, end]) => new Float64Array(end - start + 1))
            // Every chosen time is a grid time, so its taps and its split lie inside one segment.
            const put = (array: Float64Array, first: number, weight: number) => {
                for (let j = 0; j < TAPS.length; j++)
                    array[first + j] = (array[first + j] ?? 0) + weight * (TAPS[j] ?? 0)
            }
            for (const time of times) {
                const u = (time - g0) / SAMPLE
                const bin = Math.floor(u)
                const fraction = u - bin
                const k = segmentOf(bin)
                const array = arrays[k]
                if (!array) continue
                const first = bin - REACH - (segments[k]?.[0] ?? 0)
                put(array, first, 1 - fraction)
                if (fraction > 0) put(array, first + 1, fraction)
            }
            return arrays
        }),
    }
}

/**
 * The drawn columns over [x0, x1]: per layer, each column's mean of the curve, the integral of
 * the straight lines between samples (zeros beyond the stored stretches) over its width.
 */
export const curveColumns = (samples: Samples, x0: number, x1: number, count: number) => {
    const { g0, segments } = samples
    const width = (x1 - x0) / count
    const centres = Array.from({ length: count }, (_, c) => x0 + (c + 0.5) * width)
    const values = samples.layers.map((arrays) => {
        // The integral from the far left to x, swept left to right. Every segment starts and
        // ends at a zero sample, so a whole segment's integral is h times the sum of its samples.
        let k = 0
        let total = 0
        let at = 0
        let sum = 0
        const integral = (x: number) => {
            const u = (x - g0) / SAMPLE
            while (k < segments.length && u >= (segments[k]?.[1] ?? 0)) {
                const array = arrays[k] ?? new Float64Array()
                for (; at < array.length; at++) sum += array[at] ?? 0
                total += SAMPLE * sum
                k++
                at = 0
                sum = 0
            }
            const segment = segments[k]
            if (!segment || u <= segment[0]) return total
            const array = arrays[k] ?? new Float64Array()
            const floor = Math.floor(u)
            const i = floor - segment[0]
            const f = u - floor
            for (; at <= i; at++) sum += array[at] ?? 0
            const a = array[i] ?? 0
            const b = array[i + 1] ?? 0
            return (
                total +
                SAMPLE * (sum - (array[0] ?? 0) / 2 - a / 2) +
                SAMPLE * (f * a + ((f * f) / 2) * (b - a))
            )
        }
        const out = new Float64Array(count)
        let previous = integral(x0)
        for (let c = 0; c < count; c++) {
            const next = integral(x0 + (c + 1) * width)
            out[c] = (next - previous) / width
            previous = next
        }
        return out
    })
    return { centres, values }
}

// --- Rolling: the most chosen notes in a one-second window centred in each step.

/** A stretch [a, b) of the timeline: its count of notes and their split by layer. */
export type Span = { a: number; b: number; count: number; parts: number[] }

/** Rolling's steps, each from `edges`; see `skyline`. */
const sweep = (tagged: Tagged, count: number, edges: (k: number) => [number, number]): Span[] => {
    const ms = Float64Array.from(tagged.times, (time) => time * 1000)
    const n = ms.length
    let lo = 0
    let hi = 0
    // Candidates only rise, so the pointers only move forward.
    const countAt = (start: number): [number, number, number] => {
        while (lo < n && (ms[lo] ?? 0) < start) lo++
        if (hi < lo) hi = lo
        while (hi < n && (ms[hi] ?? 0) < start + 1000 - MARGIN_MS) hi++
        return [hi - lo, lo, hi]
    }
    const entry = (time: number) => time - 1000 + 2 * MARGIN_MS
    const steps: Span[] = []
    let iNote = 0
    let iEntry = 0
    for (let k = 0; k < count; k++) {
        const [a, b] = edges(k)
        const parts = new Array<number>(tagged.layerCount).fill(0)
        const from = (a - 0.5) * 1000
        const to = Math.max((b - 0.5) * 1000, from + MARGIN_MS)
        while (iNote < n && (ms[iNote] ?? 0) < from) iNote++
        while (iEntry < n && entry(ms[iEntry] ?? 0) <= from) iEntry++
        let best = countAt(from)
        for (;;) {
            const note = iNote < n && (ms[iNote] ?? 0) < to ? (ms[iNote] ?? 0) : Infinity
            const enters =
                iEntry < n && entry(ms[iEntry] ?? 0) < to ? entry(ms[iEntry] ?? 0) : Infinity
            if (note === Infinity && enters === Infinity) break
            const candidate = countAt(Math.min(note, enters))
            if (note <= enters) iNote++
            else iEntry++
            if (candidate[0] > best[0]) best = candidate
        }
        for (let i = best[1]; i < best[2]; i++) {
            const layer = tagged.layers[i] ?? 0
            parts[layer] = (parts[layer] ?? 0) + 1
        }
        steps.push({ a, b, count: best[0], parts })
    }
    return steps
}

/**
 * Each step [a, b) takes the most notes in a window starting in [a - 0.5 s, b - 0.5 s), under
 * the window rule; its split is that window's, the earliest of equally busy ones.
 * The count rises only when a note enters, so the candidates are the range's first start, every
 * note start in it and the start just after each note enters. O(n + steps).
 */
export const skyline = (tagged: Tagged, x0: number, x1: number, count = 300): Span[] => {
    const width = (x1 - x0) / count
    return sweep(tagged, count, (k) => {
        const a = x0 + k * width
        return [a, a + width]
    })
}

/**
 * Rolling's steps `first` to `first + count - 1` of `width` from 00:00.000. Each edge comes from
 * its own index, so a step is the same window whichever steps are around it.
 */
export const anchoredSkyline = (tagged: Tagged, first: number, count: number, width: number) =>
    sweep(tagged, count, (k) => [(first + k) * width, (first + k + 1) * width])

// --- Bars: bins anchored at 00:00.000, a time within 1e-6 ms before a boundary in the later bin.

const BIN_WIDTHS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
const MAX_BINS = 150

const binOf = (time: number, width: number) =>
    Math.floor((time * 1000 + MARGIN_MS) / (width * 1000))

/** The smallest width that keeps the chart to 150 bins or fewer, from the timeline's end. */
export const binWidth = (end: number) => {
    for (const width of BIN_WIDTHS) if (binOf(end, width) + 1 <= MAX_BINS) return width
    let width = 3600
    while (binOf(end, width) + 1 > MAX_BINS) width *= 2
    return width
}

/**
 * Each bin's count and split; a bar's height is its count over the width. With a view, only the
 * bins that overlap it, still on multiples of the width from 00:00.000.
 */
export const bars = (
    tagged: Tagged,
    end: number,
    width = binWidth(Math.max(0, end)),
    view?: View,
) => {
    const first = view ? Math.max(0, Math.floor(view.x0 / width)) : 0
    const last = view
        ? Math.max(first, Math.ceil(view.x1 / width) - 1)
        : binOf(Math.max(0, end), width)
    const bins: Span[] = Array.from({ length: last - first + 1 }, (_, k) => ({
        a: (first + k) * width,
        b: (first + k + 1) * width,
        count: 0,
        parts: new Array<number>(tagged.layerCount).fill(0),
    }))
    for (let i = 0; i < tagged.times.length; i++) {
        const bin = bins[Math.max(0, binOf(tagged.times[i] ?? 0, width)) - first]
        if (!bin) continue
        const layer = tagged.layers[i] ?? 0
        bin.count++
        bin.parts[layer] = (bin.parts[layer] ?? 0) + 1
    }
    return { width, bins }
}

/** The bin under a time: the plot runs over whole bins, so every place has one. */
export const binAt = (bins: Span[], width: number, time: number) =>
    bins[
        Math.min(
            bins.length - 1,
            Math.max(0, binOf(time, width) - Math.round((bins[0]?.a ?? 0) / width)),
        )
    ]

// --- The chart in one mode, as drawn: the times of its points and each layer's boundary there.

export type ChartMode = 'smooth' | 'bars' | 'rolling'

/** The timeline's three modes, and the distribution: the seconds spent at each Rolling count. */
export type StatisticsView = ChartMode | 'distribution'

/** A stretch of the timeline in seconds. */
export type View = { x0: number; x1: number }

export type ChartModel = {
    x0: number
    x1: number
    /** The drawn points' times. */
    xs: Float64Array
    /** Per layer, the sum of the layers up to it at each point; the last is the total. */
    boundaries: Float64Array[]
    bins?: { width: number; bins: Span[] }
    steps?: Span[]
}

/** The smooth curve's and Rolling's timeline: the grid with its padding, to BGM End. */
export const timelineOf = (grid: Grid, bgmEnd: number | undefined) => ({
    x0: Math.min(0, grid.g0),
    x1: Math.max(grid.g0 + (grid.n - 1) * SAMPLE, bgmEnd ?? -Infinity),
})

const cumulate = (layers: Float64Array[], length: number) => {
    const out: Float64Array[] = []
    let sum = new Float64Array(length)
    for (const layer of layers) {
        sum = sum.map((value, i) => value + (layer[i] ?? 0))
        out.push(sum)
    }
    return out
}

/** Spans drawn flat across their width, each layer's part divided by `per`. */
const flat = (spans: Span[], layerCount: number, per: number) => ({
    xs: Float64Array.from(spans.flatMap((span) => [span.a, span.b])),
    boundaries: cumulate(
        Array.from({ length: layerCount }, (_, j) => {
            const layer = new Float64Array(spans.length * 2)
            spans.forEach((span, i) => {
                layer[2 * i] = layer[2 * i + 1] = (span.parts[j] ?? 0) / per
            })
            return layer
        }),
        spans.length * 2,
    ),
})

/** What every view of the chosen categories draws from; the costly parts are made once, when needed. */
export type ChartSource = {
    grid: Grid
    /** Bars' end: the latest time, or BGM End when later. */
    end: number
    bgmEnd: number | undefined
    tagged: () => Tagged
    samples: () => Samples
}

/**
 * `every` is every category's times (the grid and the timeline follow the chart, never the
 * selection); `chosen` is the chosen categories' times.
 */
export const chartSource = (
    every: Times,
    chosen: readonly Float64Array[],
    bgmEnd?: number,
    grid = gridOf(every),
): ChartSource | undefined => {
    if (!grid) return undefined
    let end = bgmEnd ?? 0
    for (const time of every) end = Math.max(end, time)
    let tagged: Tagged | undefined
    let samples: Samples | undefined
    return {
        grid,
        end,
        bgmEnd,
        tagged: () => (tagged ??= mergeTimes(chosen)),
        samples: () => (samples ??= curveSamples(chosen, grid)),
    }
}

/** The whole timeline of a mode: Bars' whole bins from 00:00.000, else the grid's. */
export const chartExtent = (mode: ChartMode, source: ChartSource): View => {
    if (mode !== 'bars') return timelineOf(source.grid, source.bgmEnd)
    const width = binWidth(Math.max(0, source.end))
    return { x0: 0, x1: (binOf(Math.max(0, source.end), width) + 1) * width }
}

// While a gesture zooms far out before its resolution settles, Rolling draws at most this many
// steps, coarsened by powers of two so a pan keeps the same steps.
const MAX_STEPS = 1200

/**
 * The chart in one mode over `view`, or the whole timeline without one. `columns` is the plot's
 * width times two, for Smooth. Rolling's steps and Bars' bins take their width from
 * `resolutionSpan`, anchored at multiples of it from 00:00.000, and those overlapping the view are
 * drawn whole.
 */
export const chartView = (
    mode: ChartMode,
    source: ChartSource,
    columns: number,
    view?: View,
    resolutionSpan?: number,
): ChartModel => {
    const extent = chartExtent(mode, source)
    const { x0, x1 } = view ?? extent
    const span = resolutionSpan ?? extent.x1 - extent.x0
    if (mode === 'bars') {
        const tagged = source.tagged()
        const result = view
            ? bars(tagged, source.end, binWidth(span), view)
            : bars(tagged, source.end)
        return { x0, x1, ...flat(result.bins, tagged.layerCount, result.width), bins: result }
    }
    if (mode === 'rolling') {
        const tagged = source.tagged()
        let steps: Span[]
        if (view) {
            let width = span / 300
            while ((x1 - x0) / width > MAX_STEPS) width *= 2
            const first = Math.floor(x0 / width)
            const last = Math.max(first + 1, Math.ceil(x1 / width))
            steps = anchoredSkyline(tagged, first, last - first, width)
        } else steps = skyline(tagged, x0, x1)
        return { x0, x1, ...flat(steps, tagged.layerCount, 1), steps }
    }
    const { centres, values } = curveColumns(source.samples(), x0, x1, Math.max(2, columns))
    // A flat half-column at each end, so the drawn area is the number of notes.
    const parts = values.map((layer) => {
        const out = new Float64Array(layer.length + 2)
        out.set(layer, 1)
        out[0] = layer[0] ?? 0
        out[out.length - 1] = layer[layer.length - 1] ?? 0
        return out
    })
    return {
        x0,
        x1,
        xs: Float64Array.from([x0, ...centres, x1]),
        boundaries: cumulate(parts, centres.length + 2),
    }
}

/** The whole chart for the chosen categories in one mode, as `chartSource` and `chartView` make it. */
export const chartModel = (
    mode: ChartMode,
    every: Times,
    chosen: readonly Float64Array[],
    bgmEnd: number | undefined,
    columns: number,
): ChartModel | undefined => {
    if (!every.length) return undefined
    const source = chartSource(every, chosen, bgmEnd)
    return source && chartView(mode, source, columns)
}

// --- The axes.

/** Each unit times each power of ten from `10 ** from` up, whole numbers only. */
function* niceSteps(units: readonly number[], from: number) {
    for (let exponent = Math.max(0, from); ; exponent++)
        for (const unit of units) {
            const step = unit * 10 ** exponent
            if (Number.isInteger(step)) yield step
        }
}

/**
 * The y step and top: the first step of 1, 2 or 5 times a power of ten that reaches `top` in at
 * most `max` steps, unless `max + 1` steps of 1, 2, 2.5 or 5 times a power of ten reach a lower
 * top. Steps are whole numbers, so Rolling's and 1 s Bars' counts sit on gridlines.
 */
export const yScale = (top: number, max = 4) => {
    const from = Math.floor(Math.log10(top)) - 1
    let a = 1
    for (const step of niceSteps([1, 2, 5], from))
        if (Math.ceil(top / step) <= max) {
            a = step
            break
        }
    let b = 1
    for (const step of niceSteps([1, 2, 2.5, 5], from))
        if (Math.ceil(top / step) <= max + 1) {
            b = step
            break
        }
    const topA = Math.ceil(top / a) * a
    const topB = Math.ceil(top / b) * b
    return topB < topA - 1e-9 ? { step: b, top: topB } : { step: a, top: topA }
}

function* timeSteps() {
    yield* [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]
    for (const hours of niceSteps([1, 2, 5], 0)) yield hours * 3600
}

/**
 * The x labels over [x0, x1]: multiples of the first step that keeps at most `budget` of them,
 * from the first at or after 00:00.
 */
export const timeTicks = (x1: number, budget: number, x0 = 0) => {
    const from = Math.max(0, x0)
    let step = 1
    for (const value of timeSteps())
        if (Math.floor(x1 / value) - Math.ceil(from / value) + 1 <= budget) {
            step = value
            break
        }
    const out: number[] = []
    for (let k = Math.ceil(from / step); k * step <= x1; k++) out.push(k * step)
    return out
}

/** Rounds parts to one decimal by largest remainder, so they add up to the total as shown. */
export const roundParts = (parts: readonly number[], total: number) => {
    const want = Math.round(total * 10)
    const tenths = parts.map((part) => Math.floor(part * 10 + 1e-9))
    let left = want - tenths.reduce((sum, value) => sum + value, 0)
    const order = parts
        .map((part, i) => [part * 10 - (tenths[i] ?? 0), i] as const)
        .sort((a, b) => b[0] - a[0])
    for (let k = 0; left > 0 && k < order.length; k++, left--) {
        const index = order[k]?.[1] ?? 0
        tenths[index] = (tenths[index] ?? 0) + 1
    }
    return tenths.map((value) => value / 10)
}

// --- Text.

// Narrow conjunctions: "Tap, Flick, Release" in English and "タップ、フリック" in Japanese. The unit
// style drops the separators in Chinese, Japanese, Korean and Turkish. The long style reads inside
// a sentence: "BGM and SFX".
const lists = new Map<string, Intl.ListFormat>()
/** A list as the dialog joins it, with no "and" in English unless the style is long. */
export const formatList = (
    items: string[],
    locale: string,
    style: 'narrow' | 'long' = 'narrow',
) => {
    const tag = languageTag(locale)
    let format = lists.get(`${tag} ${style}`)
    if (!format) {
        format = new Intl.ListFormat(tag, { type: 'conjunction', style })
        lists.set(`${tag} ${style}`, format)
    }
    return format.format(items)
}

export type StatisticsStrings = {
    combo: string
    rows: Record<Row, string>
    categories: Record<Category, string>
    /** "{1} ({0} critical)": the critical count first, so the plural form follows it. */
    withCritical: string
    notesPerSecond: string
    noNotes: string
    average: string
    median: string
    p90: string
    p99: string
    /** The chosen ones of Tap and Flick, joined: "Tap & Flick" when both or neither are chosen. */
    primary: string
    all: string
    /** "{0} ({1})": Tap and Flick's figure, then All's. */
    withAll: string
    firstComboNote: string
    lastComboNote: string
    lastNote: string
    bgmEnd: string
    textLine: string
}

/** A row's value as Copy Text gives it: with its critical count where it has a breakdown. */
export const breakdownOf = (stats: ChartStatistics, row: Row) => {
    const critical = stats.critical[row]
    const count = stats.counts[row]
    return critical === undefined || !count ? undefined : { normal: count - critical, critical }
}

export type TextRow = { label: string; value: string }

export type FigureRow = TextRow & {
    key: keyof Figures
    /** The bubble's lines: Tap and Flick, then All when chosen notes of another category exist. */
    lines?: TextRow[]
    /** The row as Copy Text and the status line give it, the pair spelled out. */
    text?: string
}

/**
 * The four figures' rows: "<tap and flick> (<all>)" when chosen notes of other categories exist,
 * Tap and Flick's at zero when they have none; else one value, which both share. With no figures,
 * their values are empty and the labels stay.
 */
export const figureRows = (
    figures: NpsFigures | undefined,
    strings: StatisticsStrings,
    locale: string,
): FigureRow[] =>
    (['average', 'median', 'p90', 'p99'] as const).map((key) => {
        const label = strings[key]
        if (!figures) return { key, label, value: '' }
        const format = (set: Figures) =>
            key === 'average' ? formatTenths(set.average, locale) : formatCount(set[key], locale)
        const primary = format(figures.primary)
        const all = format(figures.all)
        const line = (row: TextRow) => fill(strings.textLine, [row.label, row.value], locale)
        const pair = figures.hasSecondary
        const lines = [{ label: strings.primary, value: primary }]
        if (pair) lines.push({ label: strings.all, value: all })
        return {
            key,
            label,
            value: pair ? fill(strings.withAll, [primary, all], locale) : all,
            lines,
            text: line({ label, value: pair ? formatList(lines.map(line), locale) : all }),
        }
    })

/** The times' rows: each shown only when its time is known. */
export const timeRows = (
    stats: ChartStatistics,
    bgmEnd: number | undefined,
    strings: StatisticsStrings,
): TextRow[] =>
    (
        [
            [strings.firstComboNote, stats.firstComboNote],
            [strings.lastComboNote, stats.lastComboNote],
            [strings.lastNote, stats.lastNote],
            [strings.bgmEnd, bgmEnd],
        ] as const
    ).flatMap(([label, time]) => (time === undefined ? [] : [{ label, value: formatTime(time) }]))

/** Copy Text: one line per figure in the dialog's order, the title first when there is one. */
export const copyTextLines = (
    input: {
        title: string
        stats: ChartStatistics
        chosen: readonly Category[]
        figures: NpsFigures | undefined
        bgmEnd: number | undefined
    },
    strings: StatisticsStrings,
    locale: string,
) => {
    const { stats, figures } = input
    const line = ({ label, value }: TextRow) => fill(strings.textLine, [label, value], locale)
    const count = (value: number) => formatCount(value, locale)
    const out: string[] = []
    const title = input.title.trim()
    if (title) out.push(title)
    out.push(line({ label: strings.combo, value: count(stats.combo) }))
    for (const row of ROWS) {
        const split = breakdownOf(stats, row)
        const value = split
            ? fill(strings.withCritical, [split.critical, stats.counts[row]], locale)
            : count(stats.counts[row])
        out.push(line({ label: strings.rows[row], value }))
    }
    const names = CATEGORIES.filter((category) => input.chosen.includes(category)).map(
        (category) => strings.categories[category],
    )
    out.push(
        line({
            label: strings.notesPerSecond,
            value: figures ? formatList(names, locale) : strings.noNotes,
        }),
    )
    if (figures) out.push(...figureRows(figures, strings, locale).map((row) => row.text ?? ''))
    out.push(...timeRows(stats, input.bgmEnd, strings).map(line))
    return out
}
