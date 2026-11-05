import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clipAliases, omittedOriginals } from '../../builtin-assets/manifest.mjs'
import { readZip } from '../../builtin-assets/zip.mjs'
import { inkBox } from '../../scripts/extract-original-names.mjs'
import { readBuiltinItem, readOriginals } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

// The Next SEKAI packages the editor ships as its Default ("the originals"), as recorded by
// scripts/extract-original-names.mjs. A skin, particle or effect that names what they name works
// with any engine written for them.
const originals = readOriginals()

const skin = readBuiltinItem('skin')
const texture = decode(skin.resource('texture'))
const sprites = new Map(skin.json('data').sprites.map((sprite) => [sprite.name, sprite]))
const effect = readBuiltinItem('effect')
const clips = effect.json('data').clips

const box = (name) => {
    const sprite = sprites.get(name)
    return inkBox(sprite, (column, row) => pixelAt(texture, sprite.x + column, sprite.y + row)[3])
}
const show = (values) => values.map((value) => value.toFixed(3)).join(', ')

test('the set carries every original name but the ones it leaves out', () => {
    assert.deepEqual(
        originals.sprites.filter((name) => !sprites.has(name)),
        [...omittedOriginals].sort(),
    )
    const effects = new Set(
        readBuiltinItem('particle')
            .json('data')
            .effects.map(({ name }) => name),
    )
    assert.deepEqual(
        originals.particles.filter((name) => !effects.has(name)),
        [],
    )
    assert.deepEqual(
        originals.clips.filter((name) => !clips.some((clip) => clip.name === name)),
        [],
    )
})

test("a clip plays another clip's file only where the originals share that file", () => {
    const files = readZip(effect.resource('audio'))
    for (const { name, filename } of clips) assert.ok(files.has(filename), `${name}: ${filename}`)
    const fileOf = (name) => clips.find((clip) => clip.name === name).filename
    for (const [name, target] of Object.entries(clipAliases)) {
        assert.equal(fileOf(name), fileOf(target), name)
        assert.ok(
            originals.sharedFiles.some((group) => group.includes(name) && group.includes(target)),
            `${name} and ${target} do not share a file in the originals`,
        )
    }
})

// The ink at alpha 64 or more, through each sprite's transform, in the engine's unit quad.
test("stage edge lines and corners sit at the edge the originals' do", () => {
    const near = 1 / 8
    for (const name of Object.keys(originals.edges).filter((name) => name.startsWith('#STAGE'))) {
        const base = originals.edges[name]
        const ours = box(name)
        const label = `${name}: ${show(ours)}, the originals ${show(base)}`
        for (const axis of [0, 2]) {
            const [b0, b1, o0, o1] = [base[axis], base[axis + 1], ours[axis], ours[axis + 1]]
            if (b1 - b0 >= 0.75) {
                assert.ok(o1 - o0 >= 0.75, `${label}: not across the quad`)
                continue
            }
            assert.ok(o1 - o0 <= 1 / 4, `${label}: too thick`)
            if (b0 <= near) assert.ok(o0 <= near, `${label}: off the edge`)
            if (b1 >= 1 - near) assert.ok(o1 >= 1 - near, `${label}: off the edge`)
        }
    }
})

test('the preview-mode lane divider is centred on its strip', () => {
    const [x0, x1] = box('Sekai Lane Divider Preview')
    assert.ok(Math.abs((x0 + x1) / 2 - 0.5) <= 0.15, show([x0, x1]))
})
