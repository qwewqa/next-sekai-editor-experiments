import assert from 'node:assert/strict'
import test from 'node:test'
import { easeFromValue } from '../../src/ease'
import {
    ConnectorVisualState,
    drawConnector,
    type ConnectorEndpoint,
} from '../../src/preview/engine/connector'
import { circularConnectorFracs } from '../../src/preview/engine/connectorCurve'
import type { PreviewFrameContext } from '../../src/preview/engine/context'
import {
    approach,
    computeStageTransform,
    createLayout,
    createViewport,
    currentLayoutTransform,
    defaultCameraInfo,
    perspectiveVec,
    stageTransformToAffine,
} from '../../src/preview/engine/layout'
import {
    EaseType,
    applyAffine,
    connectorInterpFrac,
    ease,
    type EaseTypeValue,
    type Quad,
    type Vec,
} from '../../src/preview/engine/math'
import { ConnectorKind } from '../../src/preview/engine/model'
import { resolveSkin, type PreviewSkin, type Sprite } from '../../src/preview/skin'
import { turningKinds, turningRoots } from './connector-turns.fixture'

const sprite: Sprite = { u0: 0, v0: 0, u1: 1, v1: 1 }
const skin: PreviewSkin = { ...resolveSkin(() => undefined), guides: [sprite] }

const context: PreviewFrameContext = {
    now: 0,
    layout: createLayout(createViewport(1600, 900), { ...defaultCameraInfo(), stageTilt: 0 }, true),
}

const SIZE = 0.5
const head: ConnectorEndpoint = {
    lane: -3,
    size: SIZE,
    visualProgress: 0.1,
    targetTime: 2,
    easeFrac: 0,
}
const tail: ConnectorEndpoint = {
    ...head,
    lane: 3,
    visualProgress: 0.9,
    targetTime: 4,
    easeFrac: 1,
}

const draw = (
    easeType: EaseTypeValue,
    from = head,
    to = tail,
    tailAlpha = 1,
    opacity: number[] = [],
) => {
    const quads: Quad[] = []
    drawConnector(
        context,
        (_sprite, quad, _z, alpha) => {
            if (alpha > 0) {
                quads.push(quad)
                opacity.push(alpha)
            }
        },
        skin,
        ConnectorKind.guideNeutral,
        ConnectorVisualState.waiting,
        easeType,
        from,
        to,
        2,
        from.lane,
        1,
        4,
        tailAlpha,
        1,
        1,
        0,
        false,
    )
    return quads
}

test('circular endpoints avoid thin intervals and retain the bounded fallback', () => {
    const layout = { ...context.layout, wScale: 0.1 }
    for (const curve of [EaseType.inCirc, EaseType.outCirc]) {
        const fractions = circularConnectorFracs(
            layout,
            curve,
            0,
            1,
            0.1,
            0.9,
            -3,
            0.5,
            3,
            0.5,
            0,
            1,
            1,
        )
        let previous = 0
        for (const fraction of fractions) {
            const height = Math.abs(
                (approach(layout, 0.1 + fraction * 0.8) - approach(layout, 0.1 + previous * 0.8)) *
                    layout.hScale,
            )
            assert.ok(height * 540 > 1.5)
            previous = fraction
        }
        assert.equal(previous, 1)
    }
    assert.deepEqual(
        circularConnectorFracs(layout, EaseType.inCirc, 0, 1, 0.1, 0.9, -3, 0.5, 3, 0.5, 0, 1, 100),
        [],
    )
    assert.deepEqual(
        circularConnectorFracs(layout, EaseType.inCirc, 0, 1, 0.5, 0.5, 2, 0.5, 2, 0.5, 0, 1, 1),
        [1],
    )
})

test('circular fades use visual geometry and midpoint opacity', () => {
    for (const curve of [
        EaseType.inCirc,
        EaseType.outCirc,
        EaseType.inOutCirc,
        EaseType.outInCirc,
    ]) {
        const opacity: number[] = []
        const faded = draw(curve, head, tail, 0.99, opacity)
        assert.deepEqual(faded, draw(curve))
        assert.ok(opacity.some((alpha) => alpha < 0.6))
        faded.forEach((quad, index) => {
            const fractions = [quad.bl, quad.tl].map(
                (point) =>
                    ((point.y - context.layout.t) / context.layout.hScale -
                        approach(context.layout, 0.1)) /
                    (approach(context.layout, 0.9) - approach(context.layout, 0.1)),
            )
            const expected = 0.6 * (1 - (0.01 * (fractions[0]! + fractions[1]!)) / 2)
            assert.ok(
                Math.abs(opacity[index]! - expected) < 1e-10,
                `${opacity[index]} versus ${expected}; ${fractions}`,
            )
        })
        for (const quality of [0.5, 1, 2]) {
            const fractions = circularConnectorFracs(
                context.layout,
                curve,
                0,
                1,
                0.1,
                0.9,
                -3,
                0.5,
                3,
                0.5,
                0,
                1,
                quality,
            )
            assert.ok(fractions.length > 0 && fractions.length <= 128)
            let previous = 0
            for (const fraction of fractions) {
                assert.ok(fraction > previous)
                previous = fraction
            }
            assert.equal(previous, 1)
        }
    }
})

// Quads list the nearer edge first; the left edges trace the connector's left side.
const leftEdges = (quads: Quad[]) => quads.map(({ bl, tl }) => [bl, tl] as const)

test('different-stage masks retain narrow crossings between two outside samples', () => {
    const quads = draw(
        EaseType.linear,
        {
            ...head,
            lane: -5.25,
            size: 0.1,
            mask: { enabled: true, left: -0.1, right: 0.1, stageIndex: 0 },
        },
        {
            ...tail,
            lane: 4.75,
            size: 0.1,
            mask: { enabled: true, left: -0.1, right: 0.1, stageIndex: 1 },
        },
    )
    // The twenty-segment mixed-stage path samples lanes -.25 and .25,
    // both outside the mask; their interior must still produce visible quads.
    assert.ok(quads.length > 0)
    assert.ok(quads.some((quad) => quad.bl.x < 0 && quad.br.x > 0))
})

const leftAt = (lane: number, progress: number) =>
    perspectiveVec(context.layout, lane - SIZE, 1, approach(context.layout, progress))

const cross = (a: Vec, b: Vec, p: Vec) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)

const onLane = (p: Vec, lane: number) => {
    const a = leftAt(lane, head.visualProgress)
    const b = leftAt(lane, tail.visualProgress)
    return Math.abs(cross(a, b, p)) / Math.hypot(b.x - a.x, b.y - a.y) < 1e-9
}

const segmentDistance = (p: Vec, a: Vec, b: Vec) => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const t = Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0), 1)
    return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t)
}

test('connectors follow every curved ease, including overshoot and oscillation', () => {
    for (let easeType = 2; easeType <= 37; easeType++) {
        const type = easeType as EaseTypeValue
        const edges = leftEdges(draw(type))
        assert.ok(edges.length > 0, easeFromValue(type))
        let worst = 0
        for (let i = 0; i <= 2000; i++) {
            const s = i / 2000
            const p = leftAt(
                head.lane + (tail.lane - head.lane) * ease(type, s),
                head.visualProgress + (tail.visualProgress - head.visualProgress) * s,
            )
            worst = Math.max(worst, Math.min(...edges.map(([a, b]) => segmentDistance(p, a, b))))
        }
        assert.ok(worst < 3 * context.layout.screenPixelSize, `${easeFromValue(type)}: ${worst}`)
    }
})

test('steps hold their interior lane and never draw a slanted jump', () => {
    const lanes: [EaseTypeValue, number[]][] = [
        [EaseType.inStep, [head.lane]],
        [EaseType.none, [head.lane]],
        [EaseType.outStep, [tail.lane]],
        [EaseType.outInStep, [0]],
        [EaseType.inOutStep, [head.lane, tail.lane]],
    ]
    for (const [type, expected] of lanes) {
        const edges = leftEdges(draw(type))
        assert.ok(edges.length > 0)
        const used = new Set<number>()
        for (const [a, b] of edges) {
            const lane = expected.find((lane) => onLane(a, lane) && onLane(b, lane))
            assert.notEqual(lane, undefined, `${easeFromValue(type)}: slanted or misplaced`)
            used.add(lane!)
        }
        assert.equal(used.size, expected.length, easeFromValue(type))
    }
})

test('in-out steps between attached notes split only when they span the jump', () => {
    // Attached notes sit on the step's value at their own fraction.
    const late = leftEdges(draw(EaseType.inOutStep, { ...head, lane: tail.lane, easeFrac: 0.6 }))
    assert.ok(late.every(([a, b]) => onLane(a, tail.lane) && onLane(b, tail.lane)))
    const early = leftEdges(draw(EaseType.inOutStep, { ...head, easeFrac: 0.2 }))
    assert.ok(early.some(([a, b]) => onLane(a, head.lane) && onLane(b, head.lane)))
    assert.ok(early.some(([a, b]) => onLane(a, tail.lane) && onLane(b, tail.lane)))
    assert.ok(
        early.every(
            ([a, b]) =>
                (onLane(a, head.lane) && onLane(b, head.lane)) ||
                (onLane(a, tail.lane) && onLane(b, tail.lane)),
        ),
    )
    assert.equal(connectorInterpFrac(EaseType.inOutStep, 0.2, 0.8, 0.3, 0.5), 0)
    assert.equal(connectorInterpFrac(EaseType.inOutStep, 0.2, 0.8, 0.7, 0.5), 1)
    assert.equal(connectorInterpFrac(EaseType.outStep, 0, 1, 0, 0), 1)
    assert.equal(connectorInterpFrac(EaseType.outInStep, 0, 1, 1, 1), 0.5)
    assert.equal(connectorInterpFrac(EaseType.inStep, 0, 1, 0.5, 0.5), 0)
    assert.ok(connectorInterpFrac(EaseType.outBack, 0, 1, 0.5, 0.5) > 1)
    assert.ok(connectorInterpFrac(EaseType.inElastic, 0, 1, 0.9, 0.9) < 0)
})

test('NONE evaluates as IN_STEP, the editor None its ease', () => {
    assert.equal(easeFromValue(EaseType.none), 'none')
    for (const x of [-0.5, 0, 0.3, 0.5, 1, 1.5])
        assert.equal(ease(EaseType.none, x), ease(EaseType.inStep, x))
})

for (const curve of [
    EaseType.inBack,
    EaseType.outBack,
    EaseType.inOutBack,
    EaseType.outInBack,
    EaseType.inElastic,
    EaseType.outElastic,
    EaseType.inOutElastic,
    EaseType.outInElastic,
]) {
    test(`turning elevation ${curve} retains excursions between adaptive probes`, () => {
        for (const tilt of [0, 0.5, 1]) {
            const layout = createLayout(
                createViewport(1920, 1080),
                { ...defaultCameraInfo(), stageTilt: tilt },
                false,
            )
            const transform = (_q: number, u: number) =>
                computeStageTransform(
                    layout,
                    currentLayoutTransform(layout),
                    0,
                    0,
                    0,
                    0,
                    0,
                    0.05 * u,
                )
            for (const [begin, end] of [
                [0, 1],
                [1, 0],
                [0.137, 0.923],
                [0.94, 0.71],
                [0.753, 0.877],
                [0.877, 0.753],
                [0.331, 0.671],
                [0, 0.02],
                [0.98, 1],
                [0.49, 0.51],
                [0.51, 0.49],
                [0.5, 0.5],
                [0.5, 0.50000000001],
                [0, 0.33125],
                [0.66875, 1],
                [0, 0.10625],
                [0.89375, 1],
                [0.33125, 0.5],
                [0.5, 0.33125],
                [0.5, 0.66875],
                [0.66875, 0.5],
                ...(curve === EaseType.outInElastic
                    ? ([
                          [0.21200000000000002, 0.7308],
                          [0.7956, 0.2576],
                      ] as const)
                    : []),
            ] as const) {
                if (
                    curve === EaseType.outInElastic &&
                    (begin === 0.21200000000000002 || begin === 0.7956)
                ) {
                    const visibleEnd = begin + (end - begin)
                    const join = (0.5 - begin) / (visibleEnd - begin)
                    assert.ok(begin + (visibleEnd - begin) * join < 0.5)
                }
                for (const [firstSize, lastSize] of [
                    [0.5, 0.5],
                    [0.05, 1],
                    [1, 0],
                ] as const) {
                    const quads: Quad[] = []
                    drawConnector(
                        { now: 0, layout },
                        (_sprite, quad) => quads.push(quad),
                        skin,
                        ConnectorKind.guideNeutral,
                        ConnectorVisualState.waiting,
                        curve,
                        {
                            lane: -3,
                            size: firstSize,
                            visualProgress: 0.7,
                            targetTime: 1,
                            easeFrac: begin,
                            transform: transform(0, 0),
                        },
                        {
                            lane: 3,
                            size: lastSize,
                            visualProgress: 0.7,
                            targetTime: 1,
                            easeFrac: end,
                            transform: transform(1, 1),
                        },
                        1,
                        -3,
                        1,
                        1,
                        1,
                        1,
                        1,
                        0,
                        false,
                        false,
                        1,
                        transform,
                    )
                    assert.ok(quads.length > 0)
                    const travel = approach(layout, 0.7)
                    const headEased = ease(curve, begin)
                    const denominator = ease(curve, end) - headEased
                    if (
                        curve === EaseType.inElastic &&
                        begin === 0.137 &&
                        end === 0.923 &&
                        firstSize === 0.05 &&
                        lastSize === 1
                    ) {
                        const widthAt = (root: number) =>
                            firstSize +
                            ((lastSize - firstSize) * (ease(curve, root) - headEased)) / denominator
                        assert.ok(widthAt(0.41526010632514954) < 0)
                        assert.ok(widthAt(0.565260112285614) > 1)
                        assert.ok(widthAt(0.7152600884437561) < 0)
                    }
                    let maximum = 0
                    const probes = Array.from({ length: 2049 }, (_, step) => step / 2048)
                    probes.push(1e-12, 1e-9, 0.5 - 1e-12, 0.5 + 1e-12, 1 - 1e-9, 1 - 1e-12)
                    const join = (0.5 - begin) / (end - begin)
                    for (const delta of [-1e-12, 0, 1e-12])
                        if (join + delta > 0 && join + delta < 1) probes.push(join + delta)
                    const roots = turningRoots[turningKinds.indexOf(curve)]
                    assert.ok(roots)
                    for (const root of roots) {
                        const u = (root - begin) / (end - begin)
                        if (u > 0 && u < 1) probes.push(u)
                    }
                    for (const u of probes) {
                        const q =
                            Math.abs(denominator) < 1e-6
                                ? u
                                : (ease(curve, begin + (end - begin) * u) - headEased) / denominator
                        const size = firstSize + (lastSize - firstSize) * q
                        if (size <= 0) continue
                        for (const side of [-1, 1]) {
                            const point = applyAffine(
                                stageTransformToAffine(transform(q, u)),
                                perspectiveVec(layout, -3 + 6 * q + side * size, 1, travel),
                            )
                            let error = Infinity
                            for (const quad of quads)
                                error = Math.min(
                                    error,
                                    side < 0
                                        ? segmentDistance(point, quad.bl, quad.tl)
                                        : segmentDistance(point, quad.br, quad.tr),
                                )
                            maximum = Math.max(maximum, error * 540)
                        }
                    }
                    assert.ok(
                        maximum < 1.1,
                        `${tilt}/${begin}/${end}/${firstSize}/${lastSize}: ${maximum} px`,
                    )
                }
            }
        }
    })
}
