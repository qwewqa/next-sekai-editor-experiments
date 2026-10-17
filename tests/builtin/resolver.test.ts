import assert from 'node:assert/strict'
import test from 'node:test'
import { noteStyles } from '../../src/chart/noteStyle'
import { resolveParticle, type ParticleEffect } from '../../src/preview/particle'
import { parseGzippedJson } from '../../src/preview/scp'
import { resolveSkin, toSpriteUv, type Sprite } from '../../src/preview/skin'
import { readBuiltinItem, readFixture } from './helpers.mjs'

type SkinData = {
    width: number
    height: number
    sprites: { name: string; x: number; y: number; w: number; h: number }[]
}
type ParticleData = { effects: { name: string }[] }

const fixture = readFixture() as { sprites: string[]; particles: string[]; clips: string[] }

test('resolveSkin takes its first choices, for the default and all 8 styles', () => {
    const data = readBuiltinItem('skin').json('data') as SkinData
    const sprites = new Map<string, Sprite>(
        data.sprites.map((s) => [s.name, toSpriteUv(s.x, s.y, s.w, s.h, data.width, data.height)]),
    )
    const misses = new Set<string>()
    const skin = resolveSkin((name) => {
        const sprite = sprites.get(name)
        if (!sprite) misses.add(name)
        return sprite
    })

    // The only declared name the set leaves out.
    const missed = [...misses].filter((name) => fixture.sprites.includes(name))
    assert.deepEqual(missed, ['Sekai Stage'])
    assert.equal(skin.sekaiStage, undefined)
    for (const field of [
        'cover',
        'lane',
        'judgmentLine',
        'stageLeftBorder',
        'stageRightBorder',
        'laneBackground',
        'laneDivider',
        'stageBorder',
        'simLine',
    ] as const)
        assert.ok(skin[field], field)
    assert.equal(skin.judgments.length, 8)
    for (const judgment of skin.judgments) {
        assert.ok(judgment.background && judgment.gradient && judgment.edge)
        assert.ok(judgment.singleLine && judgment.edgeLeft && judgment.center)
    }
    assert.ok(skin.guides.every(Boolean))

    assert.equal(skin.normalNote.body.renderType, 'normal')
    assert.equal(skin.traceNote.body.renderType, 'slim')
    assert.equal(skin.flickNote.arrow.fallback, false)
    assert.equal(skin.criticalFlickNote.arrow.up.length, 6)
    assert.ok(skin.damageNote.body.left)

    assert.deepEqual(Object.keys(skin.styles ?? {}), noteStyles.slice(1))
    for (const style of noteStyles.slice(1)) {
        const styled = skin.styles?.[style]
        assert.ok(styled, style)
        assert.notEqual(styled.normalNote.body.middle, skin.normalNote.body.middle)
        assert.ok(styled.traceNote.tick && styled.normalSlideTickNote.tick, style)
        assert.ok(styled.flickNote.arrow.upLeft.length === 6, style)
        assert.ok(styled.normalNote.slot && styled.normalNote.slotGlow, style)
        assert.ok(styled.activeSlideConnector.active, style)
    }
})

test('resolveParticle takes its first choices, for the default and all 8 styles', () => {
    const data = readBuiltinItem('particle').json('data') as ParticleData
    const effect: ParticleEffect = { groups: [] }
    const names = new Set(data.effects.map((e) => e.name))
    const misses = new Set<string>()
    const particle = resolveParticle((name) => {
        if (names.has(name)) return effect
        misses.add(name)
        return undefined
    })
    assert.deepEqual(
        [...misses].filter((name) => fixture.particles.includes(name)),
        [],
    )
    assert.ok(particle.lane)
    for (const set of [particle.normalNote, particle.criticalFlickNote]) {
        assert.ok(set.circular && set.linear && set.lane && set.slotLinear)
    }
    assert.ok(particle.flickNote.directional)
    assert.ok(particle.traceNote.tick && particle.traceNote.linear)
    assert.ok(
        particle.normalSlideConnector.trailLinear && particle.criticalSlideConnector.slotLinear,
    )
    assert.deepEqual(Object.keys(particle.styles ?? {}), noteStyles.slice(1))
})

test('the effect has the first clip of every player slot', () => {
    const data = readBuiltinItem('effect').json('data') as { clips: { name: string }[] }
    const names = data.clips.map((clip) => clip.name)
    for (const first of [
        '#PERFECT',
        '#PERFECT_ALTERNATIVE',
        '#HOLD',
        'Sekai Tick',
        'Sekai Trace',
        'Sekai Critical Tap',
        'Sekai Critical Flick',
        'Sekai Critical Trace',
        'Sekai Critical Tick',
        'Sekai Critical Hold',
    ])
        assert.ok(names.includes(first), first)
})

test('the particle data parses as gzip JSON with identity transforms', () => {
    const item = readBuiltinItem('particle')
    const data = parseGzippedJson<{
        sprites: unknown[]
        effects: { transform: Record<string, Record<string, number>> }[]
    }>(item.resource('data'))
    assert.equal(data.sprites.length, 8)
    for (const effect of data.effects) assert.deepEqual(effect.transform.x1, { x1: 1 })
})
