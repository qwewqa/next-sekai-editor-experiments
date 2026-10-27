import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuiltinItem } from './helpers.mjs'

// Each particle's properties are linear in the random values r1 to r8 (in [0, 1)) and their sines
// and cosines; from and to are mixed by the ease, which stays within [0, 1] at both ends, so the
// extremes over every sample of the randoms bound the property over the whole effect.
const data = readBuiltinItem('particle').json('data')
const randoms = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']

const range = (expression) => {
    let low = expression.c ?? 0
    let high = low
    for (const [key, weight] of Object.entries(expression)) {
        if (key === 'c') continue
        assert.ok(randoms.includes(key) || /^(sin|cos)r[1-8]$/.test(key), `unknown input ${key}`)
        assert.ok(Number.isFinite(weight), `${key} is ${weight}`)
        const [min, max] = randoms.includes(key) ? [0, 1] : [-1, 1]
        low += Math.min(weight * min, weight * max)
        high += Math.max(weight * min, weight * max)
    }
    return [low, high]
}
const span = (property) => {
    const [a, b] = range(property.from)
    const [c, d] = range(property.to)
    return [Math.min(a, c), Math.max(b, d)]
}

// How far from the centre of the engine's quad a particle may reach, by the effect's kind, at about
// the base set's reach: hits on the stage open past their quad, linear effects throw shards out
// round the note and rise far above it, and a flick's beam runs well along the flick.
const reachOf = (name) =>
    / Lane Linear|#LANE_LINEAR/.test(name)
        ? { x: 1.05, low: -1.05, high: 1.05 }
        : /Directional|#NOTE_LINEAR_ALTERNATIVE/.test(name)
          ? { x: 5, low: -4.5, high: 7 }
          : /Linear|#NOTE_LINEAR/.test(name)
            ? { x: 4, low: -4, high: 7 }
            : { x: 2.7, low: -2.7, high: 2.7 }

test('every particle stays in bounds, fades within 0 to 1 and ends with its effect', () => {
    for (const effect of data.effects) {
        const reach = reachOf(effect.name)
        for (const group of effect.groups) {
            assert.ok(Number.isInteger(group.count) && group.count > 0, effect.name)
            for (const particle of group.particles) {
                const label = `${effect.name}, sprite ${particle.sprite}`
                assert.ok(particle.sprite >= 0 && particle.sprite < data.sprites.length, label)
                assert.match(particle.color, /^#[0-9a-f]{6}$/, label)
                assert.ok(particle.start >= 0 && particle.duration > 0, label)
                assert.ok(
                    particle.start + particle.duration <= 1 + 1e-9,
                    `${label} outlives its effect`,
                )
                const [aLow, aHigh] = span(particle.a)
                assert.ok(aLow >= 0 && aHigh <= 1, `${label}: alpha ${aLow} to ${aHigh}`)
                const [wLow] = span(particle.w)
                const [hLow] = span(particle.h)
                assert.ok(wLow >= 0 && hLow >= 0, `${label}: negative size`)
                // A turned particle may reach as far as its larger half size on either axis. The
                // ends are checked as pairs (position and size at the same end of the particle).
                const [rLow, rHigh] = span(particle.r)
                const turned = Math.max(-rLow, rHigh) > 0.3
                for (const end of ['from', 'to']) {
                    const [xLow, xHigh] = range(particle.x[end])
                    const [yLow, yHigh] = range(particle.y[end])
                    const w = range(particle.w[end])[1]
                    const h = range(particle.h[end])[1]
                    const across = turned ? Math.max(w, h) : w
                    const along = turned ? Math.max(w, h) : h
                    assert.ok(
                        Math.max(-xLow, xHigh) + across <= reach.x,
                        `${label}: x reaches ${Math.max(-xLow, xHigh) + across}`,
                    )
                    assert.ok(
                        yLow - along >= reach.low && yHigh + along <= reach.high,
                        `${label}: y spans ${yLow - along} to ${yHigh + along}`,
                    )
                }
            }
        }
    }
})

test("the base set's silent effects stay silent", () => {
    const empty = data.effects.filter((effect) => effect.groups.length === 0).map((e) => e.name)
    for (const name of [
        'Sekai Damage Note Circular',
        'Sekai Damage Note Linear',
        'Sekai Normal Note Slot Linear',
        'Sekai Flick Lane Linear',
        'Sekai Down Flick Lane Linear',
    ])
        assert.ok(empty.includes(name), name)
    for (const name of ['Sekai Critical Flick Lane Linear', 'Sekai Note Lane Linear'])
        assert.ok(!empty.includes(name), name)
})

test('no effect is a lone pair of one shape', () => {
    // Two phases of one particle (one ending as the other starts) count as one.
    for (const effect of data.effects) {
        const drawn = effect.groups.flatMap((group) =>
            group.particles.flatMap((particle) => Array(group.count).fill(particle)),
        )
        if (drawn.length !== 2 || drawn[0].sprite !== drawn[1].sprite) continue
        const [a, b] = drawn
        const overlap =
            Math.min(a.start + a.duration, b.start + b.duration) - Math.max(a.start, b.start)
        assert.ok(overlap <= 1e-9, `${effect.name} is two of sprite ${a.sprite}`)
    }
})
