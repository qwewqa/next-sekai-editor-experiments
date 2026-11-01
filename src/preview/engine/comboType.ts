import { COMBO_DIGITS, COMBO_FONT, COMBO_LETTERS, type ComboGlyph } from './comboGlyphs'
import type { PreviewViewport } from './layout'

// The combo's type: where its label and number go in the drawing buffer, and how they are
// rasterised. Sizes are fractions of the 16:9 field's height, so every size and aspect ratio
// shows the same composition. Positions are device pixels, y down.

const NUMBER_SIZE = 0.09
const LABEL_CAP = 0.28
const LABEL_GAP = 0.3
const NUMBER_OUTLINE = 0.05
const LABEL_OUTLINE = 0.16
const LABEL_TRACKING = 0.26
/** The engine's combo anchor, as fractions of the field from its top left corner. */
const ANCHOR_X = 0.855
const ANCHOR_Y = 0.4125

/** The digits the number's texture region holds before it grows. */
export const COMBO_CAPACITY = 7

/** The label's letters, in Latin capitals in every locale. */
const LABEL = ['C', 'O', 'M', 'B', 'O'] as const
export const COMBO_OUTLINE_COLOR = 'rgba(10, 12, 30, 0.8)'
export const COMBO_LABEL_OUTLINE_COLOR = 'rgba(10, 12, 30, 0.88)'
export const COMBO_LABEL_COLOR = '#77efdc'
export const COMBO_NUMBER_COLOR = '#ffffff'

const labelGlyphs: readonly ComboGlyph[] = LABEL.map((letter) => COMBO_LETTERS[letter])
const digitGlyphs = Object.values(COMBO_DIGITS)

// The label in units of its cap height, so it is the same at every size: each letter's
// pen position, and the ink box from C's left ink to O's right ink.
const labelPens: number[] = []
let pen = 0
for (const advance of COMBO_FONT.labelAdvances) {
    labelPens.push(pen)
    pen += advance / COMBO_FONT.capHeight + LABEL_TRACKING
}
const lastPen = labelPens.at(-1) ?? 0
const labelInkLeft = (labelGlyphs[0]?.bounds[0] ?? 0) / COMBO_FONT.capHeight
const labelInkRight = lastPen + (labelGlyphs.at(-1)?.bounds[2] ?? 0) / COMBO_FONT.capHeight
const labelBoxCentre = (labelInkLeft + labelInkRight) / 2
const labelArea = labelGlyphs.reduce((sum, glyph) => sum + glyph.area, 0)
const labelCentroid =
    labelGlyphs.reduce(
        (sum, glyph, i) =>
            sum + glyph.area * ((labelPens[i] ?? 0) + glyph.centroidX / COMBO_FONT.capHeight),
        0,
    ) / labelArea
/**
 * The label's optical shift, in cap heights. The open C leaves the left of the word lighter, so a
 * box centred on the number looks right of centre. The box moves left by half the distance from
 * its centre to the ink's centroid.
 */
export const COMBO_LABEL_SHIFT = -(labelCentroid - labelBoxCentre) / 2

const maxOf = (values: number[]) => values.reduce((a, b) => Math.max(a, b), -Infinity)
const digitTop = maxOf(digitGlyphs.map((glyph) => glyph.bounds[3])) - COMBO_FONT.figureHeight
const digitBottom = -Math.min(...digitGlyphs.map((glyph) => glyph.bounds[1]))
const digitLeft = -Math.min(...digitGlyphs.map((glyph) => glyph.bounds[0]))
const digitRight = maxOf(digitGlyphs.map((glyph) => glyph.bounds[2]))
const labelTop = maxOf(labelGlyphs.map((glyph) => glyph.bounds[3])) - COMBO_FONT.capHeight
const labelBottom = -Math.min(...labelGlyphs.map((glyph) => glyph.bounds[1]))

/**
 * A rectangle of whole device pixels that one image fills, and the point in it where the type
 * starts: the first pen position on the baseline.
 */
export type ComboImage = {
    x: number
    y: number
    width: number
    height: number
    originX: number
    originY: number
}

/** Where the texture keeps each image. It depends only on the figure height and capacity. */
export type ComboTextureLayout = {
    width: number
    height: number
    label: { x: number; y: number; width: number; height: number }
    number: { x: number; y: number; width: number; height: number }
    capacity: number
}

export type ComboLayout = {
    /** The figure height. */
    H: number
    /** Font units to pixels for the number. */
    scale: number
    cell: number
    labelCap: number
    gap: number
    digits: number
    x0: number
    baseline: number
    labelBaseline: number
    /** The number's tabular box: its cells less the mean side bearings at each end. */
    boxLeft: number
    boxRight: number
    centreX: number
    /** The pop scales the number's quad about this point. */
    pivotX: number
    pivotY: number
    numberOutline: number
    labelOutline: number
    /** The label's left ink edge. It is not rounded. */
    labelLeft: number
    label: ComboImage
    number: ComboImage
}

const margin = (overhang: number, outline: number) => Math.ceil(overhang + outline) + 1

/** Where the combo goes in a `width` by `height` buffer, for a number of `digits` digits. */
export const comboLayout = (
    width: number,
    height: number,
    viewport: PreviewViewport,
    digits: number,
): ComboLayout => {
    const fieldW = (width * viewport.fieldW) / viewport.screenW
    const fieldH = (height * viewport.fieldH) / 2
    const anchorX = (width - fieldW) / 2 + ANCHOR_X * fieldW
    const anchorY = (height - fieldH) / 2 + ANCHOR_Y * fieldH

    const H = Math.round(NUMBER_SIZE * fieldH)
    const scale = H / COMBO_FONT.figureHeight
    const cell = Math.round(COMBO_FONT.tabularAdvance * scale)
    const labelCap = Math.round(LABEL_CAP * H)
    const gap = Math.round(LABEL_GAP * H)
    const numberOutline = NUMBER_OUTLINE * H
    const labelOutline = LABEL_OUTLINE * labelCap

    const left = COMBO_FONT.sideBearingLeft * scale
    const right = COMBO_FONT.sideBearingRight * scale
    const inkWidth = digits * cell - left - right
    const x0 = Math.round(anchorX - inkWidth / 2 - left)
    const baseline = Math.round(anchorY + H / 2)
    const boxLeft = x0 + left
    const boxRight = x0 + digits * cell - right
    const centreX = (boxLeft + boxRight) / 2

    const side = margin(Math.max(digitLeft * scale, digitRight * scale - cell, 0), numberOutline)
    const above = margin(digitTop * scale, numberOutline)
    const below = margin(digitBottom * scale, numberOutline)
    const number: ComboImage = {
        x: x0 - side,
        y: baseline - H - above,
        width: digits * cell + 2 * side,
        height: H + above + below,
        originX: side,
        originY: H + above,
    }

    const labelBaseline = baseline - H - gap
    const start = centreX + (COMBO_LABEL_SHIFT - labelBoxCentre) * labelCap
    const labelLeft = start + labelInkLeft * labelCap
    const labelSide = margin(0, labelOutline)
    const labelAbove = margin(labelTop * (labelCap / COMBO_FONT.capHeight), labelOutline)
    const labelBelow = margin(labelBottom * (labelCap / COMBO_FONT.capHeight), labelOutline)
    const labelX = Math.floor(labelLeft) - labelSide
    const label: ComboImage = {
        x: labelX,
        y: labelBaseline - labelCap - labelAbove,
        // The widest the label can be at any phase, so its size depends on its cap height alone.
        width: Math.ceil((labelInkRight - labelInkLeft) * labelCap) + 1 + 2 * labelSide,
        height: labelCap + labelAbove + labelBelow,
        originX: start - labelX,
        originY: labelCap + labelAbove,
    }

    return {
        H,
        scale,
        cell,
        labelCap,
        gap,
        digits,
        x0,
        baseline,
        labelBaseline,
        boxLeft,
        boxRight,
        centreX,
        pivotX: centreX,
        pivotY: baseline - H / 2,
        numberOutline,
        labelOutline,
        labelLeft,
        label,
        number,
    }
}

/** The texture's regions for a layout's sizes: the label on top, the number below it. */
export const comboTextureLayout = (layout: ComboLayout, capacity: number): ComboTextureLayout => {
    const numberWidth = layout.number.width + (capacity - layout.digits) * layout.cell
    // A transparent row between the regions stops linear filtering from blending one into the
    // other.
    const numberY = layout.label.height + 1
    return {
        width: Math.max(layout.label.width, numberWidth),
        height: numberY + layout.number.height,
        label: { x: 0, y: 0, width: layout.label.width, height: layout.label.height },
        number: { x: 0, y: numberY, width: numberWidth, height: layout.number.height },
        capacity,
    }
}

// Each thread parses the glyphs once, on first use.
let glyphPaths: Map<string, Path2D> | undefined
const glyphPath = (character: string) => {
    glyphPaths ??= new Map()
    let path = glyphPaths.get(character)
    if (!path) {
        const glyph =
            COMBO_DIGITS[character] ?? COMBO_LETTERS[character as keyof typeof COMBO_LETTERS]
        path = new Path2D(glyph.d)
        glyphPaths.set(character, path)
    }
    return path
}

/** The number as one path in its image, each digit at a whole pixel. */
export const numberPath = (layout: ComboLayout, text: string) => {
    const path = new Path2D()
    const { scale, cell } = layout
    for (let i = 0; i < text.length; i++)
        path.addPath(
            glyphPath(text.charAt(i)),
            new DOMMatrix([
                scale,
                0,
                0,
                -scale,
                layout.number.originX + i * cell,
                layout.number.originY,
            ]),
        )
    return path
}

/** The label as one path in its image, from its fractional left edge. */
export const labelPath = (layout: ComboLayout) => {
    const path = new Path2D()
    const scale = layout.labelCap / COMBO_FONT.capHeight
    for (const [i, letter] of LABEL.entries())
        path.addPath(
            glyphPath(letter),
            new DOMMatrix([
                scale,
                0,
                0,
                -scale,
                layout.label.originX + (labelPens[i] ?? 0) * layout.labelCap,
                layout.label.originY,
            ]),
        )
    return path
}

/**
 * Paints one path: one stroke for its outline, then one non-zero fill. A path's stroke is one
 * shape, so outlines that touch or overlap are covered once.
 */
export const paintPath = (
    context: OffscreenCanvasRenderingContext2D,
    path: Path2D,
    outline: number,
    outlineColor: string,
    fillColor: string,
) => {
    if (outline > 0) {
        context.lineJoin = 'round'
        context.lineWidth = 2 * outline
        context.strokeStyle = outlineColor
        context.stroke(path)
    }
    context.fillStyle = fillColor
    context.fill(path, 'nonzero')
}

export const paintNumber = (
    context: OffscreenCanvasRenderingContext2D,
    layout: ComboLayout,
    text: string,
) => {
    paintPath(
        context,
        numberPath(layout, text),
        layout.numberOutline,
        COMBO_OUTLINE_COLOR,
        COMBO_NUMBER_COLOR,
    )
}

export const paintLabel = (context: OffscreenCanvasRenderingContext2D, layout: ComboLayout) => {
    paintPath(
        context,
        labelPath(layout),
        layout.labelOutline,
        COMBO_LABEL_OUTLINE_COLOR,
        COMBO_LABEL_COLOR,
    )
}

/** Rasterises the label and the number into bitmaps the size of their texture regions. */
export type ComboRaster = {
    label: (layout: ComboLayout, texture: ComboTextureLayout) => ImageBitmap
    number: (layout: ComboLayout, texture: ComboTextureLayout, text: string) => ImageBitmap
}

/**
 * The raster on CPU canvases. `willReadFrequently` keeps them unaccelerated in every thread, so
 * the main thread and a worker draw the same pixels.
 */
export const createComboRaster = (): ComboRaster => {
    let labelContext: OffscreenCanvasRenderingContext2D | undefined
    let numberContext: OffscreenCanvasRenderingContext2D | undefined
    const contextOf = (
        current: OffscreenCanvasRenderingContext2D | undefined,
        width: number,
        height: number,
    ) => {
        if (current) {
            if (current.canvas.width !== width) current.canvas.width = width
            if (current.canvas.height !== height) current.canvas.height = height
            current.clearRect(0, 0, width, height)
            return current
        }
        const context = new OffscreenCanvas(width, height).getContext('2d', {
            willReadFrequently: true,
        })
        if (!context) throw new Error('A 2D canvas is unavailable')
        return context
    }
    return {
        label: (layout, texture) => {
            labelContext = contextOf(labelContext, texture.label.width, texture.label.height)
            paintLabel(labelContext, layout)
            return labelContext.canvas.transferToImageBitmap()
        },
        number: (layout, texture, text) => {
            numberContext = contextOf(numberContext, texture.number.width, texture.number.height)
            paintNumber(numberContext, layout, text)
            return numberContext.canvas.transferToImageBitmap()
        },
    }
}
