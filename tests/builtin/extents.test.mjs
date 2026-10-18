import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuiltinItem } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

// Where each sprite's art (alpha at least one half) lands in the engine's quad, 0 to 1 from the
// quad's bottom-left corner, after the sprite's transform: [x0, x1, y0, y1]. The targets were
// measured the same way on the base skin (Next SEKAI 01), so ours draws at its size on screen.
// Note bodies fill their quads, as the base's opaque bodies do (its dark glow left out), so a note
// one lane wide on the judge line covers its slot cell; traces and damage keep the base's heights.
const targets = {
    'Sekai Normal Note Left': [0, 1, 0, 1],
    'Sekai Normal Note Middle': [0, 1, 0, 1],
    'Sekai Normal Note Right': [0, 1, 0, 1],
    'Sekai Critical Flick Note Left Red': [0, 1, 0, 1],
    'Sekai Normal Trace Note Left Neutral': [0, 1, 0.25, 0.75],
    'Sekai Normal Trace Note Middle Neutral': [0, 1, 0.25, 0.75],
    'Sekai Normal Trace Note Right Neutral': [0, 1, 0.25, 0.75],
    'Sekai Damage Note Middle': [0, 1, 0.19, 0.81],
    '#SIMULTANEOUS_CONNECTION_NEUTRAL': [0, 1, 0.44, 0.56],
    'Sekai Diamond Green': [-0.12, 1.1, 0.22, 1.12],
    'Sekai Normal Trace Diamond Neutral': [-0.05, 1.05, 0.27, 1.02],
    'Sekai Slot Glow Cyan': [0, 1, 0.02, 0.69],
    'Sekai Active Slide Connection Green': [0.02, 0.98, 0, 1],
    'Sekai Guide Neutral': [0, 1, 0, 1],
    'Sekai Judgment Gradient Neutral': [0, 1, 0, 1],
    'Sekai Flick Arrow Up 1': [-0.14, 1.14, 0.25, 1.61],
    'Sekai Flick Arrow Up 6': [-0.03, 1.03, 0.06, 0.64],
    'Sekai Flick Arrow Down 1': [-0.14, 1.14, 0.18, 1.55],
    'Sekai Flick Arrow Down 3': [-0.07, 1.07, 0.07, 0.9],
    'Sekai Flick Arrow Up Left 1': [-0.32, 1.32, 0.27, 1.66],
    'Sekai Flick Arrow Up Left 6': [-0.13, 1.09, 0.07, 0.75],
    'Sekai Flick Arrow Down Left 2': [-0.24, 1.21, 0.11, 1.18],
    'Sekai Critical Flick Arrow Up 1 Neutral': [-0.14, 1.14, 0.25, 1.61],
}
const tolerance = 0.06

// The base's arrows by width (1 to 6), measured in the arrow square: the area its pink inks
// (rim and white plate left out) and its whole area at alpha one half or more (with the plate),
// the lower edge, and the horizontal span. Down arrows match their up arrows.
const baseArrows = {
    Up: {
        pink: [1.1, 0.71, 0.49, 0.35, 0.28, 0.23],
        whole: [1.47, 0.97, 0.68, 0.53, 0.44, 0.38],
        span: [-0.13, 1.12, -0.08, 1.08, -0.07, 1.07, -0.04, 1.05, -0.03, 1.03, -0.03, 1.03],
    },
    'Up Left': {
        pink: [1.11, 0.72, 0.48, 0.36, 0.29, 0.24],
        whole: [1.64, 1.12, 0.84, 0.69, 0.59, 0.54],
        span: [-0.31, 1.31, -0.23, 1.2, -0.19, 1.15, -0.17, 1.12, -0.14, 1.09, -0.13, 1.09],
    },
}

const skin = readBuiltinItem('skin')
const texture = decode(skin.resource('texture'))
const sprites = new Map(skin.json('data').sprites.map((sprite) => [sprite.name, sprite]))

// A transform applied to a quad's corners { x1..x4, y1..y4 } (bl, tl, tr, br): [bl, tl, tr, br].
const apply = (transform, quad) =>
    [1, 2, 3, 4].map((i) =>
        ['x', 'y'].map((axis) =>
            Object.entries(transform[`${axis}${i}`]).reduce(
                (sum, [key, weight]) => sum + weight * quad[key],
                0,
            ),
        ),
    )
const unit = { x1: 0, x2: 0, x3: 1, x4: 1, y1: 0, y2: 1, y3: 1, y4: 0 }

// The point at (u, v) of a quad [bl, tl, tr, br], bilinearly.
const at = ([bl, tl, tr, br], u, v) => {
    const bottom = bl.map((value, k) => value + (br[k] - value) * u)
    const top = tl.map((value, k) => value + (tr[k] - value) * u)
    return bottom.map((value, k) => value + (top[k] - value) * v)
}

// The box [u0, u1, v0, v1] of a sprite's pixels at alpha threshold or more, 0 to 1 from its
// bottom-left, and the pixels themselves.
function inked(name, threshold = 128) {
    const { x, y, w, h } = sprites.get(name)
    let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity]
    let count = 0
    for (let row = 0; row < h; row++)
        for (let column = 0; column < w; column++)
            if (pixelAt(texture, x + column, y + row)[3] >= threshold) {
                count++
                u0 = Math.min(u0, column / w)
                u1 = Math.max(u1, (column + 1) / w)
                v0 = Math.min(v0, 1 - (row + 1) / h)
                v1 = Math.max(v1, 1 - row / h)
            }
    return { box: [u0, u1, v0, v1], share: count / (w * h) }
}

function extent(name, quad = unit) {
    const corners = apply(sprites.get(name).transform, quad)
    const [u0, u1, v0, v1] = inked(name).box
    const points = [
        at(corners, u0, v0),
        at(corners, u0, v1),
        at(corners, u1, v0),
        at(corners, u1, v1),
    ]
    const xs = points.map(([px]) => px)
    const ys = points.map(([, py]) => py)
    return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
}

const area = (points) =>
    Math.abs(
        points.reduce((sum, [x, y], i) => {
            const [nx, ny] = points[(i + 1) % points.length]
            return sum + x * ny - nx * y
        }, 0),
    ) / 2

test('sprites land where the base skin’s do in the engine’s quads', () => {
    for (const [name, target] of Object.entries(targets)) {
        const got = extent(name)
        for (let i = 0; i < 4; i++)
            assert.ok(
                Math.abs(got[i] - target[i]) <= tolerance,
                `${name}: ${got.map((value) => value.toFixed(2))} against ${target}`,
            )
    }
})

test('flick arrows ink about as much as the base’s, within its span and above its lower edge', () => {
    for (const [direction, base] of Object.entries(baseArrows))
        for (const flipped of [direction, direction.replace('Up', 'Down')])
            for (let width = 1; width <= 6; width++) {
                const name = `Sekai Flick Arrow ${flipped} ${width}`
                const inkedArea = area(apply(sprites.get(name).transform, unit)) * inked(name).share
                const [pink, whole] = [base.pink[width - 1], base.whole[width - 1]]
                assert.ok(
                    inkedArea >= pink && inkedArea <= whole,
                    `${name}: inks ${inkedArea.toFixed(2)}, the base ${pink} to ${whole}`,
                )
                const [x0, x1] = extent(name)
                const [s0, s1] = base.span.slice(2 * width - 2, 2 * width)
                assert.ok(
                    x0 >= s0 - 0.03 && x1 <= s1 + 0.03,
                    `${name}: ${x0.toFixed(2)} to ${x1.toFixed(2)}, the base ${s0} to ${s1}`,
                )
            }
})

// A whole note at the stage's right edge, in a perspective quad like the engine's (the far edge
// narrower): Left, Middle and Right side by side, edges 0.25 lane (slim 0.125), in lanes.
function noteSlices(width, edge) {
    const [r, l] = [6, 6 - width]
    const middle = (l + r) / 2
    const cuts = [l, Math.min(l + edge, middle), Math.max(r - edge, middle), r]
    const [near, far, height] = [1, 0.9, 0.3]
    return [0, 1, 2].map((i) => ({
        x1: cuts[i] * near,
        x2: cuts[i] * far,
        x3: cuts[i + 1] * far,
        x4: cuts[i + 1] * near,
        y1: 0,
        y2: height,
        y3: height,
        y4: 0,
    }))
}

test('whole notes stay inside their lanes at every width, joined at the slices', () => {
    for (const [family, edge] of [
        ['Sekai Normal Note', 0.25],
        ['Sekai Critical Flick Note', 0.25],
        ['Sekai Normal Note {} Purple', 0.25],
        ['Sekai Normal Trace Note {} Neutral', 0.125],
        ['Sekai Damage Note', 0.125],
    ])
        for (const width of [1, 2, 3, 6, 12]) {
            const quads = noteSlices(width, edge)
            const names = ['Left', 'Middle', 'Right'].map((part) =>
                family.includes('{}') ? family.replace('{}', part) : `${family} ${part}`,
            )
            const frames = names.map((name, i) => apply(sprites.get(name).transform, quads[i]))
            const label = `${names[1]} at width ${width}`
            // Neighbouring slices share their frames' corners, top and bottom.
            for (const [a, b] of [
                [0, 1],
                [1, 2],
            ])
                for (const [ours, theirs] of [
                    [3, 0],
                    [2, 1],
                ])
                    for (let k = 0; k < 2; k++)
                        assert.ok(
                            Math.abs(frames[a][ours][k] - frames[b][theirs][k]) < 1e-9,
                            `${label}: slices ${a} and ${b} part`,
                        )
            // Nothing is drawn past the note's ends (the base's body ends there) on any row, the
            // lines through them included, and the ends stop at most 0.03 lane inside them.
            const scale = (y) => 1 - (0.1 * y) / 0.3
            const reach = names.map((name, i) => {
                const [u0, u1, v0, v1] = inked(name).box
                const points = [v0, v1].flatMap((v) => [u0, u1].map((u) => at(frames[i], u, v)))
                const inside = points.map(([x, y]) => [
                    x - (6 - width) * scale(y),
                    6 * scale(y) - x,
                ])
                return [Math.min(...inside.map(([l]) => l)), Math.min(...inside.map(([, r]) => r))]
            })
            for (const [i, [l, r]] of reach.entries())
                assert.ok(l >= -1e-6 && r >= -1e-6, `${label}: slice ${i} is past an end`)
            assert.ok(reach[0][0] <= 0.03 && reach[2][1] <= 0.03, `${label}: ends`)
            assert.ok(reach[1][0] >= reach[0][0] && reach[1][1] >= reach[2][1], `${label}: middle`)
        }
})
