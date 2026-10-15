import { createFontContext, getOutlinedNameRaster } from '../../rendering/textRaster'
import { normalizeSvgText } from './text'
import type { EditorDrawContext } from './types'

type Sprite = {
    canvas: HTMLCanvasElement
    /** The label's anchor in the sprite, in device pixels. */
    x: number
    y: number
    pixels: number
    frame: number
    contexts: Set<EditorDrawContext['ctx']>
    transient: boolean
}

// About 16 MiB of RGBA for a dense view's names; larger labels use a clipped raster.
const maxCachedPixels = 4 * 1024 * 1024
const maxCachedSprites = 1024
const maxSpritePixels = 256 * 1024
// The chart and its overlay-owned gesture surface share sprites across two GL
// owners. Replaced consumers release their image, keeping ownership bounded.
const maxSpriteContexts = 2
// Device pixels past the measured ink, for antialiasing and hinting.
const PADDING = 2
// Preserve each name's hue and outline the complete native-shaped string once.
const HALO_RADIUS = 0.5

/**
 * Labels rasterised once per text, colour, font and device scale, as drawText
 * draws them, then copied whole with their anchor on a device pixel.
 */
export const createLabelSprites = () => {
    const sprites = new Map<string, Sprite>()
    // Changing zoom and protected-frame overflow still need the full halo. These
    // sources share the same pixel/entry budgets and live only through this frame.
    const transients = new Map<string, Sprite>()
    let cachedPixels = 0
    let frame = 0
    // Distinct frames drawn, to tell a scale that holds from one changing every frame.
    let frames = 0
    let lang = ''
    // The scale names last drew at, and the frame it changed on.
    let zoom = { kx: NaN, ky: NaN, scale: NaN, since: -1 }

    const release = (sprite: Sprite) => {
        for (const ctx of sprite.contexts) ctx.releaseImage(sprite.canvas)
        sprite.contexts.clear()
        cachedPixels -= sprite.pixels
        sprite.canvas.width = 0
        sprite.canvas.height = 0
    }

    const makeRoom = (pixels: number, allowCurrentFrame: boolean) => {
        while (
            sprites.size + transients.size >= maxCachedSprites ||
            cachedPixels + pixels > maxCachedPixels
        ) {
            const oldest = sprites.entries().next().value
            if (oldest && oldest[1].frame !== frame) {
                sprites.delete(oldest[0])
                release(oldest[1])
                continue
            }
            if (!allowCurrentFrame) return false
            const temporary = transients.entries().next().value
            if (temporary) {
                transients.delete(temporary[0])
                release(temporary[1])
            } else if (oldest) {
                // releaseImage flushes queued readers before the source shrinks.
                // Pressure may reduce batching, but never drops the name's halo.
                sprites.delete(oldest[0])
                release(oldest[1])
            } else return false
        }
        return true
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

    const drawOversizedHalo = (
        context: EditorDrawContext,
        transform: DOMMatrix,
        text: string,
        x: number,
        y: number,
        color: string,
        fontSize: number,
        align: CanvasTextAlign,
        middle: number,
        direction: CanvasDirection,
    ) => {
        const { ctx, scale, fontFamily } = context
        const { a, b, c, d, e, f } = transform
        const raster = getOutlinedNameRaster(
            {
                text: normalizeSvgText(text),
                x: 0,
                y: fontSize * middle,
                font: `${fontSize}px ${fontFamily}`,
                fontKerning: 'normal',
                textAlign: align,
                textBaseline: 'alphabetic',
                direction,
                lang,
                fillStyle: color,
                matrix: [
                    a / scale,
                    b / scale,
                    c / scale,
                    d / scale,
                    Math.round(a * x + c * y + e),
                    Math.round(b * x + d * y + f),
                ],
                viewport: ctx.canvas,
            },
            HALO_RADIUS,
            ctx.maxSurfaceSize,
        )
        if (!raster) return true
        try {
            ctx.drawNameSprite(raster.source, raster.left, raster.top)
        } finally {
            // Flush the queued reader before releasing this rare upload. Its
            // immutable CPU source belongs to the existing bounded text cache.
            ctx.releaseImage(raster.source)
        }
        return true
    }

    const create = (
        text: string,
        color: string,
        fontSize: number,
        fontFamily: string,
        middle: number,
        align: CanvasTextAlign,
        kx: number,
        ky: number,
        halo: boolean,
        transient: boolean,
        direction: CanvasDirection,
        maxDimension: number,
    ): Sprite | undefined => {
        const setup = (ctx: CanvasRenderingContext2D) => {
            ctx.font = `${fontSize}px ${fontFamily}`
            ctx.fontKerning = 'normal'
            ctx.textBaseline = 'alphabetic'
            ctx.textAlign = align
            ctx.direction = halo ? direction : 'inherit'
        }
        measurer ??= createFontContext(canvasFor(1, 1)) ?? undefined
        if (!measurer) return
        measurer.canvas.lang = lang
        setup(measurer)
        const baseline = fontSize * middle
        const ink = measurer.measureText(text)
        const paddingX = PADDING + (halo ? Math.ceil(HALO_RADIUS * kx) : 0)
        const paddingY = PADDING + (halo ? Math.ceil(HALO_RADIUS * ky) : 0)
        const x = Math.ceil(ink.actualBoundingBoxLeft * kx) + paddingX
        const y = Math.ceil((ink.actualBoundingBoxAscent - baseline) * ky) + paddingY
        const width = x + Math.ceil(ink.actualBoundingBoxRight * kx) + paddingX
        const height = y + Math.ceil((baseline + ink.actualBoundingBoxDescent) * ky) + paddingY
        const pixels = width * height
        if (
            width <= 0 ||
            height <= 0 ||
            !Number.isFinite(pixels) ||
            pixels > maxSpritePixels ||
            (halo && (width > maxDimension || height > maxDimension))
        )
            return
        // Plain labels retain their existing text fallback. Halo overflow uses
        // a bounded transient sprite and may flush an older queued source.
        if (!makeRoom(pixels, false)) {
            if (!halo || !makeRoom(pixels, true)) return
            transient = true
        }
        const canvas = canvasFor(width, height)
        const ctx = createFontContext(canvas)
        if (!ctx) return
        setup(ctx)
        // The scale drawText shapes and rasterises at, about the anchor.
        ctx.setTransform(kx, 0, 0, ky, x, y)
        if (halo) {
            ctx.strokeStyle = '#000'
            ctx.lineWidth = HALO_RADIUS * 2
            ctx.lineJoin = 'round'
            ctx.strokeText(text, 0, baseline)
        }
        ctx.fillStyle = color
        ctx.fillText(text, 0, baseline)
        return { canvas, x, y, pixels, frame, contexts: new Set(), transient }
    }

    return {
        beginFrame(timestamp: number) {
            if (timestamp !== frame) {
                for (const sprite of transients.values()) release(sprite)
                transients.clear()
                frames++
            }
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
            halo = false,
        ) {
            const { ctx, scale, fontFamily } = context
            const { a, d, e, f } = transform
            const kx = a / scale
            const ky = d / scale
            const fontSize = size * scale
            const direction =
                !halo || ctx.direction === 'ltr' || ctx.direction === 'rtl'
                    ? ctx.direction
                    : document.documentElement.dir === 'rtl'
                      ? 'rtl'
                      : 'ltr'
            if (halo) {
                if (
                    scale <= 0 ||
                    fontSize <= 0 ||
                    ![a, transform.b, transform.c, d, kx, ky, fontSize, e, f, x, y, middle].every(
                        Number.isFinite,
                    )
                )
                    return true
                if (transform.b !== 0 || transform.c !== 0 || kx <= 0 || ky <= 0)
                    return drawOversizedHalo(
                        context,
                        transform,
                        text,
                        x,
                        y,
                        color,
                        fontSize,
                        align,
                        middle,
                        direction,
                    )
            }
            if (zoom.kx !== kx || zoom.ky !== ky || zoom.scale !== scale) {
                const first = Number.isNaN(zoom.scale)
                zoom = { kx, ky, scale, since: first ? -1 : frames }
            }
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
            const key = `${style.key}\n${align}\n${color}\n${+halo}\n${halo ? direction : ''}\n${text}`
            let sprite = sprites.get(key) ?? transients.get(key)
            if (sprite) {
                const cache = sprite.transient ? transients : sprites
                cache.delete(key)
                cache.set(key, sprite)
                sprite.frame = frame
            } else {
                const normalized = normalizeSvgText(text)
                if (!normalized) return true
                // Pinch zoom and pane resizes change the scale every frame; draw text until it holds.
                const changingZoom = zoom.since === frames
                if (changingZoom && !halo) return false
                sprite = create(
                    normalized,
                    color,
                    fontSize,
                    fontFamily,
                    middle,
                    align,
                    kx,
                    ky,
                    halo,
                    changingZoom,
                    direction,
                    ctx.maxSurfaceSize,
                )
                if (!sprite)
                    return halo
                        ? drawOversizedHalo(
                              context,
                              transform,
                              normalized,
                              x,
                              y,
                              color,
                              fontSize,
                              align,
                              middle,
                              direction,
                          )
                        : false
                ;(sprite.transient ? transients : sprites).set(key, sprite)
                cachedPixels += sprite.pixels
            }
            ctx.drawNameSprite(
                sprite.canvas,
                Math.round(a * x + e) - sprite.x,
                Math.round(d * y + f) - sprite.y,
            )
            if (!sprite.contexts.has(ctx)) {
                if (sprite.contexts.size === maxSpriteContexts) {
                    const oldest = sprite.contexts.values().next().value
                    if (oldest) {
                        oldest.releaseImage(sprite.canvas)
                        sprite.contexts.delete(oldest)
                    }
                }
                sprite.contexts.add(ctx)
            }
            return true
        },
        clear() {
            for (const sprite of sprites.values()) release(sprite)
            sprites.clear()
            for (const sprite of transients.values()) release(sprite)
            transients.clear()
            measurer = undefined
        },
    }
}

export type LabelSprites = ReturnType<typeof createLabelSprites>
