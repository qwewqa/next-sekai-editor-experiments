import assert from 'node:assert/strict'
import { test } from 'node:test'
import { snapGlow } from '../../builtin-assets/build.mjs'
import { skinSprites } from '../../builtin-assets/manifest.mjs'
import { channels } from '../../builtin-assets/palette.mjs'
import { readBuiltinItem } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

const premultiplied = (value, alpha) => Math.round((value * alpha) / 255)
const nearGlow = (pixel, glow) =>
    glow.every(
        (value, c) =>
            Math.abs(premultiplied(value, pixel[3]) - premultiplied(pixel[c], pixel[3])) <= 1,
    )

test('a glow pixel takes the glow colour, and its premultiplied value moves a level at most', () => {
    const pixels = [
        [0, 0, 255, 3],
        [0, 0, 128, 2],
        [40, 200, 90, 2],
        [10, 20, 250, 200],
        [0, 0, 0, 0],
        [9, 9, 9, 255],
    ]
    const { data } = snapGlow(
        { width: 6, height: 1, data: new Uint8Array(pixels.flat()) },
        '#0000c4',
    )
    const after = Array.from({ length: 6 }, (_, i) => [...data.subarray(i * 4, i * 4 + 4)])
    assert.deepEqual(after, [
        [0, 0, 196, 3],
        [0, 0, 196, 2],
        [40, 200, 90, 2],
        [10, 20, 250, 200],
        [0, 0, 0, 0],
        [9, 9, 9, 255],
    ])
    for (const [i, pixel] of pixels.entries())
        for (let c = 0; c < 3; c++)
            assert.ok(
                Math.abs(
                    premultiplied(pixel[c], pixel[3]) - premultiplied(after[i][c], pixel[3]),
                ) <= 1,
            )
})

// The soft glows (slots, arrows and markers, critical diamonds) store their pixels in the glow's
// own colour, not the noise of dividing by a low alpha, which would double their bytes.
test('Built-in glows are stored in their own colour', () => {
    const { sprites } = skinSprites()
    const skin = readBuiltinItem('skin')
    const texture = decode(skin.resource('texture'))
    const rects = new Map(skin.json('data').sprites.map((sprite) => [sprite.name, sprite]))
    let glows = 0
    const noisy = []
    for (const [name, spec] of sprites) {
        if (!spec.glow) continue
        glows++
        const glow = channels(spec.glow)
        const { x, y, w, h } = rects.get(name)
        let count = 0
        for (let row = 0; row < h; row++)
            for (let column = 0; column < w; column++) {
                const pixel = pixelAt(texture, x + column, y + row)
                if (pixel[3] === 0 || pixel[3] === 255 || !nearGlow(pixel, glow)) continue
                if (pixel.slice(0, 3).some((value, c) => value !== glow[c])) count++
            }
        if (count) noisy.push(`${name}: ${count}`)
    }
    assert.ok(glows > 400, `${glows} glows`)
    assert.deepEqual(noisy, [])
})
