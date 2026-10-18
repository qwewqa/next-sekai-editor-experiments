import assert from 'node:assert/strict'
import { test } from 'node:test'
import { particleSprites } from '../../builtin-assets/manifest.mjs'
import { readBuiltinItem } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

// Particles are stretched and turned freely, so a sprite whose alpha is still up at its border
// shows a hard straight edge: the rectangle of its quad. Every sprite fades to nothing before its
// border. The lane sprites are the exception, as the base set's are: they fill the lane's column
// from side to side, and their sides are the lane's edges.
const fillsItsQuad = new Set(['flash', 'streak'])

const particle = readBuiltinItem('particle')
const texture = decode(particle.resource('texture'))
const { sprites } = particle.json('data')

// The largest alpha on the ring `depth` pixels in from a sprite's border.
function ringAlpha({ x, y, w, h }, depth) {
    let high = 0
    for (let column = depth; column < w - depth; column++)
        for (const row of [depth, h - 1 - depth])
            high = Math.max(high, pixelAt(texture, x + column, y + row)[3])
    for (let row = depth; row < h - depth; row++)
        for (const column of [depth, w - 1 - depth])
            high = Math.max(high, pixelAt(texture, x + column, y + row)[3])
    return high
}

test('every particle sprite is named in the manifest', () => {
    assert.equal(sprites.length, particleSprites.length)
})

test('particle sprites fade to nothing before their border', () => {
    for (const [index, { name }] of particleSprites.entries()) {
        if (fillsItsQuad.has(name)) continue
        const sprite = sprites[index]
        assert.equal(ringAlpha(sprite, 0), 0, `${name}: alpha at the border`)
        assert.ok(ringAlpha(sprite, 1) <= 8, `${name}: ${ringAlpha(sprite, 1)} one pixel in`)
    }
})

test('the lane sprites fade out along the lane', () => {
    for (const [index, { name }] of particleSprites.entries()) {
        if (!fillsItsQuad.has(name)) continue
        const { x, y, w } = sprites[index]
        for (let column = 0; column < w; column++)
            assert.equal(pixelAt(texture, x + column, y)[3], 0, `${name}: alpha at its far end`)
    }
})
