import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPreviewChart } from '../../src/preview/engine/chart'
import { comboPop, drawCombo, setComboRaster } from '../../src/preview/engine/comboDraw'
import { comboLayout, type ComboImage } from '../../src/preview/engine/comboType'
import { LAYER_COMBO } from '../../src/preview/engine/layer'
import { createViewport } from '../../src/preview/engine/layout'
import type { Quad } from '../../src/preview/engine/math'
import type { PreviewRenderer } from '../../src/preview/gl'
import { createState } from '../../src/state'
import { chart, note } from '../helpers/scoring'

// One note every beat at BPM 120: the count is 2t + 1 just after t.
const preview = buildPreviewChart(
    createState(chart(Array.from({ length: 120 }, (_, i) => [note(i)])), 0),
    10,
)

let rasters: string[] = []
setComboRaster(() => ({
    label: (_layout, texture) => {
        rasters.push('label')
        return { ...texture.label, close() {} } as unknown as ImageBitmap
    },
    number: (_layout, texture, text) => {
        rasters.push(text)
        return { ...texture.number, close() {} } as unknown as ImageBitmap
    },
}))

const fake = () => {
    const calls: unknown[][] = []
    const draws: { quad: Quad; z: readonly number[]; uv: number[] }[] = []
    const renderer = {
        reserveTexture: (...args: unknown[]) => calls.push(['reserve', ...args]),
        setTextureRegion: (slot: number, x: number, y: number) =>
            calls.push(['region', slot, x, y]),
    } as unknown as PreviewRenderer
    const draw: PreviewRenderer['draw'] = (sprite, quad, z) => {
        assert.equal(sprite?.texture, 2)
        draws.push({
            quad: structuredClone(quad),
            z,
            uv: [sprite!.u0, sprite!.v0, sprite!.u1, sprite!.v1],
        })
    }
    return { renderer, draw, calls, draws }
}

const toPixels = (quad: Quad, width: number, height: number) => {
    const half = createViewport(width, height).screenW / 2
    const x = (value: number) => ((value / half + 1) / 2) * width
    const y = (value: number) => ((1 - value) / 2) * height
    return { left: x(quad.tl.x), top: y(quad.tl.y), right: x(quad.br.x), bottom: y(quad.br.y) }
}

const near = (actual: number, expected: number, name: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-6, `${name}: ${actual} against ${expected}`)

const assertRect = (quad: Quad, image: ComboImage, width: number, height: number) => {
    const rect = toPixels(quad, width, height)
    near(rect.left, image.x, 'left')
    near(rect.top, image.y, 'top')
    near(rect.right, image.x + image.width, 'right')
    near(rect.bottom, image.y + image.height, 'bottom')
}

test('nothing is drawn before the first note', () => {
    const { renderer, draw, calls, draws } = fake()
    drawCombo(renderer, draw, preview, -1, false, 1280, 720, createViewport(1280, 720))
    // The first note is at 0, which a paused frame there does not count yet.
    drawCombo(renderer, draw, preview, 0, true, 1280, 720, createViewport(1280, 720))
    assert.deepEqual(calls, [])
    assert.deepEqual(draws, [])
})

test('the label and the number draw at rest on whole pixels, above the scene', () => {
    rasters = []
    const { renderer, draw, calls, draws } = fake()
    const viewport = createViewport(1280, 720)
    drawCombo(renderer, draw, preview, 4.25, true, 1280, 720, viewport)
    assert.deepEqual(rasters, ['label', '9'])
    assert.equal(calls[0]?.[0], 'reserve')
    assert.equal(calls.length, 3)
    const layout = comboLayout(1280, 720, viewport, 1)
    assert.deepEqual(
        draws.map((entry) => entry.z),
        [
            [LAYER_COMBO.layer, 0, 0, 0],
            [LAYER_COMBO.layer, 0, 1, 0],
        ],
    )
    assertRect(draws[0]!.quad, layout.label, 1280, 720)
    assertRect(draws[1]!.quad, layout.number, 1280, 720)
})

test('a new digit uploads the number again in the same texture, and a new size lays it out again', () => {
    rasters = []
    const { renderer, draw, calls } = fake()
    const viewport = createViewport(1280, 720)
    drawCombo(renderer, draw, preview, 4.25, true, 1280, 720, viewport)
    drawCombo(renderer, draw, preview, 4.3, true, 1280, 720, viewport)
    assert.deepEqual(rasters, ['label', '9'])
    for (const [time, count] of [
        [4.75, '10'],
        [49.75, '100'],
    ] as const) {
        calls.length = 0
        rasters = []
        drawCombo(renderer, draw, preview, time, true, 1280, 720, viewport)
        assert.ok(!calls.some((call) => call[0] === 'reserve'), count)
        assert.equal(rasters.at(-1), count)
        // The label is drawn again only when its phase within a pixel changes.
        const before = comboLayout(1280, 720, viewport, count.length - 1).label.originX % 1
        const after = comboLayout(1280, 720, viewport, count.length).label.originX % 1
        assert.equal(rasters.includes('label'), before !== after, count)
    }
    calls.length = 0
    rasters = []
    drawCombo(renderer, draw, preview, 49.75, true, 1920, 1080, createViewport(1920, 1080))
    assert.deepEqual(
        calls.map((call) => call[0]),
        ['reserve', 'region', 'region'],
    )
    assert.deepEqual(rasters, ['label', '100'])
})

test('a playing frame pops the number about its pivot on chart time; the label stays', () => {
    const viewport = createViewport(1280, 720)
    const layout = comboLayout(1280, 720, viewport, 2)
    const frame = (time: number, leftLimit: boolean) => {
        const { renderer, draw, draws } = fake()
        drawCombo(renderer, draw, preview, time, leftLimit, 1280, 720, viewport)
        return draws
    }
    // The 11th note is at 5 s.
    for (const [since, scale] of [
        [0, 1.08],
        [0.07, 1.01],
        [0.14, 1],
        [0.3, 1],
    ] as const) {
        near(comboPop(since), scale, `${since}`)
        const [label, number] = frame(5 + since, false)
        assertRect(label!.quad, layout.label, 1280, 720)
        const rect = toPixels(number!.quad, 1280, 720)
        const s = comboPop(since)
        near(rect.left, layout.pivotX + s * (layout.number.x - layout.pivotX), 'left')
        near(rect.top, layout.pivotY + s * (layout.number.y - layout.pivotY), 'top')
    }
    // Paused there, the count is 11, with two digits, and at rest.
    const [, paused] = frame(5.03, true)
    assertRect(paused!.quad, layout.number, 1280, 720)
})
