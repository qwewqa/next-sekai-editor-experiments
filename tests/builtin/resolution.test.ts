import assert from 'node:assert/strict'
import { test } from 'node:test'
import { particleSprites } from '../../builtin-assets/manifest.mjs'
import {
    approach,
    createLayout,
    createViewport,
    defaultCameraInfo,
    FlickDirection,
    layoutFlickArrow,
    layoutSlotEffect,
    layoutTick,
} from '../../src/preview/engine/layout'
import type { Quad, Vec } from '../../src/preview/engine/math'
import { readBuiltinItem } from './helpers.mjs'

// Texels per lane on screen, along the axis that carries the detail, for the sharp sprites that
// draw largest: each sprite's texture over its frame, the frame placed by its transform on the
// quad the engine draws it in (default camera, on the judge line). The floors keep the art at or
// near the base set's density, so a later shrink to fit the atlas shows here.

type Sprite = {
    name: string
    w: number
    h: number
    transform: Record<string, Record<string, number>>
}

const skin = readBuiltinItem('skin')
const sprites = (skin.json('data') as { sprites: Sprite[] }).sprites

const layout = createLayout(createViewport(1600, 900), defaultCameraInfo(), false)
const travel = approach(layout, 1)
const length = (a: Vec, b: Vec) => Math.hypot(b.x - a.x, b.y - a.y)
const cell = layoutSlotEffect(layout, 0)
// Quads in perspective are measured across their middle.
const lane = (length(cell.bl, cell.br) + length(cell.tl, cell.tr)) / 2

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
const across = (sprite: Sprite, quad: Quad) => {
    const [bl, tl, tr, br] = place(sprite, quad)
    return sprite.w / ((length(tl!, tr!) + length(bl!, br!)) / 2 / lane)
}
const along = (sprite: Sprite, quad: Quad) => {
    const [bl, tl, tr, br] = place(sprite, quad)
    return sprite.h / ((length(bl!, tl!) + length(br!, tr!)) / 2 / lane)
}

const lowest = (pattern: RegExp, density: (sprite: Sprite) => number) => {
    const matched = sprites.filter(({ name }) => pattern.test(name))
    assert.ok(matched.length > 0, String(pattern))
    return Math.min(...matched.map(density))
}

test('flick arrows of every width keep 84 texels per lane', () => {
    for (let width = 1; width <= 6; width++) {
        const quad = layoutFlickArrow(layout, 0, width / 2, FlickDirection.upOmni, travel, 0)
        const pattern = new RegExp(`Flick Arrow (Up|Down)( Left)? ${width}( |$)`)
        const density = lowest(pattern, (sprite) => across(sprite, quad))
        assert.ok(density >= 83.5, `width ${width}: ${density.toFixed(1)}`)
    }
})

test('diamonds, ticks, slots and the sim line keep their densities', () => {
    const tick = layoutTick(layout, 0, travel)
    const floors: [RegExp, (sprite: Sprite) => number, number][] = [
        [/Slide Diamond|^Sekai Diamond |^#NOTE_TICK_/, (sprite) => across(sprite, tick), 140],
        [/Trace.*Diamond/, (sprite) => across(sprite, tick), 105],
        [/^Sekai Slot (?!Glow)/, (sprite) => across(sprite, cell), 120],
        [/^#SIMULTANEOUS_CONNECTION_NEUTRAL$/, (sprite) => along(sprite, cell), 200],
    ]
    for (const [pattern, density, floor] of floors) {
        const value = lowest(pattern, density)
        assert.ok(value >= floor, `${pattern}: ${value.toFixed(1)}`)
    }
})

test('the particle strokes keep their texels', () => {
    const particle = readBuiltinItem('particle').json('data') as {
        sprites: { w: number; h: number }[]
    }
    const size = (name: string) => {
        const { w, h } = particle.sprites[particleSprites.findIndex((s) => s.name === name)]!
        return Math.max(w, h)
    }
    for (const name of ['frame', 'line', 'plate', 'ring', 'arc', 'needle'])
        assert.ok(size(name) >= 256, name)
    for (const name of ['flare', 'sparkle']) assert.ok(size(name) >= 128, name)
})
