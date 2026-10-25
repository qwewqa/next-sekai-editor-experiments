/**
 * The Check dialog's bar before batch `n` of a phase, as 0 to 100. The bar slides (`undefined`)
 * until the phase's first batch is done, so a check waiting behind a Save never shows an empty
 * track, and it slides again once the phase has no batch left.
 */
export const phaseFraction = (n: number, done: number, total: number) =>
    n > 0 && total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : undefined
