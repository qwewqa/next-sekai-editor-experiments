/**
 * The Check dialog's fraction before batch `n` of a phase, as 0 to 100. Until the first batch is
 * done it is `undefined`, so the bar slides instead of showing an empty track. After the last batch
 * the caller passes no fraction, so the bar slides through the finish.
 */
export const phaseFraction = (n: number, done: number, total: number) =>
    n > 0 && total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : undefined
