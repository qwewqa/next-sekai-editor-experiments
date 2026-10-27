import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuiltinItem } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

// Note bodies at stage tilt 0, where the engine makes a note one lane tall and its end slices
// 0.25 lane wide (slim 0.125), the middle slice the rest. Each slice's sprite box (its transform
// on the unit quad) and pixel size give lanes per pixel on each axis; the borders measured in the
// committed texture must then come out the same on all four sides, and the outer corners as round
// across as down, within a screen pixel at a desktop and a phone lane width.
const lanePixels = { desktop: 90, phone: 45 }
const widths = [1, 3, 6, 12]

const skin = readBuiltinItem('skin')
const texture = decode(skin.resource('texture'))
const sprites = new Map(skin.json('data').sprites.map((sprite) => [sprite.name, sprite]))

const unit = { x1: 0, x2: 0, x3: 1, x4: 1, y1: 0, y2: 1, y3: 1, y4: 0 }
// The sprite's box on the unit quad: [u0, u1, v0, v1].
const spriteBox = (sprite) => {
    const corner = (i) =>
        ['x', 'y'].map((axis) =>
            Object.entries(sprite.transform[`${axis}${i}`]).reduce(
                (sum, [key, weight]) => sum + weight * unit[key],
                0,
            ),
        )
    const [bl, , tr] = [1, 2, 3].map(corner)
    return [bl[0], tr[0], bl[1], tr[1]]
}

// A slice of a note `width` lanes wide at tilt 0: its quad's width in lanes, by part.
const sliceWidth = (part, width, edge) =>
    part === 'Middle' ? Math.max(width - 2 * edge, 0) : Math.min(edge, width / 2)

// Lanes per texture pixel across and down a sprite drawn on its slice.
function scale(name, part, width, edge) {
    const sprite = sprites.get(name)
    const [u0, u1, v0, v1] = spriteBox(sprite)
    return {
        x: ((u1 - u0) * sliceWidth(part, width, edge)) / sprite.w,
        y: (v1 - v0) / sprite.h,
    }
}

const pixel = (name, column, row) => {
    const { x, y } = sprites.get(name)
    return pixelAt(texture, x + column, y + row)
}
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// Steps from an edge along a line of pixels: where the art starts (alpha one half) and how many
// pixels on it are nearer the border colour than the face's.
function border(name, line, face) {
    const start = line.findIndex(([, , , a]) => a >= 128)
    const rim = line[start]
    let end = start
    while (end < line.length && distance(line[end], rim) <= distance(line[end], face)) end++
    return { start, pixels: end - start }
}

const row = (name, at, reverse = false) => {
    const { w } = sprites.get(name)
    const line = Array.from({ length: w }, (_, i) => pixel(name, i, at))
    return reverse ? line.reverse() : line
}
const column = (name, at, reverse = false) => {
    const { h } = sprites.get(name)
    const line = Array.from({ length: h }, (_, i) => pixel(name, at, i))
    return reverse ? line.reverse() : line
}

// The four borders of a bordered body family, in lanes: the end slices' sides along their middle
// row, the middle slice's top and bottom down its middle column.
function borders(prefix, suffix, width) {
    const name = (part) => `${prefix} ${part}${suffix}`
    const middle = name('Middle')
    const { w: mw, h: mh } = sprites.get(middle)
    const face = pixel(middle, mw >> 1, mh >> 1)
    const left = name('Left')
    const { w: lw, h: lh } = sprites.get(left)
    // The face at the slice's inner end, on a row clear of the mark.
    const sideFace = pixel(left, lw - 2, Math.round(lh * 0.3))
    const sx = scale(left, 'Left', width, 0.25)
    const sy = scale(middle, 'Middle', width, 0.25)
    const right = name('Right')
    return {
        left: border(left, row(left, Math.round(lh * 0.3)), sideFace).pixels * sx.x,
        right: border(right, row(right, Math.round(lh * 0.3), true), sideFace).pixels * sx.x,
        top: border(middle, column(middle, mw >> 1), face).pixels * sy.y,
        bottom: border(middle, column(middle, mw >> 1, true), face).pixels * sy.y,
    }
}

// The corner's radius estimated across and down: on the first row of the art (its centre half a
// pixel in) the outline starts i in from the side, which a circle of radius r gives at depth d when
// r = i + d + sqrt(2 i d); likewise down the first column. A round corner gives the same both ways.
function cornerRadii(name, part, width, edge) {
    const { w, h } = sprites.get(name)
    const s = scale(name, part, width, edge)
    const opaque = ([, , , a]) => a >= 128
    const left = row(name, h >> 1).findIndex(opaque)
    const top = column(name, w - 1).findIndex(opaque)
    const across = (row(name, top).findIndex(opaque) - left) * s.x
    const down = (column(name, left).findIndex(opaque) - top) * s.y
    const radius = (inset, depth) => inset + depth + Math.sqrt(2 * inset * depth)
    return {
        across: radius(across, s.y / 2),
        down: radius(down, s.x / 2),
        step: Math.max(s.x, s.y),
    }
}

const bordered = [
    ['Sekai Normal Note', ''],
    ['Sekai Slide Note', ''],
    ['Sekai Flick Note', ''],
    ['Sekai Critical Note', ''],
    ['Sekai Critical Flick Note', ' Red'],
    ['Sekai Normal Note', ' Purple'],
    ['Sekai Damage Note', ''],
    ['Sekai Damage Note', ' Blue'],
]

test('note borders render as thick on every side at stage tilt 0', () => {
    for (const [prefix, suffix] of bordered)
        for (const width of widths) {
            const sides = borders(prefix, suffix, width)
            const values = Object.values(sides)
            assert.ok(Math.min(...values) > 0, `${prefix}${suffix}: no border`)
            for (const [size, perLane] of Object.entries(lanePixels)) {
                const spread = (Math.max(...values) - Math.min(...values)) * perLane
                assert.ok(
                    spread <= 1,
                    `${prefix}${suffix}, width ${width}, ${size}: ` +
                        `${JSON.stringify(sides, (_, v) => (typeof v === 'number' ? +(v * perLane).toFixed(2) : v))} px`,
                )
            }
        }
})

test('note ends have round corners at stage tilt 0', () => {
    const ends = [
        ['Sekai Normal Note Left', 0.25],
        ['Sekai Critical Note Left', 0.25],
        ['Sekai Damage Note Left', 0.25],
        ['Sekai Normal Trace Note Left', 0.125],
        ['Sekai Critical Trace Note Left Yellow', 0.125],
    ]
    for (const [name, edge] of ends)
        for (const width of widths) {
            const { across, down, step } = cornerRadii(name, 'Left', width, edge)
            assert.ok(across > 0 && down > 0, `${name}: square corner`)
            for (const [size, perLane] of Object.entries(lanePixels))
                assert.ok(
                    Math.abs(across - down) * perLane <= 1 + step * perLane,
                    `${name}, width ${width}, ${size}: ${(across * perLane).toFixed(2)} px radius across, ${(down * perLane).toFixed(2)} px down`,
                )
        }
})
