import type { MinimapMapping } from './mapping'

// The merge behind the change ticks, apart from the painter so Node tests can load it.

/** Places whose rows are this many device px apart or less share one tick. */
export const MERGE_DEVICE_PX = 2
/** The shortest tick, in CSS px. */
export const MIN_TICK_HEIGHT = 2
/** The tick column: the strip's left edge, inside `PAD_LEFT`. */
export const TICK_WIDTH = 3

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
