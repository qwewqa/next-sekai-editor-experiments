import { createFontContext } from '../../rendering/textRaster'
import type { EditorDrawContext, EditorMeasureContext } from './types'

// SVG's default white-space handling collapses these characters, but preserves
// nonbreaking and other Unicode spaces. Canvas only replaces ASCII whitespace.
export const normalizeSvgText = (text: string) =>
    text.replace(/[\t\n\r ]+/g, ' ').replace(/^ | $/g, '')

// SVG middle is half the font's x-height above the alphabetic baseline; Canvas
// middle is the center of its em box. Resolve the font metric once on mount and
// font loading, at a large size to avoid CSS layout rounding at scene-unit sizes.
export const measureTextMiddle = (fontFamily: string, parent: HTMLElement) => {
    const probe = document.createElement('span')
    probe.style.cssText =
        'position:absolute;visibility:hidden;pointer-events:none;display:block;width:0.5ex;height:0;padding:0;border:0'
    probe.style.font = `1000px ${fontFamily}`
    parent.append(probe)
    const middle = probe.getBoundingClientRect().width / 1000
    probe.remove()
    return middle
}

// Half the height of typical sans-serif figures, in ems.
export const FIGURE_MIDDLE = 0.35

// Figures stand taller than the x-height, so number labels centre on their ink.
export const measureFigureMiddle = (fontFamily: string) => {
    const ctx = createFontContext()
    if (!ctx) return FIGURE_MIDDLE
    ctx.font = `1000px ${fontFamily}`
    const { actualBoundingBoxAscent, actualBoundingBoxDescent } = ctx.measureText('0123456789')
    const middle = (actualBoundingBoxAscent - actualBoundingBoxDescent) / 2000
    return middle > 0 ? middle : FIGURE_MIDDLE
}

/** A label's width in scene units, as drawText draws it. */
export const measureText = (
    { ctx, scale, fontFamily }: Pick<EditorMeasureContext, 'ctx' | 'scale' | 'fontFamily'>,
    text: string,
    size = 0.4,
) => {
    ctx.save()
    ctx.font = `${size * scale}px ${fontFamily}`
    ctx.fontKerning = 'normal'
    const { width } = ctx.measureText(normalizeSvgText(text))
    ctx.restore()
    return width / scale
}

// Labels are measured on every frame; keep widths for each canvas's font and zoom.
const createWidthBucket = () => ({
    bySize: new Map<number, Map<string, number>>(),
    order: new Set<{ size: number; text: string }>(),
    textUnits: 0,
})
const widths = new Map<string, ReturnType<typeof createWidthBucket>>()
const maxWidthKeys = 4
// Shared across sizes so arbitrary names and size arguments cannot retain unbounded keys.
const maxWidthEntries = 8192
const maxWidthTextUnits = 256 * 1024
// The widths last measured in; a NaN zoom matches none.
const unset = () => ({ fontFamily: '', scale: NaN, bucket: createWidthBucket() })
let last = unset()

/** Forgets measured widths, as a loaded font changes them. */
export const clearTextWidths = () => {
    widths.clear()
    last = unset()
}

/** A label's width as measureText gives it, remembered per font, zoom, size and text. */
export const measureCachedText = (context: EditorDrawContext, text: string, size = 0.4) => {
    const { fontFamily, scale } = context
    if (last.fontFamily !== fontFamily || last.scale !== scale) {
        const key = `${fontFamily}|${scale}`
        // Most recently used last; old zooms go first.
        const bucket = widths.get(key) ?? createWidthBucket()
        widths.delete(key)
        widths.set(key, bucket)
        for (const old of widths.keys()) {
            if (widths.size <= maxWidthKeys) break
            widths.delete(old)
        }
        last = { fontFamily, scale, bucket }
    }
    const { bucket } = last
    const cached = bucket.bySize.get(size)?.get(text)
    if (cached !== undefined) return cached

    const width = measureText(context, text, size)
    if (text.length > maxWidthTextUnits) return width

    // Insertion-order eviction keeps frequent cache hits free of bookkeeping.
    while (
        bucket.order.size >= maxWidthEntries ||
        bucket.textUnits + text.length > maxWidthTextUnits
    ) {
        const oldest = bucket.order.values().next().value
        if (!oldest) break
        bucket.order.delete(oldest)
        bucket.textUnits -= oldest.text.length
        const oldSize = bucket.bySize.get(oldest.size)
        oldSize?.delete(oldest.text)
        if (!oldSize?.size) bucket.bySize.delete(oldest.size)
    }
    let byText = bucket.bySize.get(size)
    if (!byText) bucket.bySize.set(size, (byText = new Map<string, number>()))
    byText.set(text, width)
    bucket.order.add({ size, text })
    bucket.textUnits += text.length
    return width
}

/** Draws a label centred `middle` ems above its baseline: SVG middle by default. */
export const drawText = (
    { ctx, scale, fontFamily, fontMiddle }: EditorDrawContext,
    text: string,
    x: number,
    y: number,
    color: string,
    size = 0.4,
    align: CanvasTextAlign = 'center',
    middle = fontMiddle,
) => {
    const normalized = normalizeSvgText(text)
    if (!normalized) return
    // Shape at the displayed CSS size, avoiding subpixel font-size quantization
    // and kerning heuristics on a 0.4px font subsequently magnified by the CTM.
    ctx.drawEditorLabel(normalized, x, y, color, fontFamily, scale, size, align, middle)
}

/** Numeric event labels share the grid's stable physical-pixel baseline policy. */
export const drawEventText = (
    { ctx, scale, fontFamily, figureMiddle }: EditorDrawContext,
    text: string,
    x: number,
    y: number,
    color: string,
    size: number,
    align: CanvasTextAlign,
) => {
    const normalized = normalizeSvgText(text)
    if (normalized)
        ctx.drawEditorLabel(
            normalized,
            x,
            y,
            color,
            fontFamily,
            scale,
            size,
            align,
            figureMiddle,
            true,
        )
}

/** Grid text uses stable device-pixel anchors; its scene coordinates remain exact. */
export const drawGridText = (
    { ctx, scale, fontFamily, figureMiddle }: EditorDrawContext,
    text: string,
    x: number,
    y: number,
    align: 'start' | 'end',
) => {
    const normalized = normalizeSvgText(text)
    if (normalized) ctx.drawGridLabel(normalized, x, y, fontFamily, scale, align, figureMiddle)
}
