import assert from 'node:assert/strict'
import { test } from 'node:test'
import { omittedSprites, skinSprites } from '../../builtin-assets/manifest.mjs'
import { particleEffects } from '../../builtin-assets/particles.mjs'
import { collectNames, nameListHash } from '../../scripts/extract-engine-names.mjs'
import { readFixture } from './helpers.mjs'

test('the fixture names its engine commit and its list hash', () => {
    const fixture = readFixture()
    assert.equal(fixture.engine.commit, '3f9f601')
    assert.deepEqual(fixture.counts, {
        spritesDeclared: 1351,
        sprites: 1340,
        particles: 505,
        clips: 15,
    })
    assert.equal(fixture.sha256, nameListHash(fixture))
    assert.deepEqual(fixture.sprites, [...new Set(fixture.sprites)].sort())
})

test('collectNames takes the sorted union over the engine data', () => {
    const names = collectNames([
        { skin: { sprites: [{ name: 'b' }, { name: 'a' }, { name: 'b' }] } },
        { skin: { sprites: [{ name: 'c' }] }, particle: { effects: [{ name: 'p' }] } },
        { archetypes: [] },
        { effect: { clips: [{ name: 'k' }] } },
    ])
    assert.deepEqual(names, { sprites: ['a', 'b', 'c'], particles: ['p'], clips: ['k'] })
})

test('the manifest expands to the engine’s names and the counts of the design', () => {
    const fixture = readFixture()
    const { sprites, groups } = skinSprites()
    assert.deepEqual(
        fixture.sprites.filter((name) => !sprites.has(name)),
        [...omittedSprites].sort(),
    )
    assert.deepEqual(
        [...sprites.keys()].filter((name) => !fixture.sprites.includes(name)),
        [],
    )
    assert.equal(groups.get('Judgment'), 41)
    assert.equal(groups.get('Style colours'), 1000)
    assert.equal(groups.get('Flick arrows'), 96)
    assert.equal(particleEffects().length, 505)
    assert.deepEqual(
        fixture.particles.filter((name) => !particleEffects().some((e) => e.name === name)),
        [],
    )
})
