import { normalizeSvgText } from './text'
import type { EditorDrawContext } from './types'

type Sprite = {
    canvas: HTMLCanvasElement
    /** The label's anchor in the sprite, in device pixels. */
    x: number
    y: number
    pixels: number
    frame: number
}

// About 16 MiB of RGBA for a dense view's names; larger labels draw as text.
const maxCachedPixels = 4 * 1024 * 1024
const maxCachedSprites = 1024
const maxSpritePixels = 256 * 1024
// Device pixels past the measured ink, for antialiasing and hinting.
const PADDING = 2

/**
 * Labels rasterised once per text, colour, font and device scale, as drawText
 * draws them, then copied whole with their anchor on a device pixel.
 */
export const createLabelSprites = () => {
    const sprites = new Map<string, Sprite>()
    let cachedPixels = 0
    let frame = 0
    let lang = ''

    const release = (sprite: Sprite) => {
        cachedPixels -= sprite.pixels
        sprite.canvas.width = 0
        sprite.canvas.height = 0
    }

    // A detached canvas doesn't inherit the page's language, which picks CJK glyphs.
    const canvasFor = (width: number, height: number) => {
        const canvas = document.createElement('canvas')
        canvas.lang = lang
        canvas.width = width
        canvas.height = height
        return canvas
    }
    let measurer: CanvasRenderingContext2D | undefined
    // The keys' font and scale part, rebuilt only when it changes.
    let style = { kx: NaN, ky: NaN, fontSize: NaN, middle: NaN, fontFamily: '', lang: '', key: '' }

    const create = (
        text: string,
        color: string,
        fontSize: number,
        fontFamily: string,
        middle: number,
        align: CanvasTextAlign,
        kx: number,
        ky: number,
    ): Sprite | undefined => {
        const setup = (ctx: CanvasRenderingContext2D) => {
            ctx.font = `${fontSize}px ${fontFamily}`
            ctx.fontKerning = 'normal'
            ctx.textBaseline = 'alphabetic'
            ctx.textAlign = align
        }
        measurer ??= canvasFor(1, 1).getContext('2d') ?? undefined
        if (!measurer) return
        measurer.canvas.lang = lang
        setup(measurer)
        const baseline = fontSize * middle
        const ink = measurer.measureText(text)
        const x = Math.ceil(ink.actualBoundingBoxLeft * kx) + PADDING
        const y = Math.ceil((ink.actualBoundingBoxAscent - baseline) * ky) + PADDING
        const width = x + Math.ceil(ink.actualBoundingBoxRight * kx) + PADDING
        const height = y + Math.ceil((baseline + ink.actualBoundingBoxDescent) * ky) + PADDING
        const pixels = width * height
        if (width <= 0 || height <= 0 || pixels > maxSpritePixels) return
        // Keep the frame's working set; overflow draws as text.
        while (sprites.size >= maxCachedSprites || cachedPixels + pixels > maxCachedPixels) {
            const oldest = sprites.entries().next().value
            if (!oldest || oldest[1].frame === frame) return
            sprites.delete(oldest[0])
            release(oldest[1])
        }
        const canvas = canvasFor(width, height)
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        setup(ctx)
        // The scale drawText shapes and rasterises at, about the anchor.
        ctx.setTransform(kx, 0, 0, ky, x, y)
        ctx.fillStyle = color
        ctx.fillText(text, 0, baseline)
        return { canvas, x, y, pixels, frame }
    }

    return {
        beginFrame(timestamp: number) {
            frame = timestamp
            lang = document.documentElement.lang
        },
        /**
         * Draws a label as drawText would under `transform`, onto the context with no
         * transform of its own. False when there's no sprite for it, to draw it as text.
         */
        draw(
            context: EditorDrawContext,
            transform: DOMMatrix,
            text: string,
            x: number,
            y: number,
            color: string,
            size = 0.4,
            align: CanvasTextAlign = 'center',
            middle = context.fontMiddle,
        ) {
            const { ctx, scale, fontFamily } = context
            const { a, d, e, f } = transform
            const kx = a / scale
            const ky = d / scale
            const fontSize = size * scale
            if (
                style.kx !== kx ||
                style.ky !== ky ||
                style.fontSize !== fontSize ||
                style.middle !== middle ||
                style.fontFamily !== fontFamily ||
                style.lang !== lang
            ) {
                const key = `${kx} ${ky} ${fontSize} ${middle} ${lang} ${fontFamily}`
                style = { kx, ky, fontSize, middle, fontFamily, lang, key }
            }
            const key = `${style.key}\n${align}\n${color}\n${text}`
            let sprite = sprites.get(key)
            if (sprite) {
                sprites.delete(key)
                sprites.set(key, sprite)
                sprite.frame = frame
            } else {
                const normalized = normalizeSvgText(text)
                if (!normalized) return true
                sprite = create(normalized, color, fontSize, fontFamily, middle, align, kx, ky)
                if (!sprite) return false
                sprites.set(key, sprite)
                cachedPixels += sprite.pixels
            }
            ctx.drawImage(
                sprite.canvas,
                Math.round(a * x + e) - sprite.x,
                Math.round(d * y + f) - sprite.y,
            )
            return true
        },
        clear() {
            for (const sprite of sprites.values()) release(sprite)
            sprites.clear()
            measurer = undefined
        },
    }
}

export type LabelSprites = ReturnType<typeof createLabelSprites>
