import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
    approach,
    createLayout,
    createViewport,
    defaultCameraInfo,
    layoutRegularNoteBody,
    layoutSlimNoteBody,
    layoutSlotEffect,
} from '../../src/preview/engine/layout'
import type { Quad, Vec } from '../../src/preview/engine/math'
import { readBuiltinItem } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

// A note one lane wide (size 0.5) on the judge line has the same quad as its lane's slot cell
// (layout_slot_effect: lane ± 0.5, 1 ± note_h), at every stage tilt. The base skin's opaque body
// fills that quad (its lower band, the note's side face, included), so ours must too: the art,
// mapped through each slice's transform onto the engine's slice quads, lands on the cell's edges.
// Traces and damage keep the base's heights through the cell's middle.

type Sprite = {
    name: string
    x: number
    y: number
    w: number
    h: number
    transform: Record<string, Record<string, number>>
}

const skin = readBuiltinItem('skin')
const texture = decode(skin.resource('texture'))
const sprites = new Map<string, Sprite>(
    (skin.json('data') as { sprites: Sprite[] }).sprites.map((sprite) => [sprite.name, sprite]),
)
const sprite = (name: string) => {
    const found = sprites.get(name)
    assert.ok(found, name)
    return found
}

// A transform applied to a quad: its corners [bl, tl, tr, br].
const place = ({ transform }: Sprite, quad: Quad): Vec[] => {
    const value = { x1: quad.bl.x, y1: quad.bl.y, x2: quad.tl.x, y2: quad.tl.y }
    Object.assign(value, { x3: quad.tr.x, y3: quad.tr.y, x4: quad.br.x, y4: quad.br.y })
    const of = (key: string) =>
        Object.entries(transform[key]!).reduce(
            (sum, [k, weight]) => sum + weight * value[k as keyof typeof value],
            0,
        )
    return [1, 2, 3, 4].map((i) => ({ x: of(`x${i}`), y: of(`y${i}`) }))
}
// The point at (u, v) of corners [bl, tl, tr, br], bilinearly.
const at = ([bl, tl, tr, br]: Vec[], u: number, v: number) => {
    const bottom = { x: bl!.x + (br!.x - bl!.x) * u, y: bl!.y + (br!.y - bl!.y) * u }
    const top = { x: tl!.x + (tr!.x - tl!.x) * u, y: tl!.y + (tr!.y - tl!.y) * u }
    return { x: bottom.x + (top.x - bottom.x) * v, y: bottom.y + (top.y - bottom.y) * v }
}

// The box [u0, u1, v0, v1] of a sprite's pixels that pass, 0 to 1 from its bottom-left.
function inked(
    { x, y, w, h }: Sprite,
    passes = (pixel: number[]) => pixel[3]! >= 128,
): [number, number, number, number] {
    let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity]
    for (let row = 0; row < h; row++)
        for (let column = 0; column < w; column++)
            if (passes(pixelAt(texture, x + column, y + row))) {
                u0 = Math.min(u0, column / w)
                u1 = Math.max(u1, (column + 1) / w)
                v0 = Math.min(v0, 1 - (row + 1) / h)
                v1 = Math.max(v1, 1 - row / h)
            }
    return [u0, u1, v0, v1]
}

// The rendered art of a three-slice note as its screen box, and the cell's.
const bounds = (points: Vec[]) => {
    const xs = points.map(({ x }) => x)
    const ys = points.map(({ y }) => y)
    return { l: Math.min(...xs), r: Math.max(...xs), b: Math.min(...ys), t: Math.max(...ys) }
}
function rendered(prefix: string, suffix: string, quads: Quad[]) {
    const points = ['Left', 'Middle', 'Right'].flatMap((part, i) => {
        const s = sprite(`${prefix} ${part}${suffix}`)
        const corners = place(s, quads[i]!)
        const [u0, u1, v0, v1] = inked(s)
        // An empty middle slice adds nothing.
        if (quads[i]!.br.x - quads[i]!.bl.x < 1e-9) return []
        return [at(corners, u0, v0), at(corners, u0, v1), at(corners, u1, v0), at(corners, u1, v1)]
    })
    return bounds(points)
}

const tilts = [0, 0.5, 1]
const viewports = [createViewport(1600, 900), createViewport(390, 844)]
const families: [string, string, number][] = [
    ['Sekai Normal Note', '', 1],
    ['Sekai Critical Note', '', 1],
    ['Sekai Flick Note', '', 1],
    ['Sekai Slide Note', '', 1],
    ['Sekai Critical Flick Note', ' Purple', 1],
    // The base's trace bar (its band included) and its damage bar (its dark rim left out) are half
    // the cell's height.
    ['Sekai Normal Trace Note', '', 0.5],
    ['Sekai Critical Trace Note', ' Red', 0.5],
    ['Sekai Damage Note', '', 0.5],
    ['Sekai Damage Note', ' Blue', 0.5],
]

test('a note one lane wide on the judge line covers its slot cell at every stage tilt', () => {
    for (const viewport of viewports)
        for (const stageTilt of tilts) {
            const layout = createLayout(viewport, { ...defaultCameraInfo(), stageTilt }, false)
            const travel = approach(layout, 1)
            const cell = bounds(Object.values(layoutSlotEffect(layout, 0)))
            const width = cell.r - cell.l
            const height = cell.t - cell.b
            for (const [prefix, suffix, share] of families) {
                const slim = prefix.includes('Trace')
                const quads = (slim ? layoutSlimNoteBody : layoutRegularNoteBody)(
                    layout,
                    0,
                    0.5,
                    travel,
                )
                const art = rendered(prefix, suffix, quads)
                const label = `${prefix}${suffix} at tilt ${stageTilt}`
                const near = (got: number, want: number, of: number, what: string) =>
                    assert.ok(
                        Math.abs(got - want) <= 0.03 * of,
                        `${label}, ${what}: ${((got - want) / of).toFixed(3)} of the cell off`,
                    )
                near(art.l, cell.l, width, 'left')
                near(art.r, cell.r, width, 'right')
                near(art.t - art.b, share * height, height, 'height')
                near((art.t + art.b) / 2, (cell.t + cell.b) / 2, height, 'middle')
            }
        }
})

test('a one lane note is square on screen at stage tilt 0', () => {
    const layout = createLayout(
        createViewport(1600, 900),
        { ...defaultCameraInfo(), stageTilt: 0 },
        false,
    )
    const art = rendered(
        'Sekai Normal Note',
        '',
        layoutRegularNoteBody(layout, 0, 0.5, approach(layout, 1)),
    )
    const ratio = (art.r - art.l) / (art.t - art.b)
    assert.ok(Math.abs(ratio - 1) <= 0.03, `width over height ${ratio.toFixed(3)}`)
})

// The base's mark (Note Cyan Left, a lane 144 texels across): from its border's inner edge, 0.069
// lane in from the note's edge, to 0.236 lane, over the middle third of its face's height (its
// face from the top of its border to the bottom of its lower border, its band left out). Ours has
// no band, so its face is the cell: the mark sits over the middle third of the cell.
const baseMark = { from: 0.069, to: 0.236, bottom: 1 / 3, top: 2 / 3 }

test("note marks fill the end of the note the way the base's do", () => {
    const hex = (color: string) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    for (const [name, accent] of [
        ['Sekai Normal Note Left', '#8394f6'],
        ['Sekai Critical Note Left', '#fed84b'],
        ['Sekai Flick Note Left', '#f89cc2'],
        ['Sekai Normal Note Left Purple', '#bd66ee'],
    ] as const) {
        const target = hex(accent)
        const s = sprite(name)
        const [u0, u1, v0, v1] = inked(
            s,
            (pixel) => pixel[3]! >= 128 && Math.hypot(...target.map((c, i) => c - pixel[i]!)) <= 24,
        )
        // The slice is 0.25 lane wide; its sprite box maps its art onto the slice's quad.
        const corners = place(s, {
            bl: { x: 0, y: 0 },
            tl: { x: 0, y: 1 },
            tr: { x: 1, y: 1 },
            br: { x: 1, y: 0 },
        })
        const from = at(corners, u0, v0)
        const to = at(corners, u1, v1)
        const got = { from: from.x * 0.25, to: to.x * 0.25, bottom: from.y, top: to.y }
        for (const key of ['from', 'to'] as const)
            assert.ok(
                Math.abs(got[key] - baseMark[key]) <= 0.01,
                `${name}: mark ${key} ${got[key].toFixed(3)} lane, the base's ${baseMark[key]}`,
            )
        for (const key of ['bottom', 'top'] as const)
            assert.ok(
                Math.abs(got[key] - baseMark[key]) <= 0.02,
                `${name}: mark ${key} ${got[key].toFixed(3)} of the cell, the base's ${baseMark[key].toFixed(3)}`,
            )
    }
})
