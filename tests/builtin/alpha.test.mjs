import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuiltinItem } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

// Pixels from a transparent pixel or the sprite's border that count as the antialiased edge.
const edgeBand = 2

// Diamonds and ticks, the sprites that draw a kite.
const kites = /Diamond|^#NOTE_TICK_/

// Sprites translucent by design, each because the base skin's (Next SEKAI 01) same sprite is.
// floor is the least alpha the brightest interior pixel must keep, so none of them turns faint;
// opaque, if given, the least share of interior pixels at full alpha.
const translucent = [
    // The base's lane is dark navy at 0.40 alpha, over the background. Ours, in every color, is too.
    {
        pattern:
            /^Sekai Lane Background( Preview)?( [A-Z][a-z]+)?$|^#LANE(_ALTERNATIVE)?(_SEAMLESS)?$|^#STAGE_MIDDLE$/,
        floor: 0.4,
    },
    // The base's dividers are grey-white at 0.36 and its borders white at 0.21. Its standard stage
    // edges and corners are lines at 0.3, and its preview-mode border for stage changes a 3 px ramp
    // up to 0.59 at the stage edge.
    {
        pattern:
            /^Sekai (Lane Divider|Stage Border)( Preview)?$|^#STAGE_(LEFT|RIGHT|TOP|BOTTOM)_BORDER(_SEAMLESS)?$|^#STAGE_.*_CORNER$/,
        floor: 0.25,
    },
    // The base's judgment background is black at 0.57, darkening the lane under the line.
    { pattern: /^Sekai Judgment Background/, floor: 0.5 },
    // The base's fallback judge line has opaque lines round a dark middle at 0.6.
    { pattern: /^#JUDGMENT_LINE$/, floor: 1, opaque: 0.25 },
    // The base's slide, damage and standard connections are at 0.8 with feathered sides.
    { pattern: /Slide Connection|^#NOTE_CONNECTION_/, floor: 0.78 },
    // The base's slot glows run from 0.98 at the note to clear.
    { pattern: /Slot Glow/, floor: 0.9 },
    // The base's slots are a translucent lit fill inside an opaque outline.
    { pattern: /^Sekai Slot (?!Glow)/, floor: 1 },
    // The base's flick arrows glow softly round an opaque arrowhead: inside the glow (alpha under
    // core), the arrowhead itself is opaque. The Built-in arrows glow strongly next to the rim's
    // soft outer edge, up to about 0.945 alpha, so core stays below that. At 0.95 an arrow whose
    // rim fill is missing would pass, as the glow under it would not count.
    { pattern: /Arrow|^#DIRECTIONAL_MARKER/, floor: 1, opaque: 0.99, core: 0.92 },
    // The base's diamonds and ticks fade into their glow round an opaque kite. Ours fade over a soft
    // outline, and the critical ones also glow. Inside that edge (alpha under core), the kite is
    // opaque.
    {
        pattern: kites,
        floor: 1,
        opaque: 0.99,
        core: 0.5,
    },
    // The base's critical bodies and traces glow round opaque art, the same way.
    {
        pattern:
            /^Sekai Critical .*Note (Left|Middle|Right)|^Sekai (Trace )?Note Yellow (Left|Middle|Right)$/,
        floor: 1,
        opaque: 0.99,
        core: 0.5,
    },
    // The base's damage notes glow round opaque art too (the purple trace slices draw that art).
    // Translucent or missing art still fails: the glow under it measures above core, and Black's
    // bar, with no glow, then has no interior or a translucent one.
    {
        pattern:
            /^Sekai Damage Note (Left|Middle|Right)|^Sekai Trace Note Purple (Left|Middle|Right)$/,
        floor: 1,
        opaque: 0.99,
        core: 0.5,
    },
]

const opaqueShare = (alphas) => alphas.filter((alpha) => alpha === 255).length / alphas.length

const allowance = (name) => translucent.find(({ pattern }) => pattern.test(name))

/**
 * The alphas of a sprite's interior: covered pixels at least edgeBand from clear pixels and the
 * border, where pixels under core count as clear.
 */
function interior(texture, { x, y, w, h }, core = 0) {
    const alpha = (column, row) => {
        const value = pixelAt(texture, x + column, y + row)[3]
        return value < core * 255 ? 0 : value
    }
    // Small stretch sprites (4 px solids) keep at least their middle.
    const band = Math.min(edgeBand, Math.floor((Math.min(w, h) - 1) / 2))
    const out = []
    for (let row = band; row < h - band; row++)
        for (let column = band; column < w - band; column++) {
            let inside = true
            for (let dy = -band; dy <= band && inside; dy++)
                for (let dx = -band; dx <= band && inside; dx++)
                    if (alpha(column + dx, row + dy) === 0) inside = false
            if (inside) out.push(alpha(column, row))
        }
    return out
}

test("skin sprites have opaque interiors unless the base skin's same sprite is translucent", () => {
    const skin = readBuiltinItem('skin')
    const texture = decode(skin.resource('texture'))
    const failures = []
    const used = new Set()
    for (const sprite of skin.json('data').sprites) {
        const allowed = allowance(sprite.name)
        const alphas = interior(texture, sprite, allowed?.core)
        assert.ok(alphas.length > 0, `${sprite.name} has no interior to measure`)
        if (allowed) {
            used.add(allowed)
            const peak = Math.max(...alphas) / 255
            if (peak < allowed.floor) failures.push(`${sprite.name}: peak ${peak.toFixed(2)}`)
            if (opaqueShare(alphas) < (allowed.opaque ?? 0))
                failures.push(`${sprite.name}: ${(opaqueShare(alphas) * 100).toFixed(1)}% opaque`)
            continue
        }
        const opaque = opaqueShare(alphas)
        if (opaque < 0.99) failures.push(`${sprite.name}: ${(opaque * 100).toFixed(1)}% opaque`)
    }
    assert.deepEqual(failures, [])
    assert.equal(used.size, translucent.length, 'every allow-list entry matches a sprite')
})

// The kite's outline in its 64 unit square, y down. Diamonds draw it in an 88 unit view from -12 to
// 76, ticks in the square itself.
const kite = [
    [4, 32],
    [32, 4],
    [60, 32],
    [32, 46],
]
const kiteView = (name) => (name.startsWith('#NOTE_TICK_') ? [0, 64] : [-12, 88])

// How far a point lies inside the kite, as its least distance to an edge. Negative is outside.
function depthInKite([x, y]) {
    let depth = Infinity
    for (let i = 0; i < kite.length; i++) {
        const [x0, y0] = kite[i]
        const [x1, y1] = kite[(i + 1) % kite.length]
        const length = Math.hypot(x1 - x0, y1 - y0)
        depth = Math.min(depth, ((x1 - x0) * (y - y0) - (y1 - y0) * (x - x0)) / length)
    }
    return depth
}

// The allowance above measures only inside the half-alpha contour, so it cannot see a translucent
// or missing face. Here the whole kite, both faces, must be opaque from 3 texels inside its outline,
// past the soft edge.
test('diamonds and ticks are opaque across the whole kite inside its soft outline', () => {
    const skin = readBuiltinItem('skin')
    const texture = decode(skin.resource('texture'))
    const failures = []
    let measured = 0
    for (const sprite of skin.json('data').sprites) {
        if (!kites.test(sprite.name)) continue
        measured++
        const [origin, view] = kiteView(sprite.name)
        const texel = view / sprite.w
        const alphas = []
        for (let row = 0; row < sprite.h; row++)
            for (let column = 0; column < sprite.w; column++) {
                const point = [origin + (column + 0.5) * texel, origin + (row + 0.5) * texel]
                if (depthInKite(point) >= 3 * texel)
                    alphas.push(pixelAt(texture, sprite.x + column, sprite.y + row)[3])
            }
        if (alphas.length === 0) failures.push(`${sprite.name}: no kite to measure`)
        else if (opaqueShare(alphas) < 0.99)
            failures.push(`${sprite.name}: ${(opaqueShare(alphas) * 100).toFixed(1)}% opaque`)
    }
    assert.deepEqual(failures, [])
    assert.ok(measured > 0, 'no diamonds or ticks')
})
