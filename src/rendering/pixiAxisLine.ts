import {
    DefaultBatcher,
    ExtensionType,
    Shader,
    Sprite,
    Texture,
    colorBitGl,
    compileHighShaderGlProgram,
    extensions,
    generateTextureBatchBitGl,
    getBatchSamplersUniformGroup,
    roundPixelsBitGl,
    type BatcherOptions,
    type DefaultBatchableQuadElement,
} from 'pixi.js'

const axisBit = {
    name: 'editor-axis-line-coverage',
    vertex: {
        header: 'out highp float vEditorAxis; out highp vec4 vAxisInfo;',
        main: `
            vEditorAxis = aTextureIdAndRound.x < 2. ? 0. :
                aTextureIdAndRound.x == 2. ? 2. :
                1. + (aTextureIdAndRound.x - 3.) / 65532.;
            vAxisInfo = vec4(0.);
            if (vEditorAxis > .5) {
                vec2 pixelScale = abs(vec2(uProjectionMatrix[0][0], uProjectionMatrix[1][1])) * uResolution * .5;
                vec2 offset = (uWorldTransformMatrix * vec3(aPosition - aUV, 0.)).xy * pixelScale;
                vec2 padding = vec2(abs(uWorldTransformMatrix[0][0]) + abs(uWorldTransformMatrix[1][0]), abs(uWorldTransformMatrix[0][1]) + abs(uWorldTransformMatrix[1][1])) * pixelScale;
                vAxisInfo = vec4(offset, abs(offset) - padding);
            }`,
    },
    fragment: {
        header: 'in highp float vEditorAxis; in highp vec4 vAxisInfo;',
        end: `
            if (vEditorAxis > .5) {
                highp vec2 pixels = vAxisInfo.zw - abs(vAxisInfo.xy);
                highp float coverage = clamp(min(pixels.x, pixels.y) + .5, 0., 1.) * (vEditorAxis - 1.);
                // Preserve continuous coverage through blending. Pre-quantizing
                // source alpha accumulates visible errors on repeated strokes.
                highp float alpha = max(0., coverage * vColor.a - .0000005);
                finalColor = vec4(vColor.a > 0. ? vColor.rgb * (alpha / vColor.a) : vec3(0.), alpha);
            }
        `,
    },
}

const createShader = (maxTextures: number) => {
    const program = compileHighShaderGlProgram({
        name: 'editor-native-batch-with-axis-lines',
        bits: [colorBitGl, generateTextureBatchBitGl(maxTextures), roundPixelsBitGl, axisBit],
    })
    return new Shader({
        glProgram: program,
        resources: { batchSamplers: getBatchSamplersUniformGroup(maxTextures) },
    })
}

const shaders = new Map<number, { shader: Shader; users: number }>()

/**
 * A native Sprite whose padded quad carries analytic axis-line coverage. Its
 * geometry remains phase independent when a retained group moves fractionally.
 * The owner must use a separate pool from ordinary image sprites.
 */
export class AxisLineSprite extends Sprite {
    axisWidth = 1
    axisHeight = 1
    coverageFactor = 1

    constructor() {
        super(Texture.WHITE)
    }

    setLine(x0: number, y0: number, x1: number, y1: number, width: number) {
        if (![x0, y0, x1, y1, width].every(Number.isFinite) || width <= 0) return false
        const vertical = x0 === x1
        if ((!vertical && y0 !== y1) || (vertical ? Math.abs(y1 - y0) : Math.abs(x1 - x0)) === 0)
            return false
        const left = vertical ? x0 - width / 2 : Math.min(x0, x1)
        const right = vertical ? x0 + width / 2 : Math.max(x0, x1)
        const top = vertical ? Math.min(y0, y1) : y0 - width / 2
        const bottom = vertical ? Math.max(y0, y1) : y0 + width / 2
        const nativeWidth = right - left
        const nativeHeight = bottom - top
        // Native AA expands a subpixel dimension to one device pixel about its
        // center, then attenuates coverage by the original dimension.
        this.coverageFactor = Math.min(nativeWidth, 1) * Math.min(nativeHeight, 1)
        this.axisWidth = Math.max(nativeWidth, 1)
        this.axisHeight = Math.max(nativeHeight, 1)
        this.position.set(
            (left + right - this.axisWidth) / 2 - 1,
            (top + bottom - this.axisHeight) / 2 - 1,
        )
        this.width = this.axisWidth + 2
        this.height = this.axisHeight + 2
        return true
    }
}

class EditorBatcher extends DefaultBatcher {
    static override readonly extension = {
        type: [ExtensionType.Batcher],
        name: 'default',
    } as const

    private readonly shaderEntry: { shader: Shader; users: number }
    private released = false

    constructor(options: BatcherOptions) {
        super(options)
        let entry = shaders.get(options.maxTextures)
        if (!entry) {
            entry = { shader: createShader(options.maxTextures), users: 0 }
            shaders.set(options.maxTextures, entry)
        }
        entry.users++
        this.shaderEntry = entry
        this.shader = entry.shader
    }

    override packQuadAttributes(
        element: DefaultBatchableQuadElement,
        floats: Float32Array,
        integers: Uint32Array,
        index: number,
        textureId: number,
    ) {
        super.packQuadAttributes(element, floats, integers, index, textureId)
        const sprite = (element as DefaultBatchableQuadElement & { renderable?: Sprite }).renderable
        if (!(sprite instanceof AxisLineSprite)) return
        const { transform: matrix, bounds } = element
        const x = (bounds.minX + bounds.maxX) / 2
        const y = (bounds.minY + bounds.maxY) / 2
        const centerX = matrix.a * x + matrix.c * y + matrix.tx
        const centerY = matrix.b * x + matrix.d * y + matrix.ty
        const color = (element.color & 0xffffff) | (Math.round(sprite.groupAlpha * 255) << 24)
        // The unused roundPixels values carry subpixel coverage without adding
        // vertex attributes. Native rounding still recognizes only value 1.
        // Round the factor down so exact half-alpha values do not cross upward.
        const axisMarker =
            sprite.coverageFactor === 1 ? 2 : 3 + Math.floor(sprite.coverageFactor * 65532)
        const marker = (textureId << 16) | axisMarker
        for (let vertex = 0; vertex < 4; vertex++) {
            const offset = index + vertex * 6
            floats[offset + 2] = centerX
            floats[offset + 3] = centerY
            integers[offset + 4] = color
            integers[offset + 5] = marker
        }
    }

    override destroy() {
        if (this.released) return
        this.released = true
        if (!--this.shaderEntry.users) {
            this.shaderEntry.shader.destroy(true)
            shaders.delete(this.maxTextures)
        }
        super.destroy()
    }
}

extensions.add(EditorBatcher)
