import assert from 'node:assert/strict'
import { buildContextBatches, GpuGraphicsContext, type GraphicsContext } from 'pixi.js'
import { PathMeshGeometry } from '../../src/rendering/pathMesh'

/** Read actual native geometry in the shared, resolution-scaled path coordinates. */
export function pathResourceGeometry(resource: GraphicsContext | PathMeshGeometry) {
    const result = { vertices: [] as number[], indices: [] as number[], uvs: [] as number[] }
    if (resource instanceof PathMeshGeometry) {
        result.vertices = Array.from(
            resource.positions,
            (value, index) => value + (index % 2 ? resource.originY : resource.originX),
        )
        result.indices = Array.from(resource.indices)
        result.uvs = Array.from(resource.uvs)
    } else {
        const scratch = new GpuGraphicsContext()
        try {
            buildContextBatches(resource, scratch)
            result.vertices = [...scratch.geometryData.vertices]
            result.indices = [...scratch.geometryData.indices]
            result.uvs = [...scratch.geometryData.uvs]
        } finally {
            for (const batch of scratch.batches) batch.destroy()
            scratch.destroy()
        }
    }
    assert.ok(result.vertices.every(Number.isFinite), 'finite GPU positions')
    assert.ok(result.uvs.every(Number.isFinite), 'finite GPU UVs')
    assert.equal(result.indices.length % 3, 0, 'complete triangle-list indices')
    assert.ok(
        result.indices.every(
            (index) => Number.isInteger(index) && index >= 0 && index < result.vertices.length / 2,
        ),
        'valid GPU indices',
    )
    assert.equal(result.uvs.length, result.vertices.length)
    return result
}
