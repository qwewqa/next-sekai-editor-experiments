// Pieces of Edits Here's newer-entry checks that do not touch storage: the places along the chain
// and the single-flight queue.

/**
 * Places along the chain for the matches of every check, counted from one origin: the newest
 * entry of the first scan is place 0, older entries are positive, newer ones negative. A check
 * counts positions from its own newest entry, and finds the previous check's newest entry (the
 * `until`) at `reached`; the checks before it moved the origin the same way.
 */
export const createPlaces = () => {
    // The place of the newest entry checked so far.
    let top = 0
    return {
        /** A new scan: its newest entry is the origin. */
        reset: () => {
            top = 0
        },
        /** The place of a match at `pos` in a check that reached its `until` at `reached`. */
        of: (pos: number, reached: number) => pos - reached + top,
        /** The check succeeded and its newest entry is now the one the next check stops at. */
        advance: (reached: number) => {
            top -= reached
        },
    }
}

/**
 * Runs `once` one at a time. A request while it runs makes it run once more after it, so what
 * happened meanwhile is not missed, and every caller's promise covers the runs it asked for. The
 * running flag is cleared in the same synchronous step as the last comparison: no request can
 * land between seeing that nothing is queued and being free.
 */
export const singleFlight = (once: () => Promise<void>): (() => Promise<void>) => {
    let running: Promise<void> | undefined
    let requests = 0
    return () => {
        if (running) {
            requests++
            return running
        }
        const run = (async () => {
            try {
                let seen: number
                do {
                    seen = requests
                    await once()
                } while (seen !== requests)
            } finally {
                running = undefined
            }
        })()
        running = run
        return run
    }
}
