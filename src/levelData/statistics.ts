import { languageTag, pluralForm } from '../i18n/plural'
import type { Bgm } from '../state/bgm'
import { beatToTicks, scheduleHiddenTicks } from '../state/entities/slides/hiddenTicks'
import { getNoteRole, type SlideNoteInfo } from '../state/entities/slides/semantics'
import { beatToTime, type BpmIntegral } from '../state/integrals/bpms'
import type { Store } from '../state/store'
import { formatTime } from '../utils/format'
import { formatCount, formatTenths } from '../utils/size'

// Statistics: the chart's counts by what the player does, its times, and the Notes per
// Second chart's three modes and four figures. The dialog and the share card both draw from
// here, so the two always agree.

/** The breakdown's rows, in display order. Fake Note is outside Combo. */
export const ROWS = [
    'tap',
    'flick',
    'release',
    'trace',
    'traceFlick',
    'tick',
    'hiddenTick',
    'damageNote',
    'damageTick',
    'fakeNote',
] as const
export type Row = (typeof ROWS)[number]

/** The rows whose type has a critical variant; the note's own `isCritical` decides. */
export const CRITICAL_ROWS: readonly Row[] = [
    'tap',
    'flick',
    'release',
    'trace',
    'traceFlick',
    'tick',
]

/** The chart's categories, in the list's order and the stack's order from the bottom. */
export const CATEGORIES = [
    'tap',
    'flick',
    'release',
    'trace',
    'traceFlick',
    'tick',
    'damage',
] as const
export type Category = (typeof CATEGORIES)[number]

export const DEFAULT_CATEGORIES: readonly Category[] = ['tap', 'flick', 'release']

/** The chart category a scored row counts in. */
export const categoryOf = (row: Exclude<Row, 'fakeNote'>): Category =>
    row === 'hiddenTick' ? 'tick' : row === 'damageNote' || row === 'damageTick' ? 'damage' : row

/** The row of an exported note, or undefined for an anchor. Fake notes are Fake Note. */
export const classifyNote = (info: SlideNoteInfo): Row | undefined => {
    const role = getNoteRole(info)
    if (role === 'anchor') return undefined
    if (info.note.isFake) return 'fakeNote'
    const isFlick = info.note.flickDirection !== 'none'
    switch (role) {
        case 'damage':
            return 'damageNote'
        case 'tick':
            return 'tick'
        case 'trace':
        case 'headTrace':
        case 'tailTrace':
            return isFlick ? 'traceFlick' : 'trace'
        case 'tail':
            return isFlick ? 'flick' : 'release'
        case 'single':
        case 'head':
            return isFlick ? 'flick' : 'tap'
    }
}

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
            const row = classifyNote(info)
            if (row === undefined) continue
            counts[row]++
            if (row === 'fakeNote') continue
            if (info.note.isCritical && critical[row] !== undefined) critical[row]++
            beats[categoryOf(row)].push(info.note.beat)
        }
        for (const tick of scheduleHiddenTicks(infos)) {
            const row = tick.connectorType === 'active' ? 'hiddenTick' : 'damageTick'
            counts[row]++
            beats[categoryOf(row)].push(tick.tick / beatToTicks)
        }
    }

    let first = Infinity
    let last = -Infinity
    const times = Object.fromEntries(
        CATEGORIES.map((category) => {
            const list = Float64Array.from(beats[category], (beat) => beatToTime(bpms, beat)).sort()
            // Absurd BPMs can make times infinite or NaN: only finite times are shown.
            for (const time of list)
                if (Number.isFinite(time)) {
                    first = Math.min(first, time)
                    last = Math.max(last, time)
                }
            return [category, list]
        }),
    ) as Record<Category, Float64Array>

    let combo = 0
    for (const row of ROWS) if (row !== 'fakeNote') combo += counts[row]
    const lastNote = lastBeat === -Infinity ? NaN : beatToTime(bpms, lastBeat)
    return {
        counts,
        critical,
        combo,
        times,
        firstComboNote: first === Infinity ? undefined : first,
        lastComboNote: last === -Infinity ? undefined : last,
        lastNote: Number.isFinite(lastNote) ? lastNote : undefined,
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
export type Tagged = { times: Float64Array; layers: Uint8Array; count: number }

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
    return { times, layers, count: lists.length }
}

// Times a chart reaches only at absurd BPMs: past 2^53 samples of 50 ms the grid loses precision.
const LIMIT = 2 ** 53 * 0.05

/** Whether the chart's times can be drawn: all finite and within the grid's precision. */
export const representable = (stats: ChartStatistics, bgmEnd: number | undefined) =>
    CATEGORIES.every((category) =>
        stats.times[category].every((time) => Number.isFinite(time) && Math.abs(time) < LIMIT),
    ) &&
    (bgmEnd === undefined || Math.abs(bgmEnd) < LIMIT)

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

export type Figures = { average: number; median: number; p90: number; p99: number; active: number }

/**
 * The four figures, of the Rolling count r(s) over the time it is above 0: Average is the
 * notes over that time; the percentiles are time-weighted, whole numbers.
 */
export const rollingFigures = (times: Times): Figures | undefined => {
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
    const values = [...at.keys()].sort((a, b) => a - b)
    const percentile = (p: number) => {
        let sum = 0
        for (const value of values) {
            sum += at.get(value) ?? 0
            if (sum >= p * active - 1e-9) return value
        }
        return values[values.length - 1] ?? 0
    }
    return {
        average: n / (active / 1000),
        median: percentile(0.5),
        p90: percentile(0.9),
        p99: percentile(0.99),
        active: active / 1000,
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
type Grid = { g0: number; n: number; segments: [number, number][] }

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

/** One layer's samples over the whole grid, for checks on small charts. */
export const denseSamples = (samples: Samples, layer: number) => {
    const out = new Float64Array(samples.n)
    samples.segments.forEach(([start], k) => {
        const array = samples.layers[layer]?.[k]
        if (array) out.set(array, start)
    })
    return out
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

export type Step = { a: number; b: number; count: number; parts: number[] }

/**
 * Each step [a, b) takes the most notes in a window starting in [a - 0.5 s, b - 0.5 s), from
 * 00:00.000, under the window rule; its split is that window's, the earliest of equally busy ones.
 * The count rises only when a note enters, so the candidates are the range's first start, every
 * note start in it and the start just after each note enters. O(n + steps).
 */
export const skyline = (tagged: Tagged, x0: number, x1: number, count = 300): Step[] => {
    const ms = Float64Array.from(tagged.times, (time) => time * 1000)
    const n = ms.length
    let lo = 0
    let hi = 0
    let last = -Infinity
    const countAt = (start: number): [number, number, number] => {
        // Candidates rise within a step; the pointers restart for steps clamped to 00:00.000.
        if (start < last) {
            lo = 0
            hi = 0
        }
        last = start
        while (lo < n && (ms[lo] ?? 0) < start) lo++
        if (hi < lo) hi = lo
        while (hi < n && (ms[hi] ?? 0) < start + 1000 - MARGIN_MS) hi++
        return [hi - lo, lo, hi]
    }
    const entry = (time: number) => time - 1000 + 2 * MARGIN_MS
    const width = (x1 - x0) / count
    const steps: Step[] = []
    let iNote = 0
    let iEntry = 0
    let previousA = -Infinity
    for (let k = 0; k < count; k++) {
        const a = x0 + k * width
        const b = a + width
        const parts = new Array<number>(tagged.count).fill(0)
        if (b <= 0) {
            steps.push({ a, b, count: 0, parts })
            continue
        }
        const from = Math.max(0, (a - 0.5) * 1000)
        const to = Math.max((b - 0.5) * 1000, from + MARGIN_MS)
        if (from <= previousA) {
            iNote = 0
            iEntry = 0
        }
        previousA = from
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

export type Bin = { a: number; b: number; count: number; parts: number[] }

/** Each bin's count and split; a bar's height is its count over the width. */
export const bars = (tagged: Tagged, end: number) => {
    const timelineEnd = Math.max(0, end)
    const width = binWidth(timelineEnd)
    const bins: Bin[] = Array.from({ length: binOf(timelineEnd, width) + 1 }, (_, k) => ({
        a: k * width,
        b: (k + 1) * width,
        count: 0,
        parts: new Array<number>(tagged.count).fill(0),
    }))
    for (let i = 0; i < tagged.times.length; i++) {
        const bin = bins[Math.max(0, binOf(tagged.times[i] ?? 0, width))]
        if (!bin) continue
        const layer = tagged.layers[i] ?? 0
        bin.count++
        bin.parts[layer] = (bin.parts[layer] ?? 0) + 1
    }
    return { width, bins }
}

/** The bin under a time: the plot runs over whole bins, so every place has one. */
export const binAt = (bins: Bin[], width: number, time: number) =>
    bins[Math.min(bins.length - 1, Math.max(0, binOf(time, width)))]

// --- The chart in one mode, as drawn: the times of its points and each layer's boundary there.

export type ChartMode = 'smooth' | 'bars' | 'rolling'
export const CHART_MODES: readonly ChartMode[] = ['smooth', 'bars', 'rolling']

export type ChartModel = {
    mode: ChartMode
    x0: number
    x1: number
    /** The drawn points' times. */
    xs: Float64Array
    /** Per layer, the sum of the layers up to it at each point; the last is the total. */
    boundaries: Float64Array[]
    bins?: { width: number; bins: Bin[] }
    steps?: Step[]
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

/**
 * The chart for the chosen categories in one mode. `every` is every category's times (the
 * grid and the timeline follow the chart, never the selection); `columns` is the plot's
 * width times two, for Smooth.
 */
export const chartModel = (
    mode: ChartMode,
    every: Times,
    chosen: readonly Float64Array[],
    bgmEnd: number | undefined,
    columns: number,
): ChartModel | undefined => {
    const grid = gridOf(every)
    if (!grid) return undefined
    const tagged = mergeTimes(chosen)
    if (mode === 'bars') {
        let end = bgmEnd ?? 0
        for (const time of every) end = Math.max(end, time)
        const result = bars(tagged, end)
        const parts = chosen.map((_, j) => {
            const layer = new Float64Array(result.bins.length * 2)
            result.bins.forEach((bin, i) => {
                layer[2 * i] = layer[2 * i + 1] = (bin.parts[j] ?? 0) / result.width
            })
            return layer
        })
        return {
            mode,
            x0: 0,
            x1: result.bins.length * result.width,
            xs: Float64Array.from(result.bins.flatMap((bin) => [bin.a, bin.b])),
            boundaries: cumulate(parts, result.bins.length * 2),
            bins: result,
        }
    }
    const { x0, x1 } = timelineOf(grid, bgmEnd)
    if (mode === 'rolling') {
        const steps = skyline(tagged, x0, x1)
        const parts = chosen.map((_, j) => {
            const layer = new Float64Array(steps.length * 2)
            steps.forEach((step, i) => {
                layer[2 * i] = layer[2 * i + 1] = step.parts[j] ?? 0
            })
            return layer
        })
        return {
            mode,
            x0,
            x1,
            xs: Float64Array.from(steps.flatMap((step) => [step.a, step.b])),
            boundaries: cumulate(parts, steps.length * 2),
            steps,
        }
    }
    const { centres, values } = curveColumns(
        curveSamples(chosen, grid),
        x0,
        x1,
        Math.max(2, columns),
    )
    // A flat half-column at each end, so the drawn area is the number of notes.
    const parts = values.map((layer) => {
        const out = new Float64Array(layer.length + 2)
        out.set(layer, 1)
        out[0] = layer[0] ?? 0
        out[out.length - 1] = layer[layer.length - 1] ?? 0
        return out
    })
    return {
        mode,
        x0,
        x1,
        xs: Float64Array.from([x0, ...centres, x1]),
        boundaries: cumulate(parts, centres.length + 2),
    }
}

// --- The axes.

function* niceSteps(units: readonly number[], from: number) {
    for (let exponent = from; ; exponent++) for (const unit of units) yield unit * 10 ** exponent
}

/**
 * The y step and top: the first step of 1, 2 or 5 times a power of ten that reaches `top` in at
 * most `max` steps, unless `max + 1` steps of 1, 2, 2.5 or 5 reach a lower top.
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

/** The x labels from 00:00 at the first step that keeps at most `budget` of them. */
export const timeTicks = (x1: number, budget: number) => {
    let step = 1
    for (const value of timeSteps())
        if (Math.floor(x1 / value) + 1 <= budget) {
            step = value
            break
        }
    const out: number[] = []
    for (let k = 0; k * step <= x1; k++) out.push(k * step)
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
// style drops the separators in Chinese, Japanese, Korean and Turkish.
const lists = new Map<string, Intl.ListFormat>()
/** A list as the dialog joins it, with no "and" in English. */
export const formatList = (items: string[], locale: string) => {
    const tag = languageTag(locale)
    let format = lists.get(tag)
    if (!format) {
        format = new Intl.ListFormat(tag, { type: 'conjunction', style: 'narrow' })
        lists.set(tag, format)
    }
    return format.format(items)
}

/** Fills a message as `interpolate` does, in the given locale: the form follows `{0}`. */
export const fillMessage = (locale: string, message: string, ...params: (string | number)[]) =>
    pluralForm(locale, message, params[0]).replace(/\{(\d+)\}/g, (placeholder, index: string) => {
        const param = params[Number(index)]
        return typeof param === 'number' ? formatCount(param, locale) : (param ?? placeholder)
    })

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

/** Copy Text: one line per figure in the dialog's order, the title first when there is one. */
export const copyTextLines = (
    input: {
        title: string
        stats: ChartStatistics
        chosen: readonly Category[]
        figures: Figures | undefined
        bgmEnd: number | undefined
    },
    strings: StatisticsStrings,
    locale: string,
) => {
    const { stats, figures } = input
    const line = (name: string, value: string) => fillMessage(locale, strings.textLine, name, value)
    const count = (value: number) => formatCount(value, locale)
    const out: string[] = []
    const title = input.title.trim()
    if (title) out.push(title)
    out.push(line(strings.combo, count(stats.combo)))
    for (const row of ROWS) {
        const split = breakdownOf(stats, row)
        out.push(
            line(
                strings.rows[row],
                split
                    ? fillMessage(locale, strings.withCritical, split.critical, stats.counts[row])
                    : count(stats.counts[row]),
            ),
        )
    }
    const names = CATEGORIES.filter((category) => input.chosen.includes(category)).map(
        (category) => strings.categories[category],
    )
    out.push(line(strings.notesPerSecond, figures ? formatList(names, locale) : strings.noNotes))
    if (figures)
        out.push(
            line(strings.average, formatTenths(figures.average, locale)),
            line(strings.median, count(figures.median)),
            line(strings.p90, count(figures.p90)),
            line(strings.p99, count(figures.p99)),
        )
    if (stats.firstComboNote !== undefined)
        out.push(line(strings.firstComboNote, formatTime(stats.firstComboNote)))
    if (stats.lastComboNote !== undefined)
        out.push(line(strings.lastComboNote, formatTime(stats.lastComboNote)))
    if (stats.lastNote !== undefined) out.push(line(strings.lastNote, formatTime(stats.lastNote)))
    if (input.bgmEnd !== undefined) out.push(line(strings.bgmEnd, formatTime(input.bgmEnd)))
    return out
}
