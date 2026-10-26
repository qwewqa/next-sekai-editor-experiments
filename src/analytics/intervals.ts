import { capSeconds } from './catalogue'

// The bookkeeping behind the `perf` event's interval figures (field.ts), apart from the browser so
// that tests can drive it. Each piece is bounded and runs on a change or at a send, never per frame.

export type FrameState = 'playing' | 'busy' | 'other'

/** The most state changes kept. */
const LOG_LIMIT = 64

/**
 * When the editor's state changed, so a long frame the browser reports later is sorted by the
 * state it began in, not the state at delivery. Times are `performance.now()` values.
 */
export const createStateLog = (initial: FrameState, at: number) => {
    const log: { at: number; state: FrameState }[] = [{ at, state: initial }]
    return {
        set: (state: FrameState, time: number) => {
            if (log.at(-1)?.state === state) return
            log.push({ at: time, state })
            if (log.length > LOG_LIMIT) log.shift()
        },
        /** The state at `time`; undefined when the log no longer reaches back that far. */
        at: (time: number): FrameState | undefined => {
            let found: FrameState | undefined
            for (const entry of log) {
                if (entry.at > time) break
                found = entry.state
            }
            return found
        },
        /** Forgets what precedes the state in force at `time`: later entries start no earlier. */
        trim: (time: number) => {
            while (log.length > 1 && (log[1]?.at ?? Infinity) <= time) log.shift()
        },
        size: () => log.length,
    }
}

/**
 * A value that can change within an interval: the one value it held, or `mixed` when it held
 * more. `take` closes the interval and opens the next one with the value now.
 */
export const createSpan = <T extends string>(first: T) => {
    const seen = new Set<T>([first])
    return {
        see: (value: T) => {
            seen.add(value)
        },
        take: (now: T): T | 'mixed' => {
            seen.add(now)
            const [only] = seen
            const value = seen.size === 1 && only !== undefined ? only : 'mixed'
            seen.clear()
            seen.add(now)
            return value
        },
    }
}

/**
 * The whole seconds to report for a running total, and the total counted as sent. The part of a
 * second left over stays unsent, so short spans add up across sends instead of rounding away.
 */
export const takeSeconds = (totalMs: number, sentMs: number) => {
    const seconds = capSeconds(totalMs - sentMs)
    return { seconds, sent: sentMs + seconds * 1000 }
}
