// A seeded random source for the property test and the fuzzers (mulberry32), standing in for
// fast-check until the lead installs it: replayable by seed, no shrinking.

export type Random = {
    /** An integer in 0 … n − 1. */
    int: (n: number) => number
    /** A float in [0, 1). */
    next: () => number
}

export const random = (seed: number): Random => {
    let state = seed >>> 0 || 1
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    return { next, int: (n) => Math.floor(next() * n) }
}
