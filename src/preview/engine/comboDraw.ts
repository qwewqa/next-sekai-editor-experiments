import type { PreviewRenderer, ZKey } from '../gl'
import type { Sprite } from '../skin'
import { comboAt, getComboTimes } from './combo'
import {
    COMBO_CAPACITY,
    comboLayout,
    comboTextureLayout,
    createComboRaster,
    type ComboImage,
    type ComboLayout,
    type ComboRaster,
    type ComboTextureLayout,
} from './comboType'
import { LAYER_COMBO, getZAlt } from './layer'
import type { PreviewViewport } from './layout'
import type { Quad } from './math'
import type { PreviewChart } from './model'

// The label and number of a perfect play's combo, drawn above the notes and effects. A frame
// depends only on its time, whether it is paused and its size, so playing and seeking to the same
// time draw the same pixels.

const TEXT_SLOT = 2
const POP_SCALE = 0.08
const POP_SECONDS = 0.14
const LABEL_Z: ZKey = getZAlt(LAYER_COMBO, 0)
const NUMBER_Z: ZKey = getZAlt(LAYER_COMBO, 1)

let createRaster: () => ComboRaster = createComboRaster
let raster: ComboRaster | undefined
/**
 * Replaces the raster. Node has no `Path2D`, so the perf script uses blank bitmaps of the same
 * sizes.
 */
export const setComboRaster = (create: () => ComboRaster) => {
    createRaster = create
    raster = undefined
}

const newQuad = (): Quad => ({
    bl: { x: 0, y: 0 },
    tl: { x: 0, y: 0 },
    tr: { x: 0, y: 0 },
    br: { x: 0, y: 0 },
})

type ComboLayer = {
    texture?: ComboTextureLayout
    /** The figure height the texture was laid out for. */
    textureH: number
    labelKey?: number
    numberKey?: number
    layout?: ComboLayout
    layoutKey: [number, number, number, number]
    count: number
    text: string
    labelSprite: Sprite
    numberSprite: Sprite
    labelQuad: Quad
    numberQuad: Quad
    /** What the last frame drew, for the test builds' readback. */
    drawn?: { label: ComboImage; number: ComboImage; time: number; scale: number }
}

// A new renderer starts afresh: after a context loss, an antialiasing change or a handover.
const layers = new WeakMap<PreviewRenderer, ComboLayer>()

const layerOf = (renderer: PreviewRenderer) => {
    let layer = layers.get(renderer)
    if (!layer) {
        layer = {
            textureH: 0,
            layoutKey: [0, 0, 0, 0],
            count: 0,
            text: '',
            labelSprite: { u0: 0, v0: 0, u1: 0, v1: 0, texture: TEXT_SLOT },
            numberSprite: { u0: 0, v0: 0, u1: 0, v1: 0, texture: TEXT_SLOT },
            labelQuad: newQuad(),
            numberQuad: newQuad(),
        }
        layers.set(renderer, layer)
    }
    return layer
}

/**
 * Lays out the texture for these sizes. Allocating discards its contents, so both regions are
 * drawn again before the frame draws. Nothing else reserves the text slot.
 */
const allocate = (renderer: PreviewRenderer, layer: ComboLayer, layout: ComboLayout) => {
    const texture = comboTextureLayout(layout, Math.max(COMBO_CAPACITY, layout.digits))
    renderer.reserveTexture(TEXT_SLOT, texture.width, texture.height)
    layer.texture = texture
    layer.textureH = layout.H
    layer.labelKey = undefined
    layer.numberKey = undefined
}

const setUv = (
    sprite: Sprite,
    texture: ComboTextureLayout,
    region: { x: number; y: number },
    image: ComboImage,
) => {
    sprite.u0 = region.x / texture.width
    sprite.v0 = region.y / texture.height
    sprite.u1 = (region.x + image.width) / texture.width
    sprite.v1 = (region.y + image.height) / texture.height
}

/** Sets `quad` to `image`'s rectangle in the renderer's coordinates, scaled about a pivot. */
const setQuad = (
    quad: Quad,
    image: ComboImage,
    width: number,
    height: number,
    halfAspect: number,
    scale = 1,
    pivotX = 0,
    pivotY = 0,
) => {
    const x = (px: number) => ((2 * (pivotX + scale * (px - pivotX))) / width - 1) * halfAspect
    const y = (py: number) => 1 - (2 * (pivotY + scale * (py - pivotY))) / height
    const left = x(image.x)
    const right = x(image.x + image.width)
    const top = y(image.y)
    const bottom = y(image.y + image.height)
    quad.bl.x = left
    quad.bl.y = bottom
    quad.tl.x = left
    quad.tl.y = top
    quad.tr.x = right
    quad.tr.y = top
    quad.br.x = right
    quad.br.y = bottom
}

/** The number's scale `since` seconds of chart time after an increment. */
export const comboPop = (since: number) => {
    const x = Math.min(1, Math.max(0, since / POP_SECONDS))
    const rest = 1 - x
    return 1 + POP_SCALE * rest * rest * rest
}

/** Draws the combo at `now` into a `width` by `height` buffer; nothing while it is 0. */
export const drawCombo = (
    renderer: PreviewRenderer,
    draw: PreviewRenderer['draw'],
    chart: PreviewChart,
    now: number,
    leftLimit: boolean,
    width: number,
    height: number,
    viewport: PreviewViewport,
) => {
    const times = getComboTimes(chart)
    const count = comboAt(times, now, leftLimit)
    const layer = layerOf(renderer)
    layer.drawn = undefined
    if (!count) return

    if (count !== layer.count) {
        layer.count = count
        layer.text = String(count)
    }
    const text = layer.text
    const key = layer.layoutKey
    let layout = layer.layout
    if (
        !layout ||
        key[0] !== width ||
        key[1] !== height ||
        key[2] !== viewport.screenW ||
        key[3] !== text.length
    ) {
        layout = comboLayout(width, height, viewport, text.length)
        layer.layout = layout
        key[0] = width
        key[1] = height
        key[2] = viewport.screenW
        key[3] = text.length
    }

    if (!layer.texture || layer.textureH !== layout.H || layer.texture.capacity < layout.digits)
        allocate(renderer, layer, layout)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const texture = layer.texture!
    raster ??= createRaster()
    // The label's image changes only with its phase within a pixel.
    const phase = layout.label.originX - Math.floor(layout.label.originX)
    if (layer.labelKey !== phase) {
        const bitmap = raster.label(layout, texture)
        renderer.setTextureRegion(TEXT_SLOT, texture.label.x, texture.label.y, bitmap)
        bitmap.close()
        layer.labelKey = phase
    }
    if (layer.numberKey !== count) {
        const bitmap = raster.number(layout, texture, text)
        renderer.setTextureRegion(TEXT_SLOT, texture.number.x, texture.number.y, bitmap)
        bitmap.close()
        layer.numberKey = count
    }

    const halfAspect = viewport.screenW / 2
    // Paused frames are at rest; playing ones pop on chart time after each increment.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const scale = leftLimit ? 1 : comboPop(now - times[count - 1]!)
    setUv(layer.numberSprite, texture, texture.number, layout.number)
    setQuad(
        layer.numberQuad,
        layout.number,
        width,
        height,
        halfAspect,
        scale,
        layout.pivotX,
        layout.pivotY,
    )
    setUv(layer.labelSprite, texture, texture.label, layout.label)
    setQuad(layer.labelQuad, layout.label, width, height, halfAspect)
    draw(layer.labelSprite, layer.labelQuad, LABEL_Z, 1)
    draw(layer.numberSprite, layer.numberQuad, NUMBER_Z, 1)
    layer.drawn = { label: layout.label, number: layout.number, time: now, scale }
}

/** Marks a frame drawn without the combo, so the test builds' readback finds nothing. */
export const skipCombo = (renderer: PreviewRenderer) => {
    const layer = layers.get(renderer)
    if (layer) layer.drawn = undefined
}

export type ComboReadback = {
    rect: { x: number; y: number; width: number; height: number }
    frame: Uint8Array
    texture: Uint8Array
}

export type ComboPixels = {
    label: ComboReadback
    number: ComboReadback
    /** The frame's time, and the number's scale in it. */
    time: number
    scale: number
}

/**
 * Test builds: the last frame's label and number, read from the frame and from the texture.
 * Call it in the same task as the frame.
 */
export const readCombo = (renderer: PreviewRenderer): ComboPixels | undefined => {
    const layer = layers.get(renderer)
    const drawn = layer?.drawn
    const texture = layer?.texture
    if (!drawn || !texture) return
    const read = (image: ComboImage, region: { x: number; y: number }): ComboReadback => ({
        rect: { x: image.x, y: image.y, width: image.width, height: image.height },
        frame: renderer.readPixels('frame', image.x, image.y, image.width, image.height),
        texture: renderer.readPixels(TEXT_SLOT, region.x, region.y, image.width, image.height),
    })
    return {
        label: read(drawn.label, texture.label),
        number: read(drawn.number, texture.number),
        time: drawn.time,
        scale: drawn.scale,
    }
}
