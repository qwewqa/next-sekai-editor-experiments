import { addDecimal } from '../../utils/math'

/** A number field's limits for arrow steps. */
export type StepLimits = {
    min?: number
    max?: number
    /** `min` stands in for "above 0", so steps never stop at it. */
    exclusiveMin?: boolean
    /** A numeric step snaps values off its grid, from `min`, as native steps do. */
    step?: number | 'any'
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
