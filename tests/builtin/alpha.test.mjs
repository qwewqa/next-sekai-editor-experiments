import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuiltinItem } from './helpers.mjs'
import { decode, pixelAt } from './pngDecode.mjs'

// Pixels from a transparent pixel or the sprite's border that count as the antialiased edge.
const edgeBand = 2

// Sprites translucent by design, each because the base skin's (Next SEKAI 01) same sprite is.
// floor is the least alpha the brightest interior pixel must keep, so none of them turns faint;
// opaque, if given, the least share of interior pixels at full alpha.
const translucent = [
    // The base's lane is dark navy at 0.40 alpha, over the background. Ours, in every color, is too.
    {
        pattern: /^Sekai Lane Background( Preview)?( [A-Z][a-z]+)?$|^#LANE$|^#STAGE_MIDDLE$/,
        floor: 0.4,
    },
    // The base's dividers are grey-white at 0.36, its borders white at 0.21.
    { pattern: /^Sekai (Lane Divider|Stage Border)( Preview)?$/, floor: 0.25 },
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
    // core), the arrowhead itself is opaque.
    { pattern: /Arrow|^#DIRECTIONAL_MARKER/, floor: 1, opaque: 0.99, core: 0.5 },
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
