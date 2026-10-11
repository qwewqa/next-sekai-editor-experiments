import { align, alignFraction, alignNear } from '../../utils/math'
import { roundBoundary, type GridBpm } from './bpms'

/**
 * Where beats snap: global steps of 1/division from beat 0, or, with a BPM list,
 * steps restarting at each of its bar lines (every change starts a bar).
 */
export type BeatGrid = { readonly bpms?: GridBpm[] }

export const GLOBAL_GRID: BeatGrid = Object.freeze({})

const grids = new WeakMap<GridBpm[], BeatGrid>()

/** The bar grid of a BPM list; the same list gives the same grid. */
export const toBeatGrid = (bpms: GridBpm[]): BeatGrid => {
    let grid = grids.get(bpms)
    if (!grid) {
        grid = Object.freeze({ bpms })
        grids.set(bpms, grid)
    }
    return grid
}

let lastKey = 0
const keys = new WeakMap<BeatGrid, number>()

/** A number per grid, for string cache keys. */
export const beatGridKey = (grid: BeatGrid) => {
    let key = keys.get(grid)
    if (key === undefined) {
        key = ++lastKey
        keys.set(grid, key)
    }
    return key
}

// Within this many steps a start counts as on the global grid, as alignNear does.
const TOLERANCE = 1e-6
// Bars of a smaller meter would hold no lines; such a segment restarts only at its change.
const TINY_METER = 2e-6

/** Under 2^32 steps; past them float spacing reaches the tolerance and line searches would stall. */
export const isWithinGridSteps = (beat: number, division: number) =>
    Math.abs(beat * division) < 2 ** 32

const stepError = (value: number, division: number) =>
    Math.abs(value * division - Math.round(value * division))

const fastPaths = new WeakMap<GridBpm[], Map<number, boolean>>()

/** Every bar starts on the global grid, so the grid is the global one. */
export const isGlobalGrid = (grid: BeatGrid, division: number) => {
    const bpms = grid.bpms
    if (!bpms) return true
    let byDivision = fastPaths.get(bpms)
    if (!byDivision) {
        byDivision = new Map()
        fastPaths.set(bpms, byDivision)
    }
    let result = byDivision.get(division)
    if (result === undefined) {
        result = bpms.every((bpm, index) => {
            const error = stepError(bpm.x, division)
            if (!(error < TOLERANCE)) return false
            const next = bpms[index + 1]?.x ?? Number.POSITIVE_INFINITY
            if (bpm.meter < TINY_METER || !(bpm.x + bpm.meter < next)) return true
            // Bars drift from the change by their meter's error per bar; bounded, not walked.
            const meterError = stepError(bpm.meter, division)
            if (meterError === 0) return error + 1e-9 < TOLERANCE
            const bars = Math.ceil((next - bpm.x) / bpm.meter) + 1
            return error + bars * meterError + 1e-9 < TOLERANCE
        })
        byDivision.set(division, result)
    }
    return result
}

type Interval = { i: number; k: number; s: number; e: number; next: number }

const intervalAt = (bpms: GridBpm[], i: number, k: number): Interval => {
    const first = bpms[0]?.x ?? Number.POSITIVE_INFINITY
    const bpm = bpms[i]
    if (!bpm) return { i: -1, k: 0, s: Number.NEGATIVE_INFINITY, e: first, next: first }
    const next = bpms[i + 1]?.x ?? Number.POSITIVE_INFINITY
    if (bpm.meter < TINY_METER) return { i, k: 0, s: bpm.x, e: next, next }
    // As getMeasureBeats places bars.
    return {
        i,
        k,
        s: bpm.x + k * bpm.meter,
        e: Math.min(bpm.x + (k + 1) * bpm.meter, next),
        next,
    }
}

// The last change at or before the beat: of same-beat changes, the last governs.
const lastAtOrBefore = (bpms: GridBpm[], beat: number) => {
    let lo = 0
    let hi = bpms.length
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if (bpms[mid]!.x <= beat) lo = mid + 1
        else hi = mid
    }
    return lo - 1
}

const locate = (bpms: GridBpm[], beat: number) => {
    const i = lastAtOrBefore(bpms, beat)
    const bpm = bpms[i]
    if (!bpm) return intervalAt(bpms, -1, 0)
    let interval = intervalAt(
        bpms,
        i,
        bpm.meter < TINY_METER ? 0 : Math.floor(roundBoundary((beat - bpm.x) / bpm.meter)),
    )
    // A bar rounded onto the next change belongs to it.
    while (interval.s >= interval.next && interval.i + 1 < bpms.length)
        interval = intervalAt(bpms, interval.i + 1, 0)
    return interval
}

const nextInterval = (bpms: GridBpm[], interval: Interval) => {
    if (interval.i < 0) return bpms.length ? intervalAt(bpms, 0, 0) : undefined
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { x, meter } = bpms[interval.i]!
    if (meter >= TINY_METER && x + (interval.k + 1) * meter < interval.next)
        return intervalAt(bpms, interval.i, interval.k + 1)
    return interval.i + 1 < bpms.length ? intervalAt(bpms, interval.i + 1, 0) : undefined
}

const previousInterval = (bpms: GridBpm[], interval: Interval) => {
    if (interval.i < 0) return undefined
    if (interval.k > 0) return intervalAt(bpms, interval.i, interval.k - 1)
    if (interval.i === 0) return intervalAt(bpms, -1, 0)
    const j = interval.i - 1
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { x, meter } = bpms[j]!
    if (meter < TINY_METER) return intervalAt(bpms, j, 0)
    const end = interval.s
    return intervalAt(bpms, j, Math.max(0, Math.ceil(roundBoundary((end - x) / meter)) - 1))
}

const isOnGrid = (interval: Interval, division: number) =>
    interval.s === Number.NEGATIVE_INFINITY || stepError(interval.s, division) < TOLERANCE

// On-grid intervals use global lines k/d, bitwise as align; off-grid ones s + n/d.
const firstLine = (interval: Interval, division: number) => {
    if (interval.s === Number.NEGATIVE_INFINITY) return Number.NEGATIVE_INFINITY
    const epsilon = TOLERANCE / division
    if (!(interval.e - interval.s >= epsilon)) return undefined
    const line = isOnGrid(interval, division)
        ? Math.round(interval.s * division) / division
        : interval.s
    return line < interval.e - epsilon ? line : undefined
}

const lastLine = (interval: Interval, division: number) => {
    if (firstLine(interval, division) === undefined) return undefined
    if (interval.e === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY
    const end = interval.e - TOLERANCE / division
    if (isOnGrid(interval, division)) {
        let k = Math.ceil(end * division) - 1
        while ((k + 1) / division < end) k++
        while (k / division >= end) k--
        return k / division
    }
    let n = Math.ceil((end - interval.s) * division) - 1
    while (interval.s + (n + 1) / division < end) n++
    while (n > 0 && interval.s + n / division >= end) n--
    return interval.s + n / division
}

const roundIn = (interval: Interval, beat: number, division: number) =>
    isOnGrid(interval, division)
        ? Math.round(beat * division) / division
        : interval.s + Math.round((beat - interval.s) * division) / division

// The smallest line of the interval's lattice at or after the beat.
const ceilIn = (interval: Interval, beat: number, division: number) => {
    if (isOnGrid(interval, division)) {
        let k = Math.ceil(beat * division)
        while ((k - 1) / division >= beat) k--
        while (k / division < beat) k++
        return k / division
    }
    let n = Math.max(0, Math.ceil((beat - interval.s) * division))
    while (n > 0 && interval.s + (n - 1) / division >= beat) n--
    while (interval.s + n / division < beat) n++
    return interval.s + n / division
}

const floorIn = (interval: Interval, beat: number, division: number) => {
    if (isOnGrid(interval, division)) {
        let k = Math.floor(beat * division)
        while ((k + 1) / division <= beat) k++
        while (k / division > beat) k--
        return k / division
    }
    let n = Math.max(0, Math.floor((beat - interval.s) * division))
    while (interval.s + (n + 1) / division <= beat) n++
    while (n > 0 && interval.s + n / division > beat) n--
    return interval.s + n / division
}

const nextFirstLine = (bpms: GridBpm[], interval: Interval, division: number) => {
    for (let next = nextInterval(bpms, interval); next; next = nextInterval(bpms, next)) {
        const line = firstLine(next, division)
        if (line !== undefined) return line
    }
    return undefined
}

const previousLastLine = (bpms: GridBpm[], interval: Interval, division: number) => {
    for (
        let previous = previousInterval(bpms, interval);
        previous;
        previous = previousInterval(bpms, previous)
    ) {
        const line = lastLine(previous, division)
        if (line !== undefined) return line
    }
    return undefined
}

/** The nearest line of a BPM list's bar grid; ties go to the later line. */
export const snapPhasedBeat = (bpms: GridBpm[], beat: number, division: number) => {
    if (!isWithinGridSteps(beat, division)) return beat
    const interval = locate(bpms, beat)
    const first = firstLine(interval, division)
    const last = lastLine(interval, division)
    const rounded = first === undefined ? undefined : roundIn(interval, beat, division)
    if (
        rounded !== undefined &&
        first !== undefined &&
        last !== undefined &&
        beat >= first &&
        beat <= last &&
        rounded >= first &&
        rounded <= last
    )
        return rounded

    const candidates: (number | undefined)[] = []
    if (first !== undefined && last !== undefined) candidates.push(beat < first ? first : last)
    if (
        first === undefined ||
        last === undefined ||
        beat > last ||
        (rounded !== undefined && rounded > last)
    ) {
        const next = nextFirstLine(bpms, interval, division)
        // The interval's own rounding onto the next start is that line, bitwise as align.
        if (rounded !== undefined && rounded === next) return rounded
        candidates.push(next)
    }
    if (first === undefined || beat < first) {
        const previous = previousLastLine(bpms, interval, division)
        if (rounded !== undefined && rounded === previous) return rounded
        candidates.push(previous)
    }
    let best: number | undefined
    for (const candidate of candidates) {
        if (candidate === undefined) continue
        const distance = Math.abs(candidate - beat)
        if (
            best === undefined ||
            distance < Math.abs(best - beat) ||
            (distance === Math.abs(best - beat) && candidate > best)
        )
            best = candidate
    }
    return best ?? align(beat, division)
}

/** The grid line nearest the beat; ties go to the later line. */
export const snapBeat = (grid: BeatGrid, beat: number, division: number) =>
    grid.bpms && !isGlobalGrid(grid, division)
        ? snapPhasedBeat(grid.bpms, beat, division)
        : align(beat, division)

/** A beat within rounding error of a line, as that line; else as alignNear. */
export const nearGridBeat = (grid: BeatGrid, beat: number, division: number) => {
    if (!grid.bpms || isGlobalGrid(grid, division)) return alignNear(beat, division)
    const line = snapPhasedBeat(grid.bpms, beat, division)
    return Math.abs(line - beat) * division < TOLERANCE ? line : alignNear(beat, division)
}

/**
 * A beat within rounding error of a line of the first grid that has one, as that line;
 * else as alignNear. Later grids pair moved beats with content placed on other grids.
 */
export const nearGridsBeat = (grids: BeatGrid[], beat: number, division: number) => {
    for (const grid of grids) {
        const line = snapBeat(grid, beat, division)
        if (Math.abs(line - beat) * division < TOLERANCE) return line
    }
    return alignNear(beat, division)
}

/** A computed beat without float noise: on a small fraction, then on a grid's line. */
export const cleanBeat = (grids: BeatGrid[], beat: number, division: number) => {
    const aligned = alignFraction(beat)
    return isWithinGridSteps(aligned, division) ? nearGridsBeat(grids, aligned, division) : aligned
}

/** Beats this close may clean onto one line at the division, so they are one beat up to noise. */
export const isNoiseApart = (a: number, b: number, division = 1) =>
    // alignFraction moves each up to 1e-11 first.
    Math.abs(a - b) < 2 * (TOLERANCE / division + 1e-11)

/** The first line at or after the beat. */
export const ceilGridBeat = (grid: BeatGrid, beat: number, division: number) => {
    if (!isWithinGridSteps(beat, division)) return beat
    const bpms = grid.bpms
    if (!bpms || isGlobalGrid(grid, division)) return ceilIn(intervalAt([], -1, 0), beat, division)
    for (
        let interval: Interval | undefined = locate(bpms, beat);
        interval;
        interval = nextInterval(bpms, interval)
    ) {
        const first = firstLine(interval, division)
        const last = lastLine(interval, division)
        if (first === undefined || last === undefined || last < beat) continue
        if (beat <= first) return first
        const line = ceilIn(interval, beat, division)
        if (line <= last) return line
    }
    return Number.POSITIVE_INFINITY
}

/** The last line at or before the beat. */
export const floorGridBeat = (grid: BeatGrid, beat: number, division: number) => {
    if (!isWithinGridSteps(beat, division)) return beat
    const bpms = grid.bpms
    if (!bpms || isGlobalGrid(grid, division)) return floorIn(intervalAt([], -1, 0), beat, division)
    const located = locate(bpms, beat)
    // The next bar's first line can sit just below its start, so at or before the beat.
    const next = nextFirstLine(bpms, located, division)
    if (next !== undefined && next <= beat) return next
    for (
        let interval: Interval | undefined = located;
        interval;
        interval = previousInterval(bpms, interval)
    ) {
        const first = firstLine(interval, division)
        const last = lastLine(interval, division)
        if (first === undefined || last === undefined || first > beat) continue
        if (beat >= last) return last
        const line = floorIn(interval, beat, division)
        if (line >= first) return line
    }
    return Number.NEGATIVE_INFINITY
}

/**
 * A step to the next or previous line: from a line, the adjacent line; off the
 * grid, one step relatively.
 */
export const stepGridBeat = (grid: BeatGrid, beat: number, division: number, direction: 1 | -1) => {
    if (!grid.bpms || isGlobalGrid(grid, division) || !isWithinGridSteps(beat, division))
        return alignNear(beat + direction / division, division)
    const line = snapPhasedBeat(grid.bpms, beat, division)
    if (Math.abs(line - beat) * division >= TOLERANCE)
        return nearGridBeat(grid, beat + direction / division, division)
    // Lines are more than the tolerance apart.
    const offset = TOLERANCE / division / 2
    return direction > 0
        ? ceilGridBeat(grid, line + offset, division)
        : floorGridBeat(grid, line - offset, division)
}

type GridLine = { beat: number; isBeat: boolean }

/**
 * The lines from min to max, with those a whole beat from their bar; undefined
 * past the limit of lines or bars.
 */
export const gridLines = (
    grid: BeatGrid,
    min: number,
    max: number,
    division: number,
    limit: number,
): GridLine[] | undefined => {
    if (!isWithinGridSteps(min, division) || !isWithinGridSteps(max, division)) return []
    const lines: GridLine[] = []
    // Bars meeting at the tolerance can both hold a line; it's drawn once.
    const push = (beat: number, isBeat: boolean) => {
        const last = lines.at(-1)
        if (last?.beat === beat) last.isBeat ||= isBeat
        else lines.push({ beat, isBeat })
    }
    const bpms = grid.bpms
    // Beat lines need whole-beat bars too.
    if (!bpms || (isGlobalGrid(grid, division) && isGlobalGrid(grid, 1))) {
        const first = Math.ceil(min * division)
        const last = Math.floor(max * division)
        if (last - first >= limit) return undefined
        for (let i = first; i <= last; i++)
            lines.push({ beat: i / division, isBeat: i % division === 0 })
        return lines
    }
    let visited = 0
    for (
        let interval: Interval | undefined = locate(bpms, min);
        // An on-grid bar's first line can sit just below its start.
        interval && interval.s - TOLERANCE / division <= max;
        interval = nextInterval(bpms, interval)
    ) {
        if (++visited > limit) return undefined
        const first = firstLine(interval, division)
        const last = lastLine(interval, division)
        if (first === undefined || last === undefined) continue
        const end = Math.min(last, max)
        if (isOnGrid(interval, division)) {
            const origin =
                interval.s === Number.NEGATIVE_INFINITY ? 0 : Math.round(interval.s * division)
            let k = Math.round(Math.max(first, ceilIn(interval, min, division)) * division)
            for (; k / division <= end; k++) {
                if (lines.length >= limit) return undefined
                push(k / division, (((k - origin) % division) + division) % division === 0)
            }
        } else {
            const start = Math.max(first, ceilIn(interval, min, division))
            let n = Math.round((start - interval.s) * division)
            for (; interval.s + n / division <= end; n++) {
                if (lines.length >= limit) return undefined
                push(interval.s + n / division, n % division === 0)
            }
        }
    }
    return lines
}
