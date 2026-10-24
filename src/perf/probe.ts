declare const __NSE_PERF__: boolean

/**
 * Perf builds only (`NSE_PERF=1`, docs/performance-testing.md): per-frame timings that
 * `scripts/perf` reads. Other builds define the flag false, so `timed` returns its callback.
 */
export const PERF = typeof __NSE_PERF__ === 'boolean' && __NSE_PERF__

/** Durations in ms per probe name, collected while `on`. */
export const perfSamples = { on: false, samples: {} as Record<string, number[]> }

const record = (name: string, start: number) => {
    ;(perfSamples.samples[name] ??= []).push(performance.now() - start)
}

/** `fn`, timed under `name` in perf builds while a run collects. */
export const timed = <A extends unknown[], R>(
    name: string,
    fn: (...args: A) => R,
): ((...args: A) => R) =>
    PERF
        ? (...args) => {
              if (!perfSamples.on) return fn(...args)
              const start = performance.now()
              try {
                  return fn(...args)
              } finally {
                  record(name, start)
              }
          }
        : fn

/** `done`, timed from now until it runs, under `name` in perf builds while a run collects. */
export const timedSince = (name: string, done: () => void): (() => void) => {
    if (!PERF || !perfSamples.on) return done
    const start = performance.now()
    return () => {
        done()
        record(name, start)
    }
}
