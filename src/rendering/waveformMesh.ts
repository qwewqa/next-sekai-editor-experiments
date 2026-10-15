import {
    GlProgram,
    Mesh,
    MeshGeometry,
    Shader,
    Texture,
    UniformGroup,
    type Container,
} from 'pixi.js'
import type { Matrix } from './matrix'

const vertex = `#version 300 es
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec4 uColor;
out vec2 vUV;
out vec4 vColor;
void main() {
    gl_Position=vec4((uProjectionMatrix*uWorldTransformMatrix*uTransformMatrix*vec3(aPosition,1.0)).xy,0.0,1.0);
    vUV=aUV;
    vColor=uWorldColorAlpha*uColor;
}`
const fragment = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec4 uAxisX;
uniform vec4 uAxisY;
uniform vec4 uFrame;
uniform vec4 uExtent;
uniform vec2 uEnabled;
in vec2 vUV;
in vec4 vColor;
out vec4 outColor;
float sourceIndex(float n, vec4 axis) {
    return axis.x+axis.z*n+ceil(axis.y+n*axis.w)-1.0;
}
void main() {
    vec2 screen=floor(vec2(gl_FragCoord.x,uExtent.z-gl_FragCoord.y));
    vec2 uv=vUV;
    if(uEnabled.x>0.5) uv.x=(clamp(sourceIndex(screen.x,uAxisX),uFrame.x,uFrame.z-1.0)+0.5)/uExtent.x;
    if(uEnabled.y>0.5) uv.y=(clamp(sourceIndex(screen.y,uAxisY),uFrame.y,uFrame.w-1.0)+0.5)/uExtent.y;
    outColor=texture(uTexture,uv)*vColor;
}`

const axis = (origin: number, scale: number, translation: number) => {
    const first = origin + (0.5 - translation) / scale
    const base = Math.floor(first)
    const sign = Math.sign(scale)
    // Keep the small correction separate from the integer row. Interpolating
    // normalized UVs near 1:1 can skip a one-row attack at a triangle boundary.
    return [base, first - base, sign, 1 / scale - sign]
}

type WaveformNode = {
    mesh: Mesh<MeshGeometry, Shader>
    shader: Shader
    uniforms: UniformGroup<{
        uAxisX: { value: Float32Array; type: 'vec4<f32>' }
        uAxisY: { value: Float32Array; type: 'vec4<f32>' }
        uFrame: { value: Float32Array; type: 'vec4<f32>' }
        uExtent: { value: Float32Array; type: 'vec4<f32>' }
        uEnabled: { value: Float32Array; type: 'vec2<f32>' }
    }>
}

/** Few waveform tiles use native Pixi meshes; ordinary editor sprites stay batched. */
export class WaveformMeshes {
    private readonly nodes = new Map<Container, WaveformNode>()
    private readonly free: WaveformNode[] = []

    draw(
        texture: Texture,
        frame: readonly [number, number, number, number],
        matrix: Matrix,
        targetHeight: number,
        alpha: number,
    ) {
        let node = this.free.pop()
        if (!node) {
            const uniforms = new UniformGroup({
                uAxisX: { value: new Float32Array(4), type: 'vec4<f32>' },
                uAxisY: { value: new Float32Array(4), type: 'vec4<f32>' },
                uFrame: { value: new Float32Array(4), type: 'vec4<f32>' },
                uExtent: { value: new Float32Array(4), type: 'vec4<f32>' },
                uEnabled: { value: new Float32Array(2), type: 'vec2<f32>' },
            } as const)
            const shader = new Shader({
                glProgram: GlProgram.from({
                    name: 'editor-waveform',
                    vertex,
                    fragment,
                    preferredFragmentPrecision: 'highp',
                }),
                resources: { uTexture: texture.source, waveformUniforms: uniforms },
            })
            const geometry = new MeshGeometry({})
            geometry.indexBuffer.data = new Uint16Array([0, 1, 2, 0, 2, 3])
            const mesh = new Mesh({
                geometry,
                shader,
                texture,
            })
            node = { mesh, shader, uniforms }
            this.nodes.set(mesh, node)
        }
        const { mesh, uniforms } = node
        const [left, top, right, bottom] = frame
        const width = right - left,
            height = bottom - top
        const [a, , , d, e, f] = matrix
        // Peak rows own whole destination pixels. Fractional tile edges would
        // otherwise fade an isolated attack through MSAA, even though its row
        // was selected correctly. Adjacent tiles use the same rounded edge;
        // the shader still uses the original matrix and sampling phase below.
        // Match the float32 vertex position before assigning pixel ownership.
        const rowEdge = (value: number) =>
            d > 0 ? Math.floor(Math.fround(value) + 0.5) : Math.ceil(Math.fround(value) - 0.5)
        const startY = Math.abs(d) >= 1 ? rowEdge(f) : f
        const endY = Math.abs(d) >= 1 ? rowEdge(f + d * height) : f + d * height
        mesh.geometry.positions.set([
            e,
            startY,
            e + a * width,
            startY,
            e + a * width,
            endY,
            e,
            endY,
        ])
        mesh.geometry.uvs.set([
            left / texture.source.width,
            top / texture.source.height,
            right / texture.source.width,
            top / texture.source.height,
            right / texture.source.width,
            bottom / texture.source.height,
            left / texture.source.width,
            bottom / texture.source.height,
        ])
        mesh.geometry.getBuffer('aPosition').update()
        mesh.geometry.getBuffer('aUV').update()
        mesh.texture = texture
        node.shader.resources.uTexture = texture.source
        mesh.alpha = alpha
        mesh.renderable = true
        uniforms.uniforms.uAxisX.set(axis(left, a, e))
        uniforms.uniforms.uAxisY.set(axis(top, d, f))
        uniforms.uniforms.uFrame.set(frame)
        uniforms.uniforms.uExtent.set([
            texture.source.width,
            texture.source.height,
            targetHeight,
            0,
        ])
        uniforms.uniforms.uEnabled.set([Math.abs(a) >= 1 ? 1 : 0, Math.abs(d) >= 1 ? 1 : 0])
        uniforms.update()
        return mesh
    }

    recycle(mesh: Container) {
        const node = this.nodes.get(mesh)
        if (!node) return
        if (this.free.length >= 32) {
            this.destroyNode(node)
            return
        }
        node.mesh.texture = Texture.EMPTY
        node.shader.resources.uTexture = Texture.EMPTY.source
        this.free.push(node)
    }

    destroy() {
        for (const node of this.nodes.values()) this.destroyNode(node)
        this.free.length = 0
    }

    private destroyNode({ mesh, shader }: WaveformNode) {
        this.nodes.delete(mesh)
        const geometry = mesh.geometry
        mesh.destroy()
        geometry.destroy()
        shader.destroy()
    }
}
