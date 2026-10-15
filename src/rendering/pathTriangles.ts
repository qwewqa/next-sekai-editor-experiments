import { buildContextBatches, GpuGraphicsContext, type GraphicsContext } from 'pixi.js'
import { certifyNativeStrokeStrip } from './nativeStrokeStrip'
import { PathMeshGeometry } from './pathMesh'

/** Inspect native CPU geometry without retaining Pixi's borrowed scratch batches. */
function inspectNative<T>(resource: GraphicsContext, inspect: (scratch: GpuGraphicsContext) => T) {
    const scratch = new GpuGraphicsContext()
    try {
        buildContextBatches(resource, scratch)
        return inspect(scratch)
    } finally {
        try {
            for (const batch of scratch.batches) batch.destroy()
        } finally {
            scratch.destroy()
        }
    }
}

export const isNativeStrokeStrip = (resource: GraphicsContext, pointCount: number) =>
    inspectNative(
        resource,
        (scratch) =>
            scratch.batches.every((batch) => batch.topology === 'triangle-list') &&
            certifyNativeStrokeStrip(
                scratch.geometryData.vertices,
                scratch.geometryData.indices,
                pointCount,
            ),
    )

/** Same-winding boundary of a certified simple native stroke, in compiled coordinates. */
export function nativeStrokeBoundary(resource: GraphicsContext, pointCount: number) {
    return inspectNative(resource, (scratch): [number, number][] | undefined => {
        const { vertices, indices } = scratch.geometryData
        if (
            scratch.batches.some((batch) => batch.topology !== 'triangle-list') ||
            !certifyNativeStrokeStrip(vertices, indices, pointCount)
        )
            return
        const point = (i: number): [number, number] => [
            vertices[i * 2] ?? NaN,
            vertices[i * 2 + 1] ?? NaN,
        ]
        const boundary: [number, number][] = []
        for (let i = 0; i < vertices.length / 2; i += 2) boundary.push(point(i))
        for (let i = vertices.length / 2 - 1; i >= 1; i -= 2) boundary.push(point(i))
        const [a, b, c] = [point(0), point(1), point(2)] as const
        // The certificate proves a simple boundary and reliable triangle sign.
        // Its boundary is opposite the first triangle: make all boundaries
        // positive so nonzero winding unions crossed marker strokes.
        if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0) boundary.reverse()
        return boundary
    })
}

function expand(
    vertices: ArrayLike<number>,
    indices: ArrayLike<number>,
    maxCoordinates?: number,
    originX?: number,
    originY?: number,
) {
    if (maxCoordinates !== undefined && indices.length * 2 > maxCoordinates) return
    const triangles = new Float64Array(indices.length * 2)
    for (let i = 0; i < indices.length; i++) {
        const index = (indices[i] ?? NaN) * 2
        const x = vertices[index] ?? NaN,
            y = vertices[index + 1] ?? NaN
        triangles[i * 2] = originX === undefined ? x : x + originX
        triangles[i * 2 + 1] = originY === undefined ? y : y + originY
    }
    return triangles
}

/**
 * Copies the exact rendered triangle order into compiled path coordinates.
 * Mesh coordinates include their double origin; native coordinates remain
 * doubles. This does not apply a scene transform or inverse resolution scale.
 *
 * Pixi 8.22 exports buildContextBatches/GpuGraphicsContext but marks them internal.
 * Keep this version-pinned CPU-only dependency isolated here and covered by the
 * topology/ownership tests when upgrading Pixi. No renderer or renderer-owned
 * GPU data is read or created. Native input must be a normal cache-created path,
 * without manually attached holes or frame textures: Pixi's builder may mutate
 * arbitrary hole metadata. The caller retains ownership of the source. Temporary
 * batches clear their borrowed references before scratch.destroy() returns them
 * to BigPool, even if building or copying fails. Pixel-line topology is unsupported.
 * A coordinate cap declines before allocating the Float64 result; native shape
 * building still occurs and its scratch ownership is released before returning.
 */
export function pathTriangles(resource: GraphicsContext | PathMeshGeometry): Float64Array
export function pathTriangles(
    resource: GraphicsContext | PathMeshGeometry,
    maxCoordinates: number,
): Float64Array | undefined
export function pathTriangles(
    resource: GraphicsContext | PathMeshGeometry,
    maxCoordinates?: number,
): Float64Array | undefined {
    if (resource instanceof PathMeshGeometry) {
        if (resource.topology !== 'triangle-list')
            throw new TypeError('Path triangle extraction requires triangle-list topology')
        return expand(
            resource.positions,
            resource.indices,
            maxCoordinates,
            resource.originX,
            resource.originY,
        )
    }
    return inspectNative(resource, (scratch) => {
        if (scratch.batches.some((batch) => batch.topology !== 'triangle-list'))
            throw new TypeError('Path triangle extraction requires triangle-list topology')
        return expand(scratch.geometryData.vertices, scratch.geometryData.indices, maxCoordinates)
    })
}
