import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLayout, createViewport, defaultCameraInfo } from '../../src/preview/engine/layout'
import { EaseType, type EaseTypeValue, type Quad } from '../../src/preview/engine/math'
import type { PreviewStage } from '../../src/preview/engine/model'
import {
    crossfadeAlphas,
    drawDynamicStage,
    getStageProps,
    type StageProps,
} from '../../src/preview/engine/stage'
import type { ZKey } from '../../src/preview/gl'
import {
    resolveSkin,
    type JudgmentSpriteSet,
    type PreviewSkin,
    type Sprite,
} from '../../src/preview/skin'

// Lane background and judgment line fades are drawn as pairs whose parts add up, as "over",
// to the alpha a single sprite would have. These tests composite the recorded draws that share
// a quad, in z order, and read the result.

type Recorded = { sprite?: Sprite; quad: Quad; z: ZKey; alpha: number }

const context = {
    now: 0,
    layout: createLayout(createViewport(1600, 900), defaultCameraInfo(), true),
}

let counter = 0
const sprite = (): Sprite => ({ u0: counter++, v0: 0, u1: 1, v1: 1 })
const judgmentSet = (): JudgmentSpriteSet => ({
    background: sprite(),
    center: sprite(),
    edge: sprite(),
    edgeLeft: sprite(),
    gradient: sprite(),
    singleLine: sprite(),
})

const stage = (order = 0): PreviewStage => ({
    order,
    drawStartTime: 0,
    drawEndTime: 10,
    masks: [],
    pivots: [],
    styles: [],
    transforms: [],
    hasTransforms: false,
})

const baseProps = (extra: Partial<StageProps> = {}, order = 0): StageProps => ({
    ...getStageProps(stage(order), 0),
    width: 6,
    laneAlpha: 1,
    judgeLineAlpha: 1,
    divisionLineAlpha: 1,
    division: { start: { size: 1, parity: 0 }, end: { size: 1, parity: 0 }, progress: 0 },
    rightBorderStyle: { start: 2, end: 2, progress: 0 },
    ...extra,
})

const lane = sprite()
const laneRed = sprite()
const laneBlue = sprite()
const border = sprite()
const divider = sprite()
const setA = judgmentSet()
const setB = judgmentSet()

const skinOf = (extra: Partial<PreviewSkin> = {}): PreviewSkin => ({
    ...resolveSkin(() => undefined),
    judgments: [setA, setB],
    stageBorder: border,
    laneDivider: divider,
    laneBackground: lane,
    laneBackgrounds: [lane, lane, laneRed, lane, laneBlue, lane, lane, lane, lane],
    ...extra,
})

const record = (skin: PreviewSkin, props: StageProps) => {
    const draws: Recorded[] = []
    drawDynamicStage(
        context,
        (sprite, quad, z, alpha) => draws.push({ sprite, quad, z, alpha }),
        skin,
        props,
    )
    return draws
}

const compareZ = (a: ZKey, b: ZKey) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0)
    return 0
}

/** The draws of the given sprites, by the quad they cover. */
const byQuad = (draws: Recorded[], sprites: (Sprite | undefined)[]) => {
    const groups = new Map<string, Recorded[]>()
    for (const draw of draws) {
        if (!sprites.includes(draw.sprite)) continue
        const key = JSON.stringify(draw.quad)
        groups.set(key, [...(groups.get(key) ?? []), draw])
    }
    return [...groups.values()].map((group) => group.sort((a, b) => compareZ(a.z, b.z)))
}

/**
 * The draws composited in z order with "over", each sprite with its body alpha (1 if it has
 * none): the alpha of the result, and the share of each sprite in its color.
 */
const composite = (draws: Recorded[], bodies = new Map<Sprite, number>()) => {
    let coverage = 0
    const weights = new Map<Sprite | undefined, number>()
    for (const draw of [...draws].sort((a, b) => compareZ(a.z, b.z))) {
        assert.ok(draw.alpha >= 0 && draw.alpha <= 1, `alpha ${draw.alpha}`)
        const e = draw.alpha * (draw.sprite ? (bodies.get(draw.sprite) ?? 1) : 1)
        for (const [key, weight] of weights) weights.set(key, weight * (1 - e))
        weights.set(draw.sprite, (weights.get(draw.sprite) ?? 0) + e)
        coverage += e * (1 - coverage)
    }
    const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0)
    return {
        alpha: coverage,
        share: (...sprites: (Sprite | undefined)[]) =>
            sprites.reduce((sum, sprite) => sum + (weights.get(sprite) ?? 0), 0) / total,
    }
}

// The dividers and borders use the edge sprites too; the gradient group has the last slots.
const inGradientSlots = (draws: Recorded[]) => draws.filter(({ z }) => z[2]! >= 13)

const close = (actual: number, expected: number, message = '', tolerance = 1e-9) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} != ${expected}`)

const bodies = new Map<Sprite, number>([
    [lane, 0.4],
    [laneRed, 0.4],
    [laneBlue, 0.4],
])
const laneSprites = [lane, laneRed, laneBlue]

test('the crossfade pair adds up to the target alpha with the share asked for', () => {
    for (const body of [1, 0.4]) {
        for (const alpha of [0.2, 0.7, 1]) {
            for (const progress of [0, 0.25, 0.5, 0.9, 1]) {
                const [a, b] = crossfadeAlphas(alpha, progress, body)
                const sprites = [sprite(), sprite()] as const
                const result = composite(
                    [
                        { sprite: sprites[0], quad: {} as Quad, z: [0], alpha: a },
                        { sprite: sprites[1], quad: {} as Quad, z: [1], alpha: b },
                    ],
                    new Map([
                        [sprites[0], body],
                        [sprites[1], body],
                    ]),
                )
                close(result.alpha, body * alpha, `body ${body} alpha ${alpha} t ${progress}`)
                close(result.share(sprites[1]), progress, `share at ${progress}`)
            }
        }
    }
    // The target and the share are clamped before use, and a zero denominator gives A nothing.
    assert.deepEqual(crossfadeAlphas(1.2, 0.5), crossfadeAlphas(1, 0.5))
    assert.deepEqual(crossfadeAlphas(1, 1.5), [0, 1])
    assert.deepEqual(crossfadeAlphas(1, -0.5), [1, 0])
})

test('the lane background fades as a pair below the band, with the lane alpha', () => {
    for (const la of [0.3, 1]) {
        for (const t of [0.25, 0.5, 0.75]) {
            const draws = record(
                skinOf(),
                baseProps({ laneAlpha: la, laneColor: { start: 0, end: 2, progress: t } }),
            )
            const groups = byQuad(draws, laneSprites)
            assert.equal(groups.length, 1)
            const group = groups[0]!
            assert.deepEqual(
                group.map(({ sprite }) => sprite),
                [lane, laneRed],
            )
            const result = composite(group, bodies)
            close(result.alpha, 0.4 * la, `la ${la} t ${t}`)
            close(result.share(laneRed), t, `la ${la} t ${t}`)
            // Under the judgment line band, which is slot 1.
            const band = draws.find(({ sprite }) => sprite === setA.background)!
            assert.ok(compareZ(group[1]!.z, band.z) < 0)
        }
    }
})

test('a lane color change between sprites a skin shares is drawn once', () => {
    // Green and Yellow, which this skin has no lane for: both are the skin’s own lane.
    const draws = record(
        skinOf(),
        baseProps({ laneColor: { start: 3, end: 5, progress: 0.5 }, laneAlpha: 0.6 }),
    )
    const lanes = draws.filter(({ sprite }) => laneSprites.includes(sprite!))
    assert.equal(lanes.length, 1)
    assert.equal(lanes[0]!.sprite, lane)
    close(lanes[0]!.alpha, 0.6)

    // Default to Default is one draw, whatever the progress.
    const same = record(skinOf(), baseProps({ laneColor: { start: 0, end: 0, progress: 0.5 } }))
    assert.equal(same.filter(({ sprite }) => laneSprites.includes(sprite!)).length, 1)
})

test('lane color shares stay within 0..1 when the ease overshoots', () => {
    for (const progress of [1.3, -0.2]) {
        const draws = record(
            skinOf(),
            baseProps({ laneAlpha: 0.8, laneColor: { start: 0, end: 2, progress } }),
        )
        const result = composite(byQuad(draws, laneSprites)[0]!, bodies)
        close(result.alpha, 0.4 * 0.8, `progress ${progress}`)
        close(result.share(laneRed), progress > 1 ? 1 : 0, `progress ${progress}`)
    }
})

test('the stages’ draw slots never interleave', () => {
    const fading = (order: number) =>
        record(
            skinOf(),
            baseProps(
                {
                    laneColor: { start: 0, end: 2, progress: 0.5 },
                    judgeLineColor: { start: 0, end: 1, progress: 0.5 },
                    division: {
                        start: { size: 1, parity: 0 },
                        end: { size: 1, parity: 1 },
                        progress: 0.5,
                    },
                    leftBorderStyle: { start: 0, end: 1, progress: 0.5 },
                    fullWidth: 0.5,
                },
                order,
            ),
        )
    const slots = (draws: Recorded[]) => draws.map(({ z }) => z[2]!)
    const first = slots(fading(0))
    const second = slots(fading(1))
    assert.ok(first.includes(0.5) && first.includes(14.5))
    assert.ok(Math.max(...first) < Math.min(...second))
})

test('getStageProps eases the lane color as it eases the judgment line color', () => {
    const style = (
        time: number,
        laneColor: number,
        judgeLineColor: number,
        ease: EaseTypeValue,
    ) => ({
        time,
        laneColor,
        judgeLineColor,
        judgeLineStyle: 0 as const,
        leftBorderStyle: 0,
        rightBorderStyle: 0,
        fullWidth: 0,
        noteAlpha: 1,
        laneAlpha: 1,
        judgeLineAlpha: 1,
        divisionLineAlpha: 1,
        ease,
    })
    const value = { ...stage(), styles: [style(0, 0, 0, EaseType.outBack), style(2, 3, 5, 1)] }
    for (const t of [0.5, 1, 1.5]) {
        const props = getStageProps(value, t)
        assert.equal(props.laneColor.progress, props.judgeLineColor.progress)
        assert.deepEqual([props.judgeLineColor.start, props.judgeLineColor.end], [0, 5])
    }
    const mid = getStageProps(value, 1)
    assert.deepEqual([mid.laneColor.start, mid.laneColor.end], [0, 3])
    assert.ok(mid.laneColor.progress > 0 && mid.laneColor.progress !== 1)
    // After the last event there is nothing to fade to.
    const after = getStageProps(value, 3)
    assert.deepEqual([after.laneColor.start, after.laneColor.end], [3, 3])
})

test('a judgment line band shared by both colors is drawn once; distinct bands are a pair', () => {
    for (const ja of [1, 0.6]) {
        const props = baseProps({
            judgeLineAlpha: ja,
            judgeLineColor: { start: 0, end: 1, progress: 0.4 },
        })
        const shared = sprite()
        const sharedBodies = new Map([[shared, 0.57]])
        const sharedSkin = skinOf({
            judgments: [
                { ...setA, background: shared },
                { ...setB, background: shared },
            ],
        })
        // The old dip: two 0.57 bands at 0.6 and 0.4 shine through each other.
        const once = record(sharedSkin, props).filter(({ sprite }) => sprite === shared)
        assert.equal(once.length, 1)
        close(once[0]!.alpha, ja)
        close(composite(once, sharedBodies).alpha, 0.57 * ja)

        const pair = byQuad(record(skinOf(), props), [setA.background, setB.background])
        assert.equal(pair.length, 1)
        const result = composite(pair[0]!)
        close(result.alpha, ja)
        close(result.share(setB.background), 0.4)
        assert.ok(pair[0]![0]!.z[2]! < pair[0]![1]!.z[2]!)
    }
})

test('the gradient and edge fade as nested pairs when Full Width and the color change together', () => {
    const c = 0.4
    const fw = 0.3
    const draws = record(
        skinOf(),
        baseProps({
            judgeLineAlpha: 0.8,
            fullWidth: fw,
            judgeLineColor: { start: 0, end: 1, progress: c },
        }),
    )
    const groups = byQuad(inGradientSlots(draws), [
        setA.gradient,
        setA.edge,
        setB.gradient,
        setB.edge,
    ])
    assert.equal(groups.length, 4)
    for (const group of groups) {
        assert.deepEqual(
            group.map(({ sprite }) => sprite),
            [setA.gradient, setA.edge, setB.gradient, setB.edge],
        )
        assert.deepEqual(
            group.map(({ z }) => z[2]! % 17),
            [13, 13.5, 14, 14.5],
        )
        const result = composite(group)
        close(result.alpha, 0.8)
        close(result.share(setA.gradient), (1 - c) * (1 - fw))
        close(result.share(setA.edge), (1 - c) * fw)
        close(result.share(setB.gradient), c * (1 - fw))
        close(result.share(setB.edge), c * fw)
    }
})

test('the gradient is drawn alone at rest, and once when the colors share it', () => {
    const rest = inGradientSlots(record(skinOf(), baseProps({ judgeLineAlpha: 0.8 })))
    const gradients = rest.filter(({ sprite }) => sprite === setA.gradient)
    assert.equal(gradients.length, 4)
    for (const draw of gradients) close(draw.alpha, 0.8)
    assert.equal(rest.filter(({ sprite }) => sprite === setA.edge).length, 0)
    assert.equal(rest.filter(({ sprite }) => sprite === setB.gradient).length, 0)

    const shared = skinOf({
        judgments: [setA, { ...setB, gradient: setA.gradient, edge: setA.edge }],
    })
    const fading = inGradientSlots(
        record(
            shared,
            baseProps({ judgeLineAlpha: 0.8, judgeLineColor: { start: 0, end: 1, progress: 0.5 } }),
        ),
    )
    assert.equal(fading.filter(({ sprite }) => sprite === setA.gradient).length, 4)
})

test('a single line fades as a pair', () => {
    const draws = record(
        skinOf(),
        baseProps({
            judgeLineAlpha: 0.7,
            judgeLineStyle: { start: 1, end: 1, progress: 0 },
            judgeLineColor: { start: 0, end: 1, progress: 0.25 },
        }),
    )
    const groups = byQuad(draws, [setA.singleLine, setB.singleLine])
    assert.equal(groups.length, 1)
    const result = composite(groups[0]!)
    close(result.alpha, 0.7)
    close(result.share(setB.singleLine), 0.25)
})

const dividerSprites = [setA.center, setA.edge, setB.center, setB.edge]

test('each subdivision shows the judgment line alpha, with or without a color change', () => {
    for (const ja of [1, 0.5]) {
        // One color: the center and the edge are a compensated pair (before, 0.5 showed 0.75 at the edges).
        const one = record(skinOf(), baseProps({ judgeLineAlpha: ja }))
        const groups = byQuad(one, [setA.center, setA.edge])
        assert.equal(groups.length, 11)
        for (const group of groups) close(composite(group).alpha, ja, `ja ${ja}`)

        const fade = record(
            skinOf(),
            baseProps({
                judgeLineAlpha: ja,
                judgeLineColor: { start: 0, end: 1, progress: 0.3 },
            }),
        )
        const faded = byQuad(fade, dividerSprites)
        assert.equal(faded.length, 11)
        for (const group of faded) {
            const result = composite(group)
            close(result.alpha, ja, `ja ${ja}`)
            close(result.share(setB.center, setB.edge), 0.3, `ja ${ja}`)
        }
    }
})

test('subdivision sets of a parity change fade linearly and keep their slots with a color change', () => {
    const division = {
        start: { size: 1, parity: 0 },
        end: { size: 1, parity: 1 },
        progress: 0.25,
    }
    const parityOnly = record(skinOf(), baseProps({ division }))
    const sets = byQuad(parityOnly, [setA.center, setA.edge])
    // 11 whole-lane dividers fade out and 12 half-lane ones fade in; they never share a quad.
    assert.equal(sets.length, 23)
    const alphas = sets.map((group) => composite(group).alpha)
    assert.equal(alphas.filter((alpha) => Math.abs(alpha - 0.75) < 1e-9).length, 11)
    assert.equal(alphas.filter((alpha) => Math.abs(alpha - 0.25) < 1e-9).length, 12)

    const both = record(
        skinOf(),
        baseProps({ division, judgeLineColor: { start: 0, end: 1, progress: 0.5 } }),
    )
    const groups = byQuad(both, dividerSprites)
    assert.equal(groups.length, 23)
    const slots = groups.map((group) => group.map(({ z }) => z[2]!).join())
    assert.equal(slots.filter((slot) => slot === '5,6,9,10').length, 11)
    assert.equal(slots.filter((slot) => slot === '7,8,11,12').length, 12)
    for (const group of groups) {
        const result = composite(group)
        close(result.share(setB.center, setB.edge), 0.5)
        assert.ok(result.alpha > 0)
    }
    const start = groups.find((group) => group[0]!.z[2] === 5)!
    close(composite(start).alpha, 0.75)
})

test('a left border changes color and style at once as four draws that add up to the line alpha', () => {
    const c = 0.4
    const pb = 0.7
    const ja = 0.8
    const draws = record(
        skinOf(),
        baseProps({
            judgeLineAlpha: ja,
            leftBorderStyle: { start: 0, end: 1, progress: pb },
            judgeLineColor: { start: 0, end: 1, progress: c },
        }),
    )
    // The Default border is drawn with the left edge sprite, the Light one with the edge sprite.
    const slots = [5, 7, 9, 11]
    const border = draws.filter(
        ({ sprite, z }) =>
            sprite === setA.edgeLeft ||
            sprite === setB.edgeLeft ||
            ((sprite === setA.edge || sprite === setB.edge) && slots.includes(z[2]!)),
    )
    assert.deepEqual(
        [...border].sort((a, b) => compareZ(a.z, b.z)).map(({ z }) => z[2]),
        slots,
    )
    // The Light border is snapped to whole pixels and the Default one is not, so each style has
    // its own quad, shared by the two colors.
    const quads = byQuad(border, [setA.edgeLeft, setB.edgeLeft, setA.edge, setB.edge])
    assert.equal(quads.length, 2)
    for (const group of quads) assert.equal(group.length, 2)
    const result = composite(border)
    close(result.alpha, ja)
    close(result.share(setB.edgeLeft, setB.edge), c)
    close(result.share(setA.edge, setB.edge), pb)
})

test('every draw stays within the target alpha when the eases overshoot', () => {
    const ja = 0.9
    const draws = record(
        skinOf(),
        baseProps({
            judgeLineAlpha: ja,
            laneColor: { start: 0, end: 2, progress: 1.3 },
            judgeLineColor: { start: 0, end: 1, progress: -0.2 },
            leftBorderStyle: { start: 0, end: 1, progress: 1.3 },
            division: {
                start: { size: 1, parity: 0 },
                end: { size: 1, parity: 1 },
                progress: 1.3,
            },
        }),
    )
    for (const { alpha } of draws) assert.ok(alpha >= 0 && alpha <= 1, `${alpha}`)

    // The end set's target is above 1 while the color share is in range: still a whole pair.
    const sets = record(
        skinOf(),
        baseProps({
            division: {
                start: { size: 1, parity: 0 },
                end: { size: 1, parity: 1 },
                progress: 1.3,
            },
            judgeLineColor: { start: 0, end: 1, progress: 0.5 },
        }),
    )
    const groups = byQuad(sets, dividerSprites)
    assert.equal(groups.length, 12)
    for (const group of groups) {
        const result = composite(group)
        assert.ok(result.alpha <= 1 + 1e-12)
        close(result.alpha, 1)
        close(result.share(setB.center, setB.edge), 0.5)
    }
})

test('without a color change the draws are the single sprites at their alphas', () => {
    const draws = record(skinOf(), baseProps({ judgeLineAlpha: 0.8, laneAlpha: 0.9 }))
    const own = (sprites: (Sprite | undefined)[]) =>
        draws.filter(({ sprite }) => sprites.includes(sprite!))
    assert.equal(own([lane]).length, 1)
    close(own([lane])[0]!.alpha, 0.9)
    assert.equal(own([laneRed, laneBlue]).length, 0)
    assert.equal(own([setA.background]).length, 1)
    close(own([setA.background])[0]!.alpha, 0.8)
    assert.equal(own([setA.gradient]).length, 4)
    // The second color is not drawn at all.
    assert.equal(
        own([setB.background, setB.gradient, setB.center, setB.edge, setB.edgeLeft]).length,
        0,
    )
})
