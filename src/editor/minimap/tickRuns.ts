import type { MinimapMapping } from './mapping'

// The merge behind the change ticks, apart from the painter so Node tests can load it.

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

/** One merged run of changed rows, in CSS px from the canvas top. */
export type TickRun = { top: number; height: number }

/** The runs that get a full-width hairline: only short ones, and only while there are few runs. */
export const hairlineRuns = (runs: readonly TickRun[]): TickRun[] =>
    runs.length > HAIRLINE_MAX_RUNS ? [] : runs.filter((run) => run.height < HAIRLINE_MAX_RUN)

/**
 * Merges places sorted by time into runs of rows, in one pass. Calls `emit(top, height)` in CSS px
 * for each run, from the bottom of the strip up.
 */
export const tickRuns = (
    places: readonly { time: number }[],
    mapping: MinimapMapping,
    emit: (top: number, height: number) => void,
) => {
    const gap = MERGE_DEVICE_PX / mapping.geometry.scale
    let low = NaN
    let high = NaN
    const flush = () => {
        if (Number.isNaN(low)) return
        const height = Math.max(high - low, MIN_TICK_HEIGHT)
        emit((low + high - height) / 2, height)
    }
    for (const { time } of places) {
        const y = mapping.timeToY(time)
        if (!Number.isNaN(low) && low - y <= gap && y - high <= gap) {
            if (y < low) low = y
            if (y > high) high = y
            continue
        }
        flush()
        low = high = y
    }
    flush()
}
