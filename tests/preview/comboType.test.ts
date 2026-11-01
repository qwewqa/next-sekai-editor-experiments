import assert from 'node:assert/strict'
import test from 'node:test'
import { COMBO_FONT, COMBO_LETTERS } from '../../src/preview/engine/comboGlyphs'
import {
    COMBO_LABEL_SHIFT,
    comboLayout,
    comboTextureLayout,
} from '../../src/preview/engine/comboType'
import { createViewport } from '../../src/preview/engine/layout'

const FIELD_HEIGHTS = [199, 470, 657, 1080, 2160, 2880]
const ASPECTS = [16 / 9, 21 / 9, 4 / 3]

/** A buffer whose 16:9 field is `fieldH` pixels high, at an aspect ratio. */
const buffer = (fieldH: number, aspect: number) => {
    const fieldW = (fieldH * 16) / 9
    return aspect >= 16 / 9
        ? { width: Math.round(fieldH * aspect), height: fieldH, fieldW }
        : { width: Math.round(fieldW), height: Math.round(fieldW / aspect), fieldW }
}

const layoutAt = (fieldH: number, aspect: number, digits: number) => {
    const { width, height } = buffer(fieldH, aspect)
    const viewport = createViewport(width, height)
    const fw = (width * viewport.fieldW) / viewport.screenW
    const fh = (height * viewport.fieldH) / 2
    const field = { x: (width - fw) / 2, y: (height - fh) / 2, w: fw, h: fh }
    return { layout: comboLayout(width, height, viewport, digits), field }
}

test('the combo sizes follow the field height', () => {
    const expected: Record<number, [number, number, number, number]> = {
        199: [18, 15, 5, 5],
        470: [42, 35, 12, 13],
        657: [59, 50, 17, 18],
        1080: [97, 81, 27, 29],
    }
    for (const fieldH of FIELD_HEIGHTS) {
        const { layout, field } = layoutAt(fieldH, 16 / 9, 3)
        const H = Math.round(0.09 * field.h)
        assert.equal(layout.H, H)
        assert.equal(layout.cell, Math.round((590 * H) / 703))
        assert.equal(layout.labelCap, Math.round(0.28 * H))
        assert.equal(layout.gap, Math.round(0.3 * H))
        const row = expected[fieldH]
        if (row)
            assert.deepEqual([layout.H, layout.cell, layout.labelCap, layout.gap], row, `${fieldH}`)
    }
})

test('the combo snaps to whole pixels and centres on the anchor at every size and aspect', () => {
    const scaleL = (cap: number) => cap / COMBO_FONT.capHeight
    for (const aspect of ASPECTS)
        for (const fieldH of FIELD_HEIGHTS)
            for (let digits = 1; digits <= 5; digits++) {
                const name = `field ${fieldH}, aspect ${aspect.toFixed(2)}, ${digits} digits`
                const { layout, field } = layoutAt(fieldH, aspect, digits)
                for (const value of [
                    layout.H,
                    layout.cell,
                    layout.labelCap,
                    layout.gap,
                    layout.x0,
                    layout.baseline,
                    layout.labelBaseline,
                    ...Object.values(layout.number).slice(0, 4),
                    ...Object.values(layout.label).slice(0, 4),
                ])
                    assert.ok(Number.isInteger(value), `${name}: ${value}`)
                assert.equal(layout.labelBaseline, layout.baseline - layout.H - layout.gap, name)

                const anchorX = field.x + 0.855 * field.w
                const anchorY = field.y + 0.4125 * field.h
                assert.ok(Math.abs(layout.centreX - anchorX) <= 0.5, name)
                assert.ok(Math.abs(layout.baseline - layout.H / 2 - anchorY) <= 0.5, name)
                assert.equal(layout.number.x + layout.number.originX, layout.x0)
                assert.equal(layout.number.y + layout.number.originY, layout.baseline)
                assert.equal(layout.label.y + layout.label.originY, layout.labelBaseline)

                // The label's ink box, from the baked bounds, centres on the number's box plus
                // the optical shift.
                const s = scaleL(layout.labelCap)
                const track = 0.26 * layout.labelCap
                const start = layout.label.x + layout.label.originX
                const lastPen = COMBO_FONT.labelAdvances
                    .slice(0, 4)
                    .reduce((x, advance) => x + advance * s + track, 0)
                const inkLeft = start + COMBO_LETTERS.C.bounds[0] * s
                const inkRight = start + lastPen + COMBO_LETTERS.O.bounds[2] * s
                assert.ok(
                    Math.abs(
                        (inkLeft + inkRight) / 2 -
                            (layout.centreX + COMBO_LABEL_SHIFT * layout.labelCap),
                    ) < 1e-9,
                    name,
                )
                assert.equal(layout.labelLeft, inkLeft)
                // Both images hold their ink and outline.
                const outline = 0.16 * layout.labelCap
                assert.ok(inkLeft - outline > layout.label.x, name)
                assert.ok(inkRight + outline < layout.label.x + layout.label.width, name)
                assert.ok(layout.x0 - layout.numberOutline > layout.number.x, name)

                assert.equal(layout.pivotX, layout.centreX)
                assert.equal(layout.pivotY, layout.baseline - layout.H / 2)
                assert.equal(layout.centreX, (layout.boxLeft + layout.boxRight) / 2)
                assert.equal(layout.boxLeft, layout.x0 + COMBO_FONT.sideBearingLeft * layout.scale)
                if (digits === 5)
                    assert.ok(layout.number.x + layout.number.width <= field.x + field.w, name)
            }
})

test('the optical shift moves the label towards its open side', () => {
    assert.ok(COMBO_LABEL_SHIFT < -0.05 && COMBO_LABEL_SHIFT > -0.07, `${COMBO_LABEL_SHIFT}`)
})

test('the number keeps its place for counts of one length and the texture depends on the size alone', () => {
    for (const fieldH of FIELD_HEIGHTS) {
        const layouts = [1, 2, 3, 4, 5, 6, 7].map(
            (digits) => layoutAt(fieldH, 16 / 9, digits).layout,
        )
        const textures = layouts.map((layout) => comboTextureLayout(layout, 7))
        for (const texture of textures) assert.deepEqual(texture, textures[0])
        for (const [i, layout] of layouts.entries()) {
            // Each image fits its region, and the regions do not touch.
            const texture = textures[i]!
            assert.ok(layout.number.width <= texture.number.width)
            assert.ok(layout.label.width <= texture.label.width)
            assert.ok(texture.label.y + texture.label.height < texture.number.y)
        }
        // A capacity of 8 holds an eight-digit number.
        const eight = layoutAt(fieldH, 16 / 9, 8).layout
        assert.ok(comboTextureLayout(eight, 8).number.width >= eight.number.width)
    }
})
