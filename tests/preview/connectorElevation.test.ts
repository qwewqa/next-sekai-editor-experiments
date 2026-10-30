import assert from 'node:assert/strict'
import test from 'node:test'
import { elevationConnectorFracs } from '../../src/preview/engine/connectorElevation'
import {
    approach,
    createLayout,
    createViewport,
    defaultCameraInfo,
    elevationProjection,
    perspectiveVec,
} from '../../src/preview/engine/layout'
import { applyAffine, ease, EaseType, type Vec } from '../../src/preview/engine/math'
import { turningKinds, turningRoots } from './connector-turns.fixture'

const distanceToSegment = (point: Vec, start: Vec, end: Vec) => {
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (!length) return Math.hypot(point.x - start.x, point.y - start.y)
    const along = ((point.x - start.x) * dx + (point.y - start.y) * dy) / length
    if (along < 0) return Math.hypot(point.x - start.x, point.y - start.y)
    if (along > length) return Math.hypot(point.x - end.x, point.y - end.y)
    return Math.abs((point.x - start.x) * dy - (point.y - start.y) * dx) / length
}

test('circular elevation loops avoid thin pieces while following both projected edges', () => {
    const layout = createLayout(createViewport(1920, 1080), defaultCameraInfo(), false)
    const duration = 0.35 + 3.65 * ((12 - 6) / 11) ** 1.31
    const anchors = [
        [0, 0],
        [-4, 4],
        [0, 8],
        [4, 4],
        [0, 0],
    ] as const
    let pieces = 0
    let thin = 0
    for (let loop = 0; loop < 6; loop++) {
        const travel = approach(layout, 1 - (2 + loop * 0.25 - 1.75) / duration)
        for (let segment = 0; segment < 4; segment++) {
            const first = anchors[segment]
            const last = anchors[segment + 1]
            assert.ok(first && last)
            const curve = segment % 2 ? EaseType.inCirc : EaseType.outCirc
            const sample = (fraction: number) => {
                const lane = first[0] + (last[0] - first[0]) * ease(curve, fraction)
                const projection = elevationProjection(
                    layout,
                    first[1] + (last[1] - first[1]) * fraction,
                )
                const edges = [-2, 2].map((side) =>
                    applyAffine(projection, perspectiveVec(layout, lane + side, 1, travel)),
                )
                return { edges: [...edges, ...edges], rotation: 0 }
            }
            const fractions = elevationConnectorFracs(sample, 1)
            pieces += fractions.length
            let previous = 0
            for (const fraction of fractions) {
                const start = sample(previous).edges
                const end = sample(fraction).edges
                const ys = [...start, ...end].map((edge) => edge.y)
                if ((Math.max(...ys) - Math.min(...ys)) * 540 < 1) thin++
                for (let step = 1; step < 128; step++) {
                    const actual = sample(previous + ((fraction - previous) * step) / 128).edges
                    for (const side of [0, 1]) {
                        const point = actual[side]
                        const a = start[side]
                        const b = end[side]
                        assert.ok(point && a && b)
                        assert.ok(distanceToSegment(point, a, b) * 540 < 1.1)
                    }
                }
                previous = fraction
            }
            assert.equal(previous, 1)
        }
    }
    assert.ok(pieces < 300, `${pieces} pieces`)
    assert.ok(thin < 50, `${thin} pieces below one pixel`)
})

test('elevation sampling reuses each parent midpoint and quarter sample', () => {
    const calls: number[] = []
    const fractions = elevationConnectorFracs((fraction) => {
        calls.push(fraction)
        return { edges: [{ x: fraction ** 2, y: fraction }], rotation: 0 }
    }, 1)
    assert.ok(fractions.length > 1)
    assert.equal(calls.length, 4 * fractions.length + 1)
    assert.equal(new Set(calls).size, calls.length)
})

test('nonlinear travel along a straight elevation edge needs one segment', () => {
    assert.deepEqual(
        elevationConnectorFracs(
            (fraction) => ({
                edges: [{ x: ease(EaseType.inCirc, fraction), y: 0 }],
                rotation: 0,
            }),
            1,
        ),
        [1],
    )
})

test('opposite edge retracing within the chord remains subdivided', () => {
    const sample = (fraction: number) => ({
        edges: [
            { x: fraction, y: 0 },
            { x: fraction + 0.4 * Math.sin(2 * Math.PI * fraction), y: 0.1 },
        ],
        rotation: 0,
    })
    const fractions = elevationConnectorFracs(sample, 1)
    assert.ok(fractions.length > 1)
    const xs = [0, ...fractions].map((fraction) => sample(fraction).edges[1]?.x ?? NaN)
    assert.ok(xs.some((value, index) => index > 0 && value < (xs[index - 1] ?? -Infinity)))
})

test('elevation sampling retains alpha density even on geometrically straight edges', () => {
    const fractions = elevationConnectorFracs(
        (fraction) => ({ edges: [{ x: fraction, y: 0 }], rotation: 0 }),
        1,
        96,
    )
    let previous = 0
    for (const fraction of fractions) {
        assert.ok((fraction - previous) * 96 <= 1)
        previous = fraction
    }
    assert.equal(previous, 1)
    assert.ok(fractions.length <= 128)
})

test('unwrapped rotation prevents quarter samples aliasing four complete turns', () => {
    const fractions = elevationConnectorFracs(
        (fraction) => ({
            edges: [
                {
                    x: 0.1 * Math.cos(8 * Math.PI * fraction),
                    y: 0.1 * Math.sin(8 * Math.PI * fraction),
                },
            ],
            rotation: 8 * Math.PI * fraction,
        }),
        1,
    )
    assert.ok(fractions.length >= 32)
    let previous = 0
    for (const fraction of fractions) {
        assert.ok((fraction - previous) * 8 * Math.PI <= Math.PI / 4)
        previous = fraction
    }
    assert.equal(previous, 1)
})

test('adaptive budget overflow switches to uniform complete-span coverage', () => {
    const fractions = elevationConnectorFracs(
        (fraction) => ({
            edges: [{ x: Math.sin(fraction * 128 * Math.PI), y: fraction }],
            rotation: fraction * 128 * Math.PI,
        }),
        1,
    )
    assert.deepEqual(
        fractions,
        Array.from({ length: 128 }, (_, index) => (index + 1) / 128),
    )
})

test('raw edges trigger refinement even when mask-clipped edges collapse', () => {
    const fractions = elevationConnectorFracs(
        (fraction) => ({
            edges: [
                { x: 0, y: 0 },
                { x: 0, y: 0 },
                { x: fraction ** 2, y: fraction },
                { x: fraction ** 2 + 0.01, y: fraction },
            ],
            rotation: 0,
        }),
        1,
    )
    assert.ok(fractions.length > 1)
    assert.equal(fractions.at(-1), 1)
})

test('straight elevation connectors need one segment and disabled quality stays bounded', () => {
    const sample = (fraction: number) => ({ edges: [{ x: fraction, y: fraction }], rotation: 0 })
    assert.deepEqual(elevationConnectorFracs(sample, 1), [1])
    assert.deepEqual(elevationConnectorFracs(sample, 0), [1])
})

test('turn partitions match engine float32 roots through clipped and reversed boundaries', () => {
    for (const [index, kind] of turningKinds.entries()) {
        const roots = turningRoots[index]
        assert.ok(roots)
        const domains = [
            [0, 1],
            [1, 0],
            [0.137, 0.923],
            [0.923, 0.137],
            [0.5, 0.5],
        ]
        for (const root of roots)
            domains.push(
                [root, 1],
                [1, root],
                [0, root],
                [root, 0],
                [root - 1e-7, root + 1e-7],
                [root + 1e-7, root - 1e-7],
            )
        for (const domain of domains) {
            const [start, end] = domain
            assert.ok(start !== undefined && end !== undefined)
            const calls: number[] = []
            const fractions = elevationConnectorFracs(
                (fraction) => {
                    calls.push(fraction)
                    return { edges: [{ x: fraction, y: 0 }], rotation: 0 }
                },
                1,
                0,
                kind,
                start,
                end,
            )
            const expected = roots
                .filter((root) => root > Math.min(start, end) && root < Math.max(start, end))
                .map((root) => (root - start) / (end - start))
                .sort((a, b) => a - b)
            assert.deepEqual(fractions, [...expected, 1], `${kind}/${start}/${end}`)
            assert.equal(calls.length, 4 * fractions.length + 1)
            assert.equal(new Set(calls).size, calls.length)
        }
    }
})

test('global budget overflow covers the full curve while later turns remain pending', () => {
    for (const kind of turningKinds) {
        for (const [start, end] of [
            [0, 1],
            [1, 0],
        ] as const) {
            const calls: number[] = []
            const fractions = elevationConnectorFracs(
                (fraction) => {
                    calls.push(fraction)
                    return { edges: [{ x: fraction, y: 0 }], rotation: 0 }
                },
                1,
                1e6,
                kind,
                start,
                end,
            )
            assert.deepEqual(
                fractions,
                Array.from({ length: 128 }, (_, index) => (index + 1) / 128),
            )
            assert.ok(
                Math.max(...calls) < 1,
                'fallback occurred before sampling the last root span',
            )
        }
    }
})
