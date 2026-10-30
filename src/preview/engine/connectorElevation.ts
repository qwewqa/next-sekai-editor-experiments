import { CONNECTOR_CURVE_ERROR } from './connectorCurve'
import { EaseType, clamp, lerp, type EaseTypeValue, type Vec } from './math'

const { turns, offsets } = (() => {
    // Derivative zeros of the SDK Back/Elastic curves, with compound joins.
    const roots = (
        rate: number,
        frequency: number,
        phase: number,
        lower: number,
        upper: number,
    ) => {
        const result: number[] = []
        const angle = Math.atan2(-frequency, rate)
        for (let index = -30; index <= 30; index++) {
            const point = (angle + index * Math.PI - phase) / frequency
            if (lower < point && point < upper) result.push(point)
        }
        return result
    }
    const rate = 10 * Math.log(2)
    const c4 = (2 * Math.PI) / 3
    const c5 = (2 * Math.PI) / 4.5
    const back = (2 * 1.70158) / (3 * 2.70158)
    const backInOut = (2 * (1.70158 * 1.525)) / (3 * (1.70158 * 1.525 + 1))
    const rows = [
        [back],
        [1 - back],
        [backInOut / 2, 0.5, 1 - backInOut / 2],
        [(1 - back) / 2, 0.5, (1 + back) / 2],
        // Zero crossings expose the small lobes beside pinned endpoints.
        [0.025, ...roots(rate, 10 * c4, -10.75 * c4, 0, 1)],
        [...roots(-rate, 10 * c4, -0.75 * c4, 0, 1), 0.975],
        [
            ...roots(2 * rate, 20 * c5, -11.125 * c5, 0, 0.5),
            0.5,
            ...roots(-2 * rate, 20 * c5, -11.125 * c5, 0.5, 1),
        ],
        [
            ...roots(-2 * rate, 20 * c4, -0.75 * c4, 0, 0.5),
            0.5,
            ...roots(2 * rate, 20 * c4, -20.75 * c4, 0.5, 1),
        ],
    ]
    const turns: number[] = []
    const offsets = [0]
    for (const row of rows) {
        turns.push(...row.map(Math.fround))
        offsets.push(turns.length)
    }
    return { turns, offsets }
})()

export type ElevationConnectorSample = {
    edges: readonly Vec[]
    rotation: number
}

// Match elevation_connector_fracs in sekai/lib/connector.py.
export const elevationConnectorFracs = (
    sample: (fraction: number) => ElevationConnectorSample,
    quality: number,
    minimumDetail = 0,
    easeType: EaseTypeValue = EaseType.linear,
    startEaseFrac = 0,
    endEaseFrac = 1,
) => {
    if (quality <= 0) return [1]
    const toleranceSquared = (CONNECTOR_CURVE_ERROR / (2 * quality * quality)) ** 2
    const fractions: number[] = []
    const stack: {
        fraction: number
        sample: ElevationConnectorSample
        middle: ElevationConnectorSample
        depth: number
    }[] = []
    let firstFraction = 0
    let first = sample(0)
    let turnFirst = 0
    let turnEnd = 0
    if (
        easeType >= EaseType.inBack &&
        easeType <= EaseType.outInElastic &&
        startEaseFrac !== endEaseFrac
    ) {
        const index = easeType - EaseType.inBack
        turnFirst = offsets[index] ?? 0
        turnEnd = offsets[index + 1] ?? 0
        const lower = Math.min(startEaseFrac, endEaseFrac)
        const upper = Math.max(startEaseFrac, endEaseFrac)
        while (turnFirst < turnEnd && (turns[turnFirst] ?? 0) <= lower) turnFirst++
        while (turnFirst < turnEnd && (turns[turnEnd - 1] ?? 0) >= upper) turnEnd--
    }
    const direction = endEaseFrac < startEaseFrac ? -1 : 1
    let turnIndex = direction > 0 ? turnFirst : turnEnd - 1
    for (let remainingTurns = turnEnd - turnFirst; remainingTurns >= 0; remainingTurns--) {
        let end = 1
        if (remainingTurns > 0) {
            end = ((turns[turnIndex] ?? 0) - startEaseFrac) / (endEaseFrac - startEaseFrac)
            turnIndex += direction
        }
        stack.push({
            fraction: end,
            sample: sample(end),
            middle: sample((firstFraction + end) / 2),
            depth: 0,
        })
        while (stack.length) {
            const last = stack.pop()
            if (!last) break
            let error = 0
            const leftMiddle = sample(lerp(firstFraction, last.fraction, 0.25))
            const rightMiddle = sample(lerp(firstFraction, last.fraction, 0.75))
            const probes = [leftMiddle, last.middle, rightMiddle]
            const rotations = [
                first.rotation,
                last.sample.rotation,
                ...probes.map((p) => p.rotation),
            ]
            let ordered = true
            for (const [index, start] of first.edges.entries()) {
                const end = last.sample.edges[index]
                if (!end) continue
                const dx = end.x - start.x
                const dy = end.y - start.y
                const lengthSquared = dx * dx + dy * dy
                let previous = 0
                for (const current of probes) {
                    const edge = current.edges[index]
                    if (!edge) continue
                    const px = edge.x - start.x
                    const py = edge.y - start.y
                    const projection = lengthSquared > 0 ? (px * dx + py * dy) / lengthSquared : 0
                    if (projection < previous - 1e-12 || projection > 1 + 1e-12) ordered = false
                    previous = projection
                    const fraction = clamp(projection, 0, 1)
                    error = Math.max(error, (px - dx * fraction) ** 2 + (py - dy * fraction) ** 2)
                }
            }
            if (
                (error <= toleranceSquared &&
                    ordered &&
                    Math.max(...rotations) - Math.min(...rotations) <= Math.PI / 4 &&
                    (last.fraction - firstFraction) * minimumDetail <= 1) ||
                last.depth >= 16
            ) {
                fractions.push(last.fraction)
                firstFraction = last.fraction
                first = last.sample
            } else if (fractions.length + stack.length + remainingTurns + 2 > 128) {
                // Cover the full curve when the adaptive budget is exhausted.
                return Array.from({ length: 128 }, (_, index) => (index + 1) / 128)
            } else {
                // Parent quarter samples become the children's midpoints.
                stack.push({ ...last, middle: rightMiddle, depth: last.depth + 1 })
                stack.push({
                    fraction: (firstFraction + last.fraction) / 2,
                    sample: last.middle,
                    middle: leftMiddle,
                    depth: last.depth + 1,
                })
            }
        }
    }
    return fractions
}
