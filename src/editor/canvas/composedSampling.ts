import type { BpmIntegral } from '../../state/integrals/bpms'
import { beatToTime, timeToBeat } from '../../state/integrals/bpms'

export type ComposedSample = { time: number; left: number; size: number }

// Each seed probes three points, so 8 seeds sample as densely as 16 midpoints; the finest step is unchanged.
const SEEDS = 8
const DEPTH = 11

/** Sample smooth stretches separately, retaining both limits at every event jump. */
export const sampleComposed = <T extends { left: number; size: number }>(
    bpms: BpmIntegral[],
    breaks: readonly number[],
    at: (beat: number, rightLimit: boolean) => T,
    options: { coordinates?: (point: T) => readonly number[]; maxTimeStep?: number } = {},
): (T & { time: number })[][] => {
    type Point = T & { time: number }
    const strips: Point[][] = []
    const sample = (time: number, rightLimit: boolean) => ({
        ...at(timeToBeat(bpms, time), rightLimit),
        time,
    })
    // Largest distance, in lanes, of a sample from the chord at fraction u.
    const deviation = (point: Point, a: Point, b: Point, u: number) => {
        const chord = (start: number, end: number) => start + (end - start) * u
        let error = Math.max(
            Math.abs(point.left - chord(a.left, b.left)),
            Math.abs(point.left + point.size - chord(a.left + a.size, b.left + b.size)),
        )
        if (options.coordinates) {
            const aValues = options.coordinates(a)
            const bValues = options.coordinates(b)
            for (const [index, value] of options.coordinates(point).entries()) {
                const start = aValues[index]
                const end = bValues[index]
                if (start === undefined || end === undefined) continue
                error = Math.max(error, Math.abs(value - chord(start, end)))
            }
        }
        return error
    }
    for (let index = 1; index < breaks.length; index++) {
        const fromBeat = breaks[index - 1]
        const toBeat = breaks[index]
        if (fromBeat === undefined || toBeat === undefined) continue
        const from = beatToTime(bpms, fromBeat)
        const to = beatToTime(bpms, toBeat)
        // Strips within the jump tolerance would draw a jump as a horizontal line.
        if (!(to - from > Math.max(1, Math.abs(to)) * 2 ** -21)) continue
        let previous = { ...at(fromBeat, true), time: from }
        const points = [previous]
        // Quarter points catch curves a matching midpoint hides; they become the halves' midpoints.
        const append = (a: Point, b: Point, depth: number, middle?: Point) => {
            if (depth >= DEPTH) {
                points.push(b)
                return
            }
            middle ??= sample((a.time + b.time) / 2, false)
            let first: Point | undefined
            let second: Point | undefined
            let split =
                b.time - a.time > (options.maxTimeStep ?? Infinity) ||
                deviation(middle, a, b, 0.5) > 0.01
            if (!split) {
                first = sample((a.time + middle.time) / 2, false)
                second = sample((middle.time + b.time) / 2, false)
                split = deviation(first, a, b, 0.25) > 0.01 || deviation(second, a, b, 0.75) > 0.01
            }
            if (split) {
                append(a, middle, depth + 1, first)
                append(middle, b, depth + 1, second)
            } else points.push(b)
        }
        // Seed oscillating and compound eases so a coincident midpoint cannot hide a curve.
        for (let seed = 1; seed <= SEEDS; seed++) {
            const next =
                seed === SEEDS
                    ? { ...at(toBeat, false), time: to }
                    : sample(from + ((to - from) * seed) / SEEDS, false)
            append(previous, next, 0)
            previous = next
        }
        strips.push(points)
    }
    return strips
}
