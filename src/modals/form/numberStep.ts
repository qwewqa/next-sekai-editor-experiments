/** A number field's limits for arrow steps. */
export type StepLimits = {
    min?: number
    max?: number
    /** `min` stands in for "above 0", so steps never stop at it. */
    exclusiveMin?: boolean
}

// Decimal places of a number's shortest text, counting an exponent.
const decimals = (value: number) => {
    const [mantissa = '', exponent = '0'] = `${value}`.split('e')
    return Math.max(0, (mantissa.split('.')[1]?.length ?? 0) - Number(exponent))
}

/** Adds in decimal, as native number inputs step: 1.1 - 1 is 0.1. */
export const addDecimal = (value: number, delta: number) => {
    const sum = value + delta
    const places = Math.max(decimals(value), decimals(delta))
    return places > 100 ? sum : Number(sum.toFixed(places))
}

/**
 * Steps as native number inputs do: a step past a limit stops at it, and one
 * further away from a limit already passed keeps the value.
 */
export const stepNumber = (from: number, delta: number, { min, max, exclusiveMin }: StepLimits) => {
    const next = addDecimal(from, delta)
    if (min !== undefined && next < min)
        return exclusiveMin || (delta < 0 && from < min) ? from : min
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
