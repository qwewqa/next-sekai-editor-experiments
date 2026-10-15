import { MeshGeometry, Texture, type FillInput, type StrokeStyle } from 'pixi.js'
import { meshPaint } from './pixiPaint'

const coordinate = (values: ArrayLike<number>, index: number) => values[index] ?? 0

/** Final union triangles, using Pixi's normal mesh batching and paint textures. */
export class PathMeshGeometry extends MeshGeometry {
    readonly texture: Texture
    readonly tint: number
    readonly styleAlpha: number
    readonly originX: number
    readonly originY: number
    readonly positionError: number
    private released = false

    constructor(triangles: Float64Array, paint: FillInput | StrokeStyle, resolution: number) {
        const style = meshPaint(paint)
        // Application paints are solid colors or whole-source, global gradient
        // ramps. Pattern/frame texture coordinates remain on native Graphics.
        if (!style) throw new TypeError('Unsupported path mesh paint')
        const texture = style.texture
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity
        for (let i = 0; i < triangles.length; i += 2) {
            const x = coordinate(triangles, i) * resolution,
                y = coordinate(triangles, i + 1) * resolution
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
        }
        const originX = triangles.length ? minX + (maxX - minX) / 2 : 0,
            originY = triangles.length ? minY + (maxY - minY) / 2 : 0
        const positions = new Float32Array(triangles.length)
        const uvs = new Float32Array(triangles.length)
        const indices = new Uint32Array(triangles.length / 2)
        const matrix = style.matrix?.clone().invert()
        const width = texture.source.width,
            height = texture.source.height
        let squaredPositionError = 0
        for (let i = 0; i < triangles.length; i += 2) {
            const x = coordinate(triangles, i) * resolution,
                y = coordinate(triangles, i + 1) * resolution
            const localX = x - originX,
                localY = y - originY
            positions[i] = localX
            positions[i + 1] = localY
            const errorX = coordinate(positions, i) - localX,
                errorY = coordinate(positions, i + 1) - localY
            squaredPositionError = Math.max(squaredPositionError, errorX * errorX + errorY * errorY)
            // UVs use the original double coordinates, before local-origin
            // Float32 packing, matching native Graphics' global paint mapping.
            uvs[i] =
                texture === Texture.WHITE
                    ? 0.5
                    : matrix
                      ? (matrix.a * x + matrix.c * y + matrix.tx) / width
                      : x / width
            uvs[i + 1] =
                texture === Texture.WHITE
                    ? 0.5
                    : matrix
                      ? (matrix.b * x + matrix.d * y + matrix.ty) / height
                      : y / height
            indices[i / 2] = i / 2
        }
        super({ positions, uvs, indices })
        this.batchMode = 'batch'
        this.texture = texture
        this.tint = style.tint
        this.styleAlpha = style.alpha
        this.originX = originX
        this.originY = originY
        this.positionError = Math.sqrt(squaredPositionError)
    }

    static supports(paint: FillInput | StrokeStyle) {
        return !!meshPaint(paint)
    }

    get destroyed() {
        return this.released
    }

    override destroy() {
        if (this.released) return
        this.released = true
        // Mesh nodes borrow this geometry. The cache owns all three buffers;
        // their destroy event also releases the shared gradient ramp reference.
        super.destroy(true)
    }
}
