import type { MinimapMapping } from './mapping'

// The merge shared by the change ticks and the selection rail, kept out of the painters so Node
// tests can load it.

/** Places whose rows are this many device px apart or less share one tick. */
export const MERGE_DEVICE_PX = 2
/** The shortest tick, in CSS px. */
export const MIN_TICK_HEIGHT = 3
/** The edge tick's width, in CSS px: the tick column (PAD_LEFT, 4) and a px of the lane margin. */
export const TICK_WIDTH = 5
/** A run this tall or taller, in CSS px, gets no hairline: long stretches would tint the strip. */
export const HAIRLINE_MAX_RUN = 8
/** More runs than this get no hairlines: a busy column of ticks already reads, and lines would haze. */
export const HAIRLINE_MAX_RUNS = 24
/** The hairline's opacity over the notes. */
export const HAIRLINE_ALPHA = 0.45

/** One merged run of changed rows, in CSS px from the strip top. */
export type TickRun = { top: number; height: number }

type Emit = (top: number, height: number) => void

/** The runs that get a full-width hairline: only short ones, and only while there are few runs. */
export const hairlineRuns = (runs: readonly TickRun[]): TickRun[] =>
    runs.length > HAIRLINE_MAX_RUNS ? [] : runs.filter((run) => run.height < HAIRLINE_MAX_RUN)

/**
 * The one merge rule: rows in CSS px, added in order down or up the strip, become runs. Calls
 * `emit(top, height)` in CSS px for each run, in the order added.
 */
export const createRunMerger = (scale: number, emit: Emit) => {
    const gap = MERGE_DEVICE_PX / scale
    let low = NaN
    let high = NaN
    const flush = () => {
        if (Number.isNaN(low)) return
        const height = Math.max(high - low, MIN_TICK_HEIGHT)
        emit((low + high - height) / 2, height)
    }
    return {
        add(y: number) {
            if (!Number.isNaN(low) && low - y <= gap && y - high <= gap) {
                if (y < low) low = y
                if (y > high) high = y
                return
            }
            flush()
            low = high = y
        },
        end() {
            flush()
            low = high = NaN
        },
    }
}

/**
 * Merges places sorted by time into runs of rows, in one pass. Calls `emit(top, height)` in CSS px
 * for each run, from the bottom of the strip up.
 */
export const tickRuns = (
    places: readonly { time: number }[],
    mapping: MinimapMapping,
    emit: Emit,
) => {
    const merger = createRunMerger(mapping.geometry.scale, emit)
    for (const { time } of places) merger.add(mapping.timeToY(time))
    merger.end()
}

/**
 * Rows in any order, kept per device row as its lowest and highest. Those two stand in for every
 * row between them, because a device row's rows are under a device px apart, so in sorted order
 * they merge as all of them do, and `runs` gives the runs the sorted rows would.
 */
export const createRowSpread = (capacity: number) => {
    const lows = new Float64Array(capacity).fill(Infinity)
    const highs = new Float64Array(capacity).fill(-Infinity)
    let scale = 1
    let first = capacity
    let last = -1
    return {
        reset(next: number) {
            if (last >= first) {
                lows.fill(Infinity, first, last + 1)
                highs.fill(-Infinity, first, last + 1)
            }
            scale = next
            first = capacity
            last = -1
        },
        add(y: number) {
            const row = Math.min(capacity - 1, Math.max(0, Math.floor(y * scale)))
            if (y < (lows[row] ?? Infinity)) lows[row] = y
            if (y > (highs[row] ?? -Infinity)) highs[row] = y
            if (row < first) first = row
            if (row > last) last = row
        },
        /** From the top of the strip down. */
        runs(emit: Emit) {
            const merger = createRunMerger(scale, emit)
            for (let row = first; row <= last; row++) {
                const low = lows[row] ?? Infinity
                if (low === Infinity) continue
                merger.add(low)
                const high = highs[row] ?? low
                if (high !== low) merger.add(high)
            }
            merger.end()
        },
    }
}
