import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuiltinItem } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

// Where each sprite's art (alpha at least one half) lands in the engine's quad, 0 to 1 from the
// quad's bottom-left corner, after the sprite's transform: [x0, x1, y0, y1]. The targets were
// measured the same way on the base skin (Next SEKAI 01), so ours draws at its size on screen.
const targets = {
    'Sekai Normal Note Left': [-0.14, 1, -0.06, 1.06],
    'Sekai Normal Note Middle': [0, 1, -0.06, 1.06],
    'Sekai Normal Note Right': [0, 1.14, -0.06, 1.06],
    'Sekai Critical Flick Note Left Red': [-0.14, 1, -0.06, 1.06],
    'Sekai Normal Trace Note Left Neutral': [-0.14, 1, 0.19, 0.81],
    'Sekai Normal Trace Note Middle Neutral': [0, 1, 0.19, 0.81],
    'Sekai Normal Trace Note Right Neutral': [0, 1.14, 0.19, 0.81],
    'Sekai Damage Note Middle': [0, 1, 0.05, 0.95],
    '#SIMULTANEOUS_CONNECTION_NEUTRAL': [0, 1, 0.44, 0.56],
    'Sekai Diamond Green': [-0.12, 1.1, 0.22, 1.12],
    'Sekai Normal Trace Diamond Neutral': [-0.05, 1.05, 0.27, 1.02],
    'Sekai Slot Glow Cyan': [0, 1, 0.02, 0.69],
    'Sekai Active Slide Connection Green': [0.02, 0.98, 0, 1],
    'Sekai Guide Neutral': [0, 1, 0, 1],
    'Sekai Judgment Gradient Neutral': [0, 1, 0, 1],
    'Sekai Flick Arrow Up 1': [-0.14, 1.14, 0.25, 1.61],
    'Sekai Flick Arrow Up 6': [-0.03, 1.03, 0.06, 0.64],
    'Sekai Flick Arrow Up Left 1': [-0.32, 1.32, 0.27, 1.66],
    'Sekai Flick Arrow Up Left 6': [-0.13, 1.09, 0.07, 0.75],
    'Sekai Flick Arrow Down 1': [-0.14, 1.14, 0.18, 1.55],
    'Sekai Flick Arrow Down 3': [-0.07, 1.07, 0.07, 0.9],
    'Sekai Flick Arrow Down Left 2': [-0.24, 1.21, 0.11, 1.18],
    'Sekai Critical Flick Arrow Up 1 Neutral': [-0.16, 1.16, 0.23, 1.64],
}
const tolerance = 0.05

const skin = readBuiltinItem('skin')
const texture = decode(skin.resource('texture'))
const sprites = new Map(skin.json('data').sprites.map((sprite) => [sprite.name, sprite]))

// The quad's corners after the transform, for the unit quad: bl, tl, tr, br.
const unit = { x1: 0, x2: 0, x3: 1, x4: 1, y1: 0, y2: 1, y3: 1, y4: 0 }
const corner = (transform, i) =>
    ['x', 'y'].map((axis) =>
        Object.entries(transform[`${axis}${i}`]).reduce(
            (sum, [key, weight]) => sum + weight * unit[key],
            0,
        ),
    )

function extent(name) {
    const { x, y, w, h, transform } = sprites.get(name)
    let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity]
    for (let row = 0; row < h; row++)
        for (let column = 0; column < w; column++)
            if (pixelAt(texture, x + column, y + row)[3] >= 128) {
                u0 = Math.min(u0, column / w)
                u1 = Math.max(u1, (column + 1) / w)
                v0 = Math.min(v0, 1 - (row + 1) / h)
                v1 = Math.max(v1, 1 - row / h)
            }
    const [bl, tl, tr, br] = [1, 2, 3, 4].map((i) => corner(transform, i))
    const at = (u, v) => {
        const bottom = bl.map((value, k) => value + (br[k] - value) * u)
        const top = tl.map((value, k) => value + (tr[k] - value) * u)
        return bottom.map((value, k) => value + (top[k] - value) * v)
    }
    const points = [at(u0, v0), at(u0, v1), at(u1, v0), at(u1, v1)]
    const xs = points.map(([px]) => px)
    const ys = points.map(([, py]) => py)
    return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
}

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
