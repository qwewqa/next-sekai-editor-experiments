export const clamp = (value: number, min = 0, max = 1) => Math.min(Math.max(value, min), max)

/**
 * The smallest and largest of some values, by a loop: `Math.min(...values)` throws a RangeError
 * for an array of some hundred thousand. Empty gives Infinity and -Infinity, as the spreads do.
 */
export const extentOf = (values: Iterable<number>) => {
    let min = Infinity
    let max = -Infinity
    for (const value of values) {
        if (value < min) min = value
        if (value > max) max = value
    }
    return { min, max }
}

export const lerp = (x: number, y: number, s: number) => x + s * (y - x)

export const unlerp = (a: number, b: number, x: number) => (x - a) / (b - a)

export const remap = (a: number, b: number, c: number, d: number, x: number) =>
    lerp(c, d, unlerp(a, b, x))

// The engine's safe_unlerp: spans under 1e-6 take a fixed fraction.
export const safeUnlerp = (a: number, b: number, x: number, fallback = 0.5) =>
    Math.abs(a - b) < 1e-6 ? fallback : unlerp(a, b, x)

export const safeUnlerpClamped = (a: number, b: number, x: number, fallback = 0.5) =>
    Math.abs(a - b) < 1e-6 ? fallback : clamp(unlerp(a, b, x))

export const align = (value: number, division = 1) => Math.round(value * division) / division

// Snaps values within rounding error of the grid; values off the grid stay.
export const alignNear = (value: number, division = 1) => {
    const aligned = align(value, division)
    return Math.abs(value - aligned) * division < 1e-6 ? aligned : value
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
        if (!(q <= max)) return value
        // Integer over integer rounds once, as k / division does for a placed beat.
        if (Math.abs(fraction - p / q) <= epsilon) return (whole * q + p) / q
        ;[p0, q0, p1, q1] = [p1, q1, p, q]
        rest = 1 / (rest - a)
    }
}

// Snaps the float noise of a lane or size computed from others; keeps 1/256 and 1/100 steps.
export const alignComputed = (value: number) => alignNear(value, 6400)

// A value shifted by delta, without float noise; unshifted, it stays exact.
export const shiftComputed = (value: number, delta: number) =>
    delta === 0 ? value : alignComputed(value + delta)

/** Equal up to floating-point noise; NaN equals NaN. */
export const nearlyEqual = (a: number, b: number, epsilon = 1e-9) =>
    Object.is(a, b) || Math.abs(a - b) <= epsilon

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
