import assert from 'node:assert/strict'
import test from 'node:test'
import type { Quad } from '../../src/preview/engine/math'
import { drawParticleEffect, PARTICLE_DRAW_BUDGET } from '../../src/preview/engine/particleDraw'
import type { ParticleEffect, ParticleProperty, ResolvedParticle } from '../../src/preview/particle'

// The renderer's own cap (Part 2, 2.5.5): an effect that slipped past an older check draws at most
// 512 particles and walks at most 512 groups, so it cannot stall a frame.

const layout: Quad = {
    bl: { x: 0, y: 0 },
    tl: { x: 0, y: 1 },
    tr: { x: 1, y: 1 },
    br: { x: 1, y: 0 },
}
const constant = (value: number): ParticleProperty => ({
    from: { c: value },
    to: { c: value },
    ease: 'linear',
})
const particle: ResolvedParticle = {
    sprite: { u0: 0, v0: 0, u1: 1, v1: 1, texture: 1 },
    tint: { r: 1, g: 1, b: 1 },
    start: 0,
    duration: 1,
    x: constant(0),
    y: constant(0),
    w: constant(0.1),
    h: constant(0.1),
    r: constant(0),
    a: constant(1),
}

const draw = (effect: ParticleEffect) => {
    let draws = 0
    const started = performance.now()
    drawParticleEffect(() => draws++, effect, layout, 0.5, false, 1, [100, 0])
    return { draws, ms: performance.now() - started }
}

test('a huge count with no particles returns at once', () => {
    const { draws, ms } = draw({ groups: [{ count: 1e15, particles: [] }] })
    assert.equal(draws, 0)
    assert.ok(ms < 1000, `${ms} ms`)
})

test('a tiny count over many particles draws at most the budget', () => {
    const many = Array.from({ length: 100_000 }, () => particle)
    assert.ok(draw({ groups: [{ count: 0.005, particles: many }] }).draws <= PARTICLE_DRAW_BUDGET)
    // Only whole occurrences are drawn: one of 300 particles fits, a second would not.
    const some = many.slice(0, 300)
    assert.equal(draw({ groups: [{ count: 3, particles: some }] }).draws, 300)
})

test('many groups are walked only up to the budget', () => {
    const groups = Array.from({ length: 200_000 }, () => ({ count: 1, particles: [particle] }))
    assert.equal(draw({ groups }).draws, PARTICLE_DRAW_BUDGET)
})

test('an effect under the budget draws every particle', () => {
    assert.equal(draw({ groups: [{ count: 20, particles: [particle, particle] }] }).draws, 40)
})
