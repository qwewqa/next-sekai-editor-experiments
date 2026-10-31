import assert from 'node:assert/strict'
import test from 'node:test'
import {
    backingSize,
    capScale,
    createMapping,
    GUTTER_MARK_WIDTH,
    gutterMarkEdges,
    laneFraction,
    PAD_LEFT,
    PAD_RIGHT,
} from '../../../src/editor/minimap/mapping'

const geometry = { width: 40, height: 400, scale: 2 }

test('the lane fraction is continuous at the core edge and strictly monotone', () => {
    for (const edge of [6, -6]) {
        assert.ok(Math.abs(laneFraction(edge + 1e-9) - laneFraction(edge - 1e-9)) < 1e-8)
    }
    assert.equal(laneFraction(0), 0)
    assert.ok(Math.abs(laneFraction(6) - 0.4) < 1e-12)
    let previous = -Infinity
    for (let lane = -40; lane <= 40; lane += 0.25) {
        const fraction = laneFraction(lane)
        assert.ok(fraction > previous, `lane ${lane} does not rise`)
        previous = fraction
    }
})

test('the lane fraction stays inside the strip and is odd', () => {
    for (const lane of [1e6, 1e3, 17, 6.0001]) {
        assert.ok(laneFraction(lane) < 0.5 && laneFraction(lane) > 0)
        assert.equal(laneFraction(-lane), -laneFraction(lane))
    }
    assert.ok(laneFraction(-1e6) > -0.5)
})

test('time maps to y and back, with the clamps at both ends', () => {
    const mapping = createMapping(geometry, 100)
    for (const time of [0, 1, 12.5, 77, 100]) {
        assert.ok(Math.abs(mapping.yToTime(mapping.timeToY(time)) - time) < 1e-9)
    }
    // Later is higher up.
    assert.ok(mapping.timeToY(50) < mapping.timeToY(10))
    assert.equal(mapping.timeToY(-5), mapping.timeToY(0))
    assert.equal(mapping.timeToY(500), mapping.timeToY(100))
    assert.equal(mapping.yToTime(-1000), 100)
    assert.equal(mapping.yToTime(1e6), 0)
})

test("the range runs from 17 px below the top, under the edge mark's rows, to 4 px above the bottom", () => {
    const mapping = createMapping(geometry, 100)
    assert.equal(mapping.timeToY(100), 17)
    assert.equal(mapping.timeToY(0), geometry.height - 4)
    assert.equal(mapping.yToTime(17), 100)
    assert.equal(mapping.yToTime(geometry.height - 4), 0)
})

test('nothing maps left of the tick column or right of the padding', () => {
    const mapping = createMapping(geometry, 100)
    for (const lane of [-1e6, -40, -16.5, -6, 0, 6, 17, 40, 1e6]) {
        const x = mapping.laneToX(lane)
        assert.ok(x > PAD_LEFT, `lane ${lane} at ${x}`)
        assert.ok(x < geometry.width - PAD_RIGHT, `lane ${lane} at ${x}`)
    }
    for (const [left, size] of [
        [-1e6, 1],
        [-17, 0.5],
        [0, 0],
        [5, -3],
    ] as const) {
        const [a, b] = mapping.spanToX(left, size)
        assert.ok(a >= PAD_LEFT - 1 / geometry.scale && a <= b)
        assert.ok(b - a >= 1 / geometry.scale - 1e-12, 'a span is at least one device pixel')
    }
})

test('the backing store and the scale are capped', () => {
    assert.deepEqual(backingSize({ width: 40, height: 780.4, scale: 2 }), {
        width: 80,
        height: 1561,
    })
    assert.equal(capScale(3, 500), 2)
    assert.equal(capScale(1.5, 500), 1.5)
    // A tall canvas gives up scale to stay within 4096 device rows.
    assert.ok(backingSize({ width: 40, height: 3000, scale: capScale(2, 3000) }).height <= 4096)
})

test("History's ticks and the selection rail mirror each other on whole device px, at any scale", () => {
    const cases = [
        { width: 60, height: 776, scale: 2 },
        { width: 60, height: 776, scale: 1 },
        // Windows at 125% and 150%, an odd width, and a tall strip's capped scale.
        { width: 60, height: 776, scale: 1.25 },
        { width: 60, height: 776, scale: 1.5 },
        { width: 61, height: 776, scale: 1.5 },
        { width: 24, height: 776, scale: 1.5 },
        { width: 160, height: 2500, scale: capScale(2, 2500) },
    ]
    for (const geometry of cases) {
        const ratio = backingSize(geometry).width / geometry.width
        const { tick, rail } = gutterMarkEdges(geometry)
        const at = JSON.stringify(geometry)
        for (const edge of [tick, rail])
            assert.ok(Math.abs(edge * ratio - Math.round(edge * ratio)) < 1e-9, `whole px: ${at}`)
        // Within a device px of the unsnapped width, and the rail exactly as wide as the tick.
        assert.ok(Math.abs(tick - GUTTER_MARK_WIDTH) <= 1 / ratio, at)
        assert.ok(Math.abs(geometry.width - rail - tick) < 1e-9, `mirrored: ${at}`)
    }
    // At 2x both are 5 px.
    assert.deepEqual(gutterMarkEdges({ width: 60, height: 776, scale: 2 }), { tick: 5, rail: 55 })
})
