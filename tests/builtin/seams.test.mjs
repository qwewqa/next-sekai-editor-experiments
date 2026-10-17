import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuiltinItem } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

// How the engine joins pieces (sekai/lib/layout.py, stage.py, connector.py):
// - note bodies: Left, Middle and Right quads side by side, Middle stretched along x;
// - connectors and guides: one quad per segment, segments end to end along the sprite's y;
// - the judgment gradient: two strips meeting at the lane centre (u = 1 of both), capped at the
//   stage edges by Edge Left, the stage-edge end (u = 0) of the gradient.
const skin = readBuiltinItem('skin')
const texture = decode(skin.resource('texture'))
const rects = new Map(skin.json('data').sprites.map((sprite) => [sprite.name, sprite]))

const column = (name, at) => {
    const { x, y, w, h } = rects.get(name)
    const c = at < 0 ? w + at : at
    return Array.from({ length: h }, (_, row) => pixelAt(texture, x + c, y + row))
}
const row = (name, at) => {
    const { x, y, w, h } = rects.get(name)
    const r = at < 0 ? h + at : at
    return Array.from({ length: w }, (_, c) => pixelAt(texture, x + c, y + r))
}
// Edges may differ by one level from rounding in the renderer.
const same = (a, b, label) => {
    assert.equal(a.length, b.length, label)
    for (let i = 0; i < a.length; i++)
        for (let c = 0; c < 4; c++)
            assert.ok(Math.abs(a[i][c] - b[i][c]) <= 1, `${label} at ${i}: ${a[i]} and ${b[i]}`)
}
// Every texel just outside the rect repeats the edge texel, so bilinear sampling never pulls in a
// neighbour or the clear gutter.
const extruded = (name) => {
    const { x, y, w, h } = rects.get(name)
    for (let gy = -1; gy <= h; gy++)
        for (let gx = -1; gx <= w; gx++) {
            if (gx >= 0 && gx < w && gy >= 0 && gy < h) continue
            const inside = pixelAt(
                texture,
                x + Math.min(w - 1, Math.max(0, gx)),
                y + Math.min(h - 1, Math.max(0, gy)),
            )
            assert.deepEqual(pixelAt(texture, x + gx, y + gy), inside, `${name} gutter`)
        }
}

const names = [...rects.keys()]

test('note body slices join edge to edge and are extruded', () => {
    const families = names
        .filter((name) => / Middle( |$)/.test(name))
        .map((name) => name.replace(' Middle', ' {}'))
    assert.ok(families.length > 100, `${families.length} families`)
    for (const family of families) {
        const [left, middle, right] = ['Left', 'Middle', 'Right'].map((part) =>
            family.replace('{}', part),
        )
        same(column(left, -1), column(middle, 0), `${left} | ${middle}`)
        same(column(middle, -1), column(right, 0), `${middle} | ${right}`)
        same(column(middle, 0), column(middle, -1), `${middle} repeats along x`)
        for (const name of [left, middle, right]) extruded(name)
    }
})

test('connector, guide and stage pieces repeat along their length and are extruded', () => {
    const repeated = names.filter((name) =>
        /Slide Connection|^#NOTE_CONNECTION_|^Sekai Guide|^Sekai (Lane Background|Lane Divider|Stage Border)|^#LANE$|^#STAGE_(LEFT|RIGHT)_BORDER$|^#SIMULTANEOUS/.test(
            name,
        ),
    )
    assert.ok(repeated.length > 60, `${repeated.length} pieces`)
    for (const name of repeated) {
        same(row(name, 0), row(name, -1), `${name} top and bottom`)
        extruded(name)
    }
})

test('the judgment gradient meets its caps and its mirror without a step', () => {
    for (const color of ['Neutral', 'Red', 'Green', 'Blue', 'Yellow', 'Purple', 'Cyan', 'Black']) {
        const gradient = `Sekai Judgment Gradient ${color}`
        const cap = `Sekai Judgment Edge Left ${color}`
        same(column(gradient, 0), column(cap, 0).slice(0, column(gradient, 0).length), cap)
        same(column(cap, 0), column(cap, -1), `${cap} is flat`)
        for (const name of [gradient, cap, `Sekai Judgment Edge ${color}`]) extruded(name)
    }
})
