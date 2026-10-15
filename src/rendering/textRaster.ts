/**
 * Browser font shaping is kept for system fonts, language-specific fallback and
 * colour emoji. Only glyphs are rasterised here; their compositing and clipping
 * are performed by the WebGL renderer.
 */
/**
 * The sole Canvas2D entry point: browser font metrics and immutable glyph sprites.
 * A supplied sprite canvas keeps its dimensions, language and existing state.
 * Measurement callers own an independent, minimal surface and its font state.
 */
export const createFontContext = (canvas?: HTMLCanvasElement) => {
    if (!canvas) {
        canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
    }
    return canvas.getContext('2d')
}

type CanvasTransformPrecision = {
    roundMatrixArguments: boolean
    roundScaleArguments: boolean
    roundComposition: boolean
}
let transformPrecision: CanvasTransformPrecision | undefined

/** Preserve native glyph snapping and waveform thresholds without browser sniffing. */
export const getCanvasTransformPrecision = (): CanvasTransformPrecision => {
    if (transformPrecision) return transformPrecision
    const context = createFontContext()
    if (!context) throw new Error('Browser font rendering is unavailable.')
    const value = 1 / 3
    context.setTransform(value, 0, 0, value, 0, 0)
    const roundMatrixArguments = context.getTransform().a !== value
    context.resetTransform()
    context.scale(value, value)
    const roundScaleArguments = context.getTransform().a !== value
    context.scale(value, value)
    const composed = context.getTransform().a
    return (transformPrecision = {
        roundMatrixArguments,
        roundScaleArguments,
        roundComposition: composed === Math.fround(composed),
    })
}

export type TextRasterStyle = {
    font: string
    fontKerning?: CanvasFontKerning
    textAlign?: CanvasTextAlign
    textBaseline?: CanvasTextBaseline
    direction?: CanvasDirection
    lang?: string
}

export type TextRasterRequest = TextRasterStyle & {
    text: string
    x: number
    y: number
    maxWidth?: number
    fillStyle: string
    /** Canvas's affine transform, including the device-pixel ratio. */
    matrix: readonly [number, number, number, number, number, number]
    /** Limits allocation for very long labels to the visible target. */
    viewport?: { width: number; height: number }
}

export type TextRaster = {
    /** Immutable: GPU texture caches may retain this after raster-cache eviction. */
    source: HTMLCanvasElement
    left: number
    top: number
    width: number
    height: number
}

type RasterEntry = Pick<TextRaster, 'source' | 'width' | 'height'>
type MetricEntry = { id: number; value: TextMetrics }

const maxCachedPixels = 4 * 1024 * 1024
const maxCachedSprites = 1024
const maxCachedMetrics = 4096
const maxRecentStyles = 8
const padding = 2
// Integer scroll translations can acquire ~1e-12 device-pixel noise when scene
// transforms cancel. Keep that noise out of sprite keys and pixel-bound rounding;
// 1e-8 pixels is far below the browser's glyph rasterization precision.
const deviceCoordinate = (value: number) => Math.round(value * 1e8) / 1e8
// Reuse native whole-string sprites during fractional scrolling without GPU
// resampling. Only the final device-space origin changes, by at most 1/128 px;
// native hinting can cross an edge threshold slightly earlier as a result.
const textOrigin = (value: number) => Math.round(deviceCoordinate(value) * 64) / 64
const rasters = new Map<string, RasterEntry>()
const metrics = new Map<string, MetricEntry>()
const styles = new Map<string, ResolvedStyle>()
const recentStyles: ResolvedStyle[] = []
let lastStyle: ResolvedStyle | undefined
let nextStyleId = 0
let nextMetricId = 0
let cachedPixels = 0
let measurer: CanvasRenderingContext2D | undefined
let fontGeneration = 0
let observedFonts: FontFaceSet | undefined

/** Also useful when a caller explicitly replaces fonts outside FontFaceSet loading. */
export const clearTextRasterCache = () => {
    rasters.clear()
    metrics.clear()
    styles.clear()
    recentStyles.length = 0
    lastStyle = undefined
    cachedPixels = 0
    fontGeneration++
}

export const getTextRasterFontGeneration = () => fontGeneration

const observeFonts = () => {
    if (observedFonts === document.fonts) return
    observedFonts?.removeEventListener('loadingdone', clearTextRasterCache)
    observedFonts?.removeEventListener('loadingerror', clearTextRasterCache)
    observedFonts = document.fonts
    observedFonts.addEventListener('loadingdone', clearTextRasterCache)
    observedFonts.addEventListener('loadingerror', clearTextRasterCache)
}

type ResolvedStyle = Required<TextRasterStyle> & { id: number }

// Most text in a frame shares a handful of styles. Intern their scalar fields so
// cache hits do not serialize the full font and language configuration twice.
const resolveStyle = (style: TextRasterStyle): ResolvedStyle => {
    const font = style.font
    const fontKerning = style.fontKerning ?? 'auto'
    const textAlign = style.textAlign ?? 'start'
    const textBaseline = style.textBaseline ?? 'alphabetic'
    const direction =
        style.direction && style.direction !== 'inherit'
            ? style.direction
            : document.documentElement.dir === 'rtl'
              ? ('rtl' as const)
              : ('ltr' as const)
    const lang = style.lang ?? document.documentElement.lang
    const matches = (cached: ResolvedStyle) =>
        cached.font === font &&
        cached.fontKerning === fontKerning &&
        cached.textAlign === textAlign &&
        cached.textBaseline === textBaseline &&
        cached.direction === direction &&
        cached.lang === lang
    if (lastStyle && matches(lastStyle)) return lastStyle
    for (const cached of recentStyles) if (matches(cached)) return (lastStyle = cached)
    const key = JSON.stringify([font, fontKerning, textAlign, textBaseline, direction, lang])
    let resolved = styles.get(key)
    if (resolved) styles.delete(key)
    else {
        resolved = {
            id: nextStyleId++,
            font,
            fontKerning,
            textAlign,
            textBaseline,
            direction,
            lang,
        }
        // Every style has at least one metric. Allow the entire metric working
        // set, including documents with many font sizes, to retain stable IDs.
        if (styles.size >= maxCachedMetrics) {
            const oldest = styles.keys().next().value
            if (oldest !== undefined) styles.delete(oldest)
        }
    }
    styles.set(key, resolved)
    if (recentStyles.length === maxRecentStyles) recentStyles.shift()
    recentStyles.push(resolved)
    return (lastStyle = resolved)
}

const applyStyle = (context: CanvasRenderingContext2D, style: ResolvedStyle) => {
    context.canvas.lang = style.lang
    context.font = style.font
    context.fontKerning = style.fontKerning
    context.textAlign = style.textAlign
    context.textBaseline = style.textBaseline
    context.direction = style.direction
}

const measure = (text: string, style: ResolvedStyle) => {
    const key = `${style.id}:${text}`
    let result = metrics.get(key)
    if (result) {
        metrics.delete(key)
        metrics.set(key, result)
        return result
    }
    observeFonts()
    if (!measurer) {
        const context = createFontContext()
        if (!context) throw new Error('Browser text measurement is unavailable')
        measurer = context
    }
    applyStyle(measurer, style)
    result = { id: nextMetricId++, value: measurer.measureText(text) }
    if (metrics.size >= maxCachedMetrics) {
        const oldest = metrics.keys().next().value
        if (oldest !== undefined) metrics.delete(oldest)
    }
    metrics.set(key, result)
    return result
}

/** Native TextMetrics, preserving the same font shaping used for rasterisation. */
export const measureText = (text: string, font: string, style?: Omit<TextRasterStyle, 'font'>) =>
    measure(text, resolveStyle({ ...style, font })).value

type RasterLayout = {
    style: ResolvedStyle
    metric: MetricEntry
    left: readonly [number, number]
    right: readonly [number, number]
    top: readonly [number, number]
    bottom: readonly [number, number]
}

const rasterLayout = (request: TextRasterRequest): RasterLayout | undefined => {
    const [a, b, c, d] = request.matrix
    if (!request.matrix.every(Number.isFinite) || a * d - b * c === 0) return
    const style = resolveStyle(request)
    const metric = measure(request.text, style)
    const ink = metric.value
    const horizontalScale =
        request.maxWidth === undefined ? 1 : Math.min(1, request.maxWidth / ink.width)
    const inkLeft = -ink.actualBoundingBoxLeft * horizontalScale
    const inkRight = ink.actualBoundingBoxRight * horizontalScale
    const inkTop = -ink.actualBoundingBoxAscent
    const inkBottom = ink.actualBoundingBoxDescent
    if (inkLeft === inkRight || inkTop === inkBottom) return
    const ax0 = a * inkLeft,
        ax1 = a * inkRight
    const cx0 = c * inkTop,
        cx1 = c * inkBottom
    const by0 = b * inkLeft,
        by1 = b * inkRight
    const dy0 = d * inkTop,
        dy1 = d * inkBottom
    return {
        style,
        metric,
        left: [Math.min(ax0, ax1), Math.min(cx0, cx1)],
        right: [Math.max(ax0, ax1), Math.max(cx0, cx1)],
        top: [Math.min(by0, by1), Math.min(dy0, dy1)],
        bottom: [Math.max(by0, by1), Math.max(dy0, dy1)],
    }
}

/** A visible editor annotation keeps its font metrics and transformed ink bounds. */
export class PreparedTextRaster {
    private layout: RasterLayout | undefined
    private generation = -1
    private direction?: CanvasDirection
    private lang?: string
    private last?: { originX: number; originY: number; width: number; height: number; key: string }

    constructor(private readonly request: TextRasterRequest) {}

    get(
        e: number,
        f: number,
        viewport: { width: number; height: number },
        direction: CanvasDirection,
    ) {
        const lang = document.documentElement.lang
        if (
            this.generation !== fontGeneration ||
            this.direction !== direction ||
            this.lang !== lang
        ) {
            this.request.direction = direction
            this.request.lang = lang
            this.layout = rasterLayout(this.request)
            this.generation = fontGeneration
            this.direction = direction
            this.lang = lang
            this.last = undefined
        }
        if (!this.layout) return null
        const [a, b, c, d] = this.request.matrix
        return rasterize(
            { ...this.request, matrix: [a, b, c, d, e, f], viewport },
            this.layout,
            this,
        )
    }

    reuse(originX: number, originY: number, width: number, height: number) {
        const last = this.last
        if (
            last?.originX !== originX ||
            last.originY !== originY ||
            last.width !== width ||
            last.height !== height
        )
            return
        const raster = rasters.get(last.key)
        if (raster) {
            rasters.delete(last.key)
            rasters.set(last.key, raster)
        }
        return raster
    }

    remember(originX: number, originY: number, width: number, height: number, key: string) {
        // Retain a cache key, not its canvas: visible annotation handles cannot
        // extend bitmap lifetimes beyond the shared bounded raster cache.
        this.last = { originX, originY, width, height, key }
    }
}

/**
 * Rasterises at the exact affine scale on a 1/64-device-pixel origin grid. Whole
 * pixel translations reuse the same immutable source without resampling glyphs.
 */
export const getTextRaster = (request: TextRasterRequest): TextRaster | null => {
    const { text, x, y, maxWidth } = request
    if (
        !text ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        (maxWidth !== undefined && (!Number.isFinite(maxWidth) || maxWidth <= 0))
    )
        return null

    const layout = rasterLayout(request)
    return layout ? rasterize(request, layout) : null
}

type NameOutline = { radius: number; maxDimension: number }

/**
 * Rare oversized names share the bounded native-text cache and visible bounds.
 * Keep their integer name origin and native baseline, without the general
 * text path's 1/64 baseline quantization. The caller releases the GPU upload
 * after drawing; the returned CPU source remains immutable.
 */
export const getOutlinedNameRaster = (
    request: Omit<TextRasterRequest, 'maxWidth'> & { viewport: { width: number; height: number } },
    radius: number,
    maxDimension: number,
): TextRaster | null => {
    if (!request.text || ![request.x, request.y, radius].every(Number.isFinite) || radius <= 0)
        return null
    const layout = rasterLayout(request)
    if (!layout) return null
    const [a, b, c, d] = request.matrix
    const padX = radius * Math.hypot(a, c)
    const padY = radius * Math.hypot(b, d)
    const outlined: RasterLayout = {
        ...layout,
        left: [layout.left[0] - padX, layout.left[1]],
        right: [layout.right[0] + padX, layout.right[1]],
        top: [layout.top[0] - padY, layout.top[1]],
        bottom: [layout.bottom[0] + padY, layout.bottom[1]],
    }
    return rasterize(request, outlined, undefined, { radius, maxDimension })
}

const rasterize = (
    request: TextRasterRequest,
    layout: RasterLayout,
    prepared?: PreparedTextRaster,
    outline?: NameOutline,
): TextRaster | null => {
    const { text, x, y, maxWidth, matrix, viewport } = request
    const [a, b, c, d, e, f] = matrix
    const { style, metric } = layout
    const anchorX = outline ? a * x + c * y + e : textOrigin(a * x + c * y + e)
    const anchorY = outline ? b * x + d * y + f : textOrigin(b * x + d * y + f)
    // Keep the native path's operation order at large fractional coordinates.
    let left = Math.floor(anchorX + layout.left[0] + layout.left[1]) - padding
    let right = Math.ceil(anchorX + layout.right[0] + layout.right[1]) + padding
    let top = Math.floor(anchorY + layout.top[0] + layout.top[1]) - padding
    let bottom = Math.ceil(anchorY + layout.bottom[0] + layout.bottom[1]) + padding
    if (viewport) {
        left = Math.max(0, left)
        right = Math.min(viewport.width, right)
        top = Math.max(0, top)
        bottom = Math.min(viewport.height, bottom)
    }
    const width = right - left
    const height = bottom - top
    if (width <= 0 || height <= 0 || !Number.isFinite(width * height)) return null
    if (outline && (width > outline.maxDimension || height > outline.maxDimension))
        throw new RangeError('Visible name raster exceeds WebGL hardware limits')

    // Subtracting the integer bounds can reintroduce floating-point noise even
    // after the anchor is canonical, so canonicalize the final local origin too.
    const originX = outline ? e - left : deviceCoordinate(anchorX - left)
    const originY = outline ? f - top : deviceCoordinate(anchorY - top)
    const reused = prepared?.reuse(originX, originY, width, height)
    if (reused) return { ...reused, left, top }
    const key = JSON.stringify([
        metric.id,
        request.fillStyle,
        maxWidth,
        a,
        b,
        c,
        d,
        originX,
        originY,
        width,
        height,
        ...(outline ? ['name-outline', outline.radius, x, y] : []),
    ])
    let raster = rasters.get(key)
    if (raster) {
        rasters.delete(key)
        rasters.set(key, raster)
        prepared?.remember(originX, originY, width, height, key)
        return { source: raster.source, width: raster.width, height: raster.height, left, top }
    }

    const source = document.createElement('canvas')
    source.width = width
    source.height = height
    const context = createFontContext(source)
    if (!context) throw new Error('Browser text rasterisation is unavailable')
    applyStyle(context, style)
    context.fillStyle = request.fillStyle
    context.setTransform(a, b, c, d, originX, originY)
    if (outline) {
        context.strokeStyle = '#000'
        context.lineWidth = outline.radius * 2
        context.lineJoin = 'round'
        context.strokeText(text, x, y)
        context.fillText(text, x, y)
    } else if (maxWidth === undefined) context.fillText(text, 0, 0)
    else context.fillText(text, 0, 0, maxWidth)
    raster = { source, width, height }
    const pixels = width * height
    // Oversize visible text still draws; it simply does not evict the working set.
    if (pixels <= maxCachedPixels) {
        while (rasters.size >= maxCachedSprites || cachedPixels + pixels > maxCachedPixels) {
            const oldest = rasters.entries().next().value
            if (!oldest) break
            rasters.delete(oldest[0])
            cachedPixels -= oldest[1].width * oldest[1].height
        }
        rasters.set(key, raster)
        cachedPixels += pixels
    }
    prepared?.remember(originX, originY, width, height, key)
    return { source, width, height, left, top }
}
