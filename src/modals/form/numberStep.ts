/** A number field's limits for arrow steps. */
export type StepLimits = {
    min?: number
    max?: number
    /** `min` stands in for "above 0", so steps never stop at it. */
    exclusiveMin?: boolean
    /** A numeric step snaps values off its grid, from `min`, as native steps do. */
    step?: number | 'any'
}

/** Chromium steps a focused number input under the wheel; `userAgentData` is missing off secure origins. */
export const isChromium = (navigator: { userAgent: string }) =>
    'userAgentData' in navigator || /(Chrome|Chromium)\//.test(navigator.userAgent)

// Decimal places of a number's shortest text, counting an exponent.
const decimals = (value: number) => {
    const [mantissa = '', exponent = '0'] = `${value}`.split('e')
    return Math.max(0, (mantissa.split('.')[1]?.length ?? 0) - Number(exponent))
}

/** Adds in decimal, as native number inputs step: 1.1 - 1 is 0.1. */
export const addDecimal = (value: number, delta: number) => {
    const sum = value + delta
    // Whole numbers add exactly; skips the text work for grid labels.
    if (Number.isInteger(value) && Number.isInteger(delta)) return sum
    const places = Math.max(decimals(value), decimals(delta))
    return places > 100 ? sum : Number(sum.toFixed(places))
}

// Off the step grid, a step goes to the next grid value that way, as native steps do.
const offGrid = (from: number, delta: number, base: number, step: number) => {
    const index = (from - base) / step
    if (Number.isInteger(index)) return
    return base + (delta > 0 ? Math.ceil(index) : Math.floor(index)) * step
}

/**
 * Steps as native number inputs do: a step past a limit stops at it, and one
 * further away from a limit already passed keeps the value.
 */
export const stepNumber = (
    from: number,
    delta: number,
    { min, max, exclusiveMin, step }: StepLimits,
) => {
    const next =
        (typeof step === 'number' ? offGrid(from, delta, min ?? 0, step) : undefined) ??
        addDecimal(from, delta)
    if (min !== undefined && next < min) {
        if (exclusiveMin) return delta > 0 ? next : from
        return delta < 0 && from < min ? from : min
    }
    if (max !== undefined && next > max) return delta > 0 && from > max ? from : max
    return next
}

/** Arrow steps where a step back returns exactly where the last began, which 2/3 + 1 - 1 can't. */
export const createStepTrail = () => {
    let trail: { from: number; to: number; delta: number }[] = []
    return (from: number, delta: number, limits: StepLimits) => {
        const last = trail.at(-1)
        if (last?.to === from && last.delta === -delta) {
            trail.pop()
            return last.from
        }
        const next = stepNumber(from, delta, limits)
        // One stopped at a limit steps back as native steps do.
        if (next === addDecimal(from, delta)) trail.push({ from, to: next, delta })
        else trail = []
        return next
    }
}

/** Steps each value from where it is, `steps` or its origin; `changed` leaves out those back at their origin. */
export const stepValues = (
    origins: Map<unknown, number>,
    steps: Map<unknown, number> | undefined,
    step: (value: unknown, from: number) => number,
) => {
    const next = new Map<unknown, number>()
    for (const [value, origin] of origins) next.set(value, step(value, steps?.get(value) ?? origin))
    const changed = [...next.keys()].filter((value) => next.get(value) !== origins.get(value))
    return { next, changed }
}

/**
 * Snaps float noise off a value near a fraction with a denominator up to `max`,
 * to the fraction itself: 1/3 stepped by 1 is 4/3, as a beat placed there.
 */
export const alignFraction = (value: number, max = 10000, epsilon = 1e-11) => {
    const whole = Math.floor(value)
    const fraction = value - whole
    // Continued fraction convergents: the first within epsilon has the smallest denominator.
    let [p0, q0, p1, q1] = [0, 1, 1, 0]
    let rest = fraction
    for (;;) {
        const a = Math.floor(rest)
        const [p, q] = [a * p1 + p0, a * q1 + q0]
        if (q > max) return value
        // Integer over integer rounds once, as k / division does for a placed beat.
        if (Math.abs(fraction - p / q) <= epsilon) return (whole * q + p) / q
        ;[p0, q0, p1, q1] = [p1, q1, p, q]
        rest = 1 / (rest - a)
    }
}
