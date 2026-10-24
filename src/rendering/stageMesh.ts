import { Buffer, BufferUsage, Geometry, GlProgram, Mesh, Shader } from 'pixi.js'
import type { Matrix } from './matrix'

const vertex = `#version 300 es
in vec2 aPosition;
in vec4 aColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec4 uColor;
out vec4 vColor;
void main() {
    gl_Position=vec4((uProjectionMatrix*uWorldTransformMatrix*uTransformMatrix*vec3(aPosition,1.0)).xy,0.0,1.0);
    vColor=aColor*uWorldColorAlpha*uColor;
}`
const fragment = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor=vColor; }
`

export class StageMesh extends Mesh<Geometry, Shader> {}

/** Stage slices keep painter order in one triangle stream, without stencil barriers. */
export class StageMeshes {
    private shader: Shader | undefined
    private readonly live = new Set<StageMesh>()
    // Owned by a caller's cache across frames; recycling a frame leaves them intact.
    private readonly retained = new Set<StageMesh>()

    draw(vertices: readonly number[], matrix: Matrix) {
        const mesh = this.create(vertices, matrix)
        this.live.add(mesh)
        return mesh
    }

    /** A mesh the caller keeps across frames and returns with `release`. */
    retain(vertices: readonly number[], matrix: Matrix) {
        const mesh = this.create(vertices, matrix)
        this.retained.add(mesh)
        return mesh
    }

    release(mesh: StageMesh) {
        if (!this.retained.delete(mesh)) return
        mesh.removeFromParent()
        mesh.geometry.destroy(true)
        mesh.destroy()
    }

    private create(vertices: readonly number[], matrix: Matrix) {
        this.shader ??= new Shader({
            glProgram: GlProgram.from({ name: 'editor-stage-colors', vertex, fragment }),
            resources: {},
        })
        const data = new Float32Array(vertices.length)
        const [a, b, c, d, e, f] = matrix
        for (let i = 0; i < vertices.length; i += 6) {
            const x = vertices[i] ?? 0
            const y = vertices[i + 1] ?? 0
            data[i] = a * x + c * y + e
            data[i + 1] = b * x + d * y + f
            for (let channel = 2; channel < 6; channel++)
                data[i + channel] = vertices[i + channel] ?? 0
        }
        const buffer = new Buffer({ data, usage: BufferUsage.VERTEX, shrinkToFit: true })
        const geometry = new Geometry({
            attributes: {
                aPosition: { buffer, format: 'float32x2', stride: 24, offset: 0 },
                aColor: { buffer, format: 'float32x4', stride: 24, offset: 8 },
            },
        })
        return new StageMesh({ geometry, shader: this.shader })
    }

    recycle(mesh: StageMesh) {
        if (!this.live.delete(mesh)) return
        mesh.geometry.destroy(true)
        mesh.destroy()
    }

    destroy() {
        for (const mesh of this.live) this.recycle(mesh)
        for (const mesh of this.retained) this.release(mesh)
        this.shader?.destroy()
        this.shader = undefined
    }
}

/** Flat-colored triangles; alpha is premultiplied once before interpolation. */
export class StageTriangles {
    readonly vertices: number[] = []

    constructor(private readonly matrix: Matrix = [1, 0, 0, 1, 0, 0]) {}

    /** Device-space Float32 packing stays below 1/128 pixel on these bounds. */
    supportsBounds(left: number, top: number, right: number, bottom: number) {
        const [a, b, c, d, e, f] = this.matrix
        for (const x of [left, right])
            for (const y of [top, bottom]) {
                const px = a * x + c * y + e
                const py = b * x + d * y + f
                if (
                    !Number.isFinite(px) ||
                    !Number.isFinite(py) ||
                    Math.abs(px) > 131072 ||
                    Math.abs(py) > 131072
                )
                    return false
            }
        return true
    }

    append(triangles: Float64Array, color: number, alpha: number) {
        if (!(alpha > 0)) return
        const r = (((color >>> 16) & 255) / 255) * alpha
        const g = (((color >>> 8) & 255) / 255) * alpha
        const b = ((color & 255) / 255) * alpha
        for (let i = 0; i < triangles.length; i += 2)
            this.vertices.push(triangles[i] ?? 0, triangles[i + 1] ?? 0, r, g, b, alpha)
    }
}
