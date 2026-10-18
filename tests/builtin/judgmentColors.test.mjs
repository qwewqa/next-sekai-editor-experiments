import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuiltinItem } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

// The base skin's (Next SEKAI 01) judgment line, sampled from its texture: per colour the Edge and
// Center solids and its 100 texel Gradient at texels 0, 25, 50, 75 and 99 (stage edge to centre).
// It has no coloured bands, single lines or end caps: the engine falls back to its one Background
// (black at 0.57) and to Edge, so ours must match those too.
const base = {
    Neutral: ['#afafaf', '#cacaca', '#afafaf', '#b6b6b6', '#bdbdbd', '#c4c4c4', '#cacaca'],
    Red: ['#ff186f', '#fa72ab', '#ff186f', '#fe2f7e', '#fc468e', '#fb5c9d', '#fa72ab'],
    Green: ['#4dff00', '#b1ff00', '#4dff00', '#67ff00', '#7fff00', '#98ff00', '#b1ff00'],
    Blue: ['#009fff', '#00dfff', '#00a0ff', '#00afff', '#00bfff', '#00cfff', '#00deff'],
    Yellow: ['#ffff00', '#ecff9b', '#ffff01', '#faff28', '#f5ff4e', '#f1ff75', '#ecff9a'],
    Purple: ['#c85fff', '#a694ff', '#c85fff', '#bf6dff', '#b77aff', '#ae88ff', '#a694ff'],
    Cyan: ['#00f9ff', '#8ffcff', '#01f9ff', '#24f9ff', '#48fbff', '#6cfcff', '#8efcff'],
    Black: ['#000000', '#222222', '#000000', '#080808', '#121212', '#1a1a1a', '#212121'],
}
const band = { color: '#000000', alpha: 0.57 }
const stops = [0, 25, 50, 75, 99].map((texel) => (texel + 0.5) / 100)

const skin = readBuiltinItem('skin')
const texture = decode(skin.resource('texture'))
const sprites = new Map(skin.json('data').sprites.map((sprite) => [sprite.name, sprite]))

const sample = (name, u = 0.5) => {
    const { x, y, w, h } = sprites.get(name)
    return pixelAt(texture, x + Math.min(w - 1, Math.floor(u * w)), y + (h >> 1))
}
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

// CIE L*a*b* (D65) and the CIE76 difference.
const lab = ([r, g, b]) => {
    const linear = [r, g, b].map((c) => {
        const v = c / 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    const [lr, lg, lb] = linear
    const xyz = [
        (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047,
        0.2126 * lr + 0.7152 * lg + 0.0722 * lb,
        (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883,
    ].map((t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116))
    return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])]
}
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]))
const limit = 2

const close = (name, got, want) => {
    const d = deltaE(got, rgb(want))
    assert.ok(
        d <= limit,
        `${name}: ${got.slice(0, 3)} against the base’s ${want}, ΔE ${d.toFixed(2)}`,
    )
}

test('judgment line colours match the base’s within a small ΔE', () => {
    for (const [color, [edge, centre, ...gradient]] of Object.entries(base)) {
        close(`Edge ${color}`, sample(`Sekai Judgment Edge ${color}`), edge)
        close(`Center ${color}`, sample(`Sekai Judgment Center ${color}`), centre)
        close(`Single Line ${color}`, sample(`Sekai Judgment Single Line ${color}`), edge)
        close(`Edge Left ${color}`, sample(`Sekai Judgment Edge Left ${color}`), edge)
        stops.forEach((u, i) =>
            close(
                `Gradient ${color} at ${u}`,
                sample(`Sekai Judgment Gradient ${color}`, u),
                gradient[i],
            ),
        )
        for (const name of ['Sekai Judgment Background', `Sekai Judgment Background ${color}`]) {
            const got = sample(name)
            close(name, got, band.color)
            assert.ok(Math.abs(got[3] / 255 - band.alpha) <= 0.01, `${name}: alpha ${got[3]}`)
        }
    }
})
