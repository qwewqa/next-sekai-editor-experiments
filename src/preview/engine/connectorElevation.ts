import { CONNECTOR_CURVE_ERROR } from './connectorCurve'
import { clamp, lerp, type Vec } from './math'

export type ElevationConnectorSample = {
    edges: readonly Vec[]
    rotation: number
}

// Match elevation_connector_fracs in sekai/lib/connector.py.
export const elevationConnectorFracs = (
    sample: (fraction: number) => ElevationConnectorSample,
    quality: number,
    minimumDetail = 0,
) => {
    if (quality <= 0) return [1]
    const toleranceSquared = (CONNECTOR_CURVE_ERROR / (2 * quality * quality)) ** 2
    const fractions: number[] = []
    const stack = [{ fraction: 1, sample: sample(1), middle: sample(0.5), depth: 0 }]
    let firstFraction = 0
    let first = sample(0)
    while (stack.length) {
        const last = stack.pop()
        if (!last) break
        let error = 0
        const leftMiddle = sample(lerp(firstFraction, last.fraction, 0.25))
        const rightMiddle = sample(lerp(firstFraction, last.fraction, 0.75))
        const probes = [leftMiddle, last.middle, rightMiddle]
        const rotations = [first.rotation, last.sample.rotation, ...probes.map((p) => p.rotation)]
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
        } else if (fractions.length + stack.length + 2 > 128) {
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
    return fractions
}
