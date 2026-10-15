import {
    BufferImageSource,
    FillGradient,
    GraphicsContext,
    Matrix,
    Texture,
    type FillInput,
    type MeshGeometry,
    type StrokeStyle,
} from 'pixi.js'
import { DrawGradient, parseColor, type DrawStyle } from './paint'

// Unused ramps stay within both limits. Retained paths pin their
// ramps; the path-cache budget separately bounds active geometry and paints.
const MAX_RAMP_BYTES = 64 * 1024
const MAX_RAMPS = 256

type Ramp = { texture: Texture; bytes: number; users: number; disposed: boolean }

class RampPool {
    private readonly ramps = new Map<string, Ramp>()
    private bytes = 0

    get(gradient: DrawGradient) {
        // Coordinates belong to gradient metadata, not its shared texture.
        const key = JSON.stringify(gradient.stops)
        let ramp = this.ramps.get(key)
        if (ramp) {
            this.ramps.delete(key)
            this.ramps.set(key, ramp)
            return ramp
        }
        const [first, last] = gradient.stops
        const fade =
            gradient.stops.length === 2 &&
            first?.offset === 0 &&
            last?.offset === 1 &&
            first.color.slice(0, 3).every((value, i) => value === last.color[i])
        // Editor fades have fixed RGB and two endpoint alphas. Two premultiplied
        // texels reproduce that ramp without a large bitmap.
        const size = fade ? 2 : 1024
        const pixels = new Uint8Array(size * 4)
        const dx = gradient.end[0] - gradient.start[0]
        const dy = gradient.end[1] - gradient.start[1]
        for (let i = 0; i < size; i++) {
            const t = i / (size - 1)
            const [r, g, b, a] = gradient.at(gradient.start[0] + dx * t, gradient.start[1] + dy * t)
            pixels.set([r * a * 255, g * a * 255, b * a * 255, a * 255].map(Math.round), i * 4)
        }
        ramp = {
            texture: new Texture({
                source: new BufferImageSource({
                    resource: pixels,
                    width: size,
                    height: 1,
                    format: 'rgba8unorm',
                    alphaMode: 'premultiplied-alpha',
                    scaleMode: 'linear',
                    addressMode: 'clamp-to-edge',
                }),
            }),
            bytes: pixels.byteLength,
            users: 0,
            disposed: false,
        }
        this.ramps.set(key, ramp)
        this.bytes += ramp.bytes
        this.trim(ramp)
        return ramp
    }

    private trim(keep?: Ramp) {
        for (const [key, ramp] of this.ramps) {
            if (this.bytes <= MAX_RAMP_BYTES && this.ramps.size <= MAX_RAMPS) break
            if (ramp === keep || ramp.users) continue
            this.ramps.delete(key)
            this.bytes -= ramp.bytes
            ramp.disposed = true
            ramp.texture.destroy(true)
        }
    }

    retain(ramp: Ramp, context: GraphicsContext | MeshGeometry) {
        ramp.users++
        context.once('destroy', () => {
            ramp.users--
            this.trim()
        })
    }

    destroy() {
        for (const ramp of this.ramps.values()) {
            ramp.disposed = true
            ramp.texture.destroy(true)
        }
        this.ramps.clear()
        this.bytes = 0
    }
}

/** Pixi gradient metadata with a pooled pixel source, without Canvas gradients. */
class PixelGradient extends FillGradient {
    constructor(
        gradient: DrawGradient | Matrix,
        readonly ramp: Ramp,
        readonly pool: RampPool,
    ) {
        super({ type: 'linear', textureSpace: 'global' })
        this.texture = ramp.texture
        if (gradient instanceof Matrix) {
            this.transform = gradient.clone()
            return
        }
        const dx = gradient.end[0] - gradient.start[0]
        const dy = gradient.end[1] - gradient.start[1]
        const intervals = ramp.texture.width - 1
        const length = Math.hypot(dx, dy)
        // Endpoint colors sit at texel centers; sampling clamps outside the axis.
        this.transform = new Matrix(
            dx / intervals,
            dy / intervals,
            -dy / length,
            dx / length,
            gradient.start[0] - dx / (2 * intervals),
            gradient.start[1] - dy / (2 * intervals),
        )
    }

    override buildLinearGradient() {
        // The pool supplies the texture and this instance supplies its transform.
    }

    override destroy() {
        // The pool owns shared textures; one GraphicsContext must not destroy one.
    }
}

/** Match paint coordinates to paths compiled in resolution-scaled local units. */
export const scalePaint = (style: FillInput | StrokeStyle, factor: number) => {
    if (
        factor === 1 ||
        typeof style !== 'object' ||
        Array.isArray(style) ||
        !('width' in style || ('fill' in style && style.fill instanceof PixelGradient))
    )
        return style
    const scaled: StrokeStyle = { ...(style as StrokeStyle) }
    if ('width' in style && typeof style.width === 'number') scaled.width = style.width * factor
    if ('fill' in style && style.fill instanceof PixelGradient) {
        const { transform, ramp, pool } = style.fill
        scaled.fill = new PixelGradient(
            new Matrix(
                transform.a * factor,
                transform.b * factor,
                transform.c * factor,
                transform.d * factor,
                transform.tx * factor,
                transform.ty * factor,
            ),
            ramp,
            pool,
        )
    }
    return scaled
}

/** Called once when constructing a cached native path or tessellated mesh. */
export const retainPaint = (
    context: GraphicsContext | MeshGeometry,
    style: FillInput | StrokeStyle,
) => {
    if (typeof style !== 'object' || !('fill' in style)) return
    if (style.fill instanceof PixelGradient) style.fill.pool.retain(style.fill.ramp, context)
}

/** The editor's two paint forms, for direct triangle meshes using Pixi's batcher. */
export const meshPaint = (style: FillInput | StrokeStyle) => {
    if (!style || typeof style !== 'object' || Array.isArray(style)) return
    const alpha = 'alpha' in style ? (style.alpha ?? 1) : 1
    if (typeof alpha !== 'number') return
    if ('fill' in style) {
        if (!(style.fill instanceof PixelGradient)) return
        return {
            texture: style.fill.ramp.texture,
            tint: 0xffffff,
            alpha,
            matrix: style.fill.transform,
        }
    }
    // Texture patterns and other Pixi fill forms remain native Graphics. The
    // application supplies only parsed numeric colors and our pooled gradients.
    if ('texture' in style || 'matrix' in style || !('color' in style)) return
    if (typeof style.color !== 'number') return
    return { texture: Texture.WHITE, tint: style.color, alpha, matrix: undefined }
}

type GradientStyle = { version: number; fill: PixelGradient; key: string }

export class PaintStyles {
    private gradients = new WeakMap<DrawGradient, GradientStyle>()
    private readonly ramps = new RampPool()

    fill(style: DrawStyle): { style: FillInput; key: string } {
        if (style instanceof DrawGradient) {
            if (
                !style.stops.length ||
                (style.start[0] === style.end[0] && style.start[1] === style.end[1])
            )
                return { style: { color: 0, alpha: 0 }, key: 'transparent-gradient' }
            let cached = this.gradients.get(style)
            if (cached?.version !== style.id || cached.fill.ramp.disposed) {
                cached = {
                    version: style.id,
                    fill: new PixelGradient(style, this.ramps.get(style), this.ramps),
                    // Elevation recreates equivalent gradients. Their geometry
                    // can share retained contexts without instance-ID keys.
                    key: JSON.stringify([style.start, style.end, style.stops]),
                }
                this.gradients.set(style, cached)
            }
            return { style: { fill: cached.fill }, key: `g${cached.key}` }
        }
        const [r, g, b, a] = parseColor(style)
        return {
            style: {
                color:
                    (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255),
                alpha: a,
            },
            key: style,
        }
    }

    stroke(
        style: DrawStyle,
        width: number,
        cap: CanvasLineCap,
        join: CanvasLineJoin,
        miterLimit: number,
    ) {
        const fill = this.fill(style)
        return {
            style: { ...(fill.style as object), width, cap, join, miterLimit } as StrokeStyle,
            key: `${fill.key}/${width}/${cap}/${join}/${miterLimit}`,
        }
    }

    destroy() {
        this.ramps.destroy()
        this.gradients = new WeakMap()
    }
}
