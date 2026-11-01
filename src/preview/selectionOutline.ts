import type { Quad, Vec } from './engine/math'

/** An X at a stage's rotation center, turned by `angle` (radians, y up). */
export type OutlineMarker = { point: Vec; angle: number }

export const createSelectionOutline = () => {
    const objects = new Map<object | undefined, Map<string, { a: Vec; b: Vec; count: number }>>()
    const lines: { a: Vec; b: Vec }[] = []
    const markers: OutlineMarker[] = []
    const pointKey = (point: Vec) => `${Math.round(point.x * 1e5)},${Math.round(point.y * 1e5)}`
    return {
        addLine: (a: Vec, b: Vec) => {
            lines.push({ a, b })
        },
        addMarker: (point: Vec, angle: number) => {
            markers.push({ point, angle })
        },
        add: (quad: Quad, source?: object) => {
            let edges = objects.get(source)
            if (!edges) {
                edges = new Map()
                objects.set(source, edges)
            }
            const points = [quad.bl, quad.br, quad.tr, quad.tl]
            for (const [index, a] of points.entries()) {
                const b = points[(index + 1) % 4]
                if (!b) continue
                const from = pointKey(a)
                const to = pointKey(b)
                if (from === to) continue
                const direction = from < to ? 1 : -1
                const key = [from, to].sort().join(':')
                const edge = edges.get(key)
                if (edge) edge.count += direction
                else edges.set(key, { a, b, count: direction })
            }
        },
        edges() {
            return [
                ...[...objects.values()].flatMap((edges) =>
                    [...edges.values()].filter((edge) => edge.count !== 0),
                ),
                ...lines,
            ]
        },
        markers: (): readonly OutlineMarker[] => markers,
    }
}
