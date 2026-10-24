import {
    Container,
    Graphics,
    Mesh,
    Matrix as PixiMatrix,
    Rectangle,
    RenderTexture,
    Sprite,
    Texture,
    type GraphicsContext,
    type TextureSource,
} from 'pixi.js'
import { EventStrokeGeometry, EventStrokeMesh, type PreparedEventStroke } from './eventStrokeMesh'
import {
    equalMatrix,
    identity,
    inverse,
    matrixObject,
    matrixOf,
    multiply,
    type Matrix,
} from './matrix'
import { DrawGradient, parseColor, type DrawStyle } from './paint'
import { DrawPath } from './path'
import { PathGraphicsCache, resolutionScale, type PathGraphicsResource } from './pathGraphics'
import { PathMeshGeometry } from './pathMesh'
import { AxisLineSprite } from './pixiAxisLine'
import { PaintStyles } from './pixiPaint'
import { PixelRectClip, type PixelBounds } from './pixiRectClip'
import { RenderingResources, type ImageSource } from './resources'
import { StageMesh, StageMeshes } from './stageMesh'
import {
    getCanvasTransformPrecision,
    getTextRaster,
    measureText,
    PreparedTextRaster,
} from './textRaster'
import { WaveformMeshes } from './waveformMesh'
export { DrawGradient } from './paint'
type Clip = {
    path: DrawPath
    matrix: Matrix
    rule: CanvasFillRule
    pixels?: PixelBounds
}
type State = {
    clips: Clip[]
    matrix: Matrix
    fillStyle: DrawStyle
    strokeStyle: DrawStyle
    globalAlpha: number
    globalCompositeOperation: GlobalCompositeOperation
    lineWidth: number
    lineCap: CanvasLineCap
    lineJoin: CanvasLineJoin
    miterLimit: number
    lineDashOffset: number
    dash: number[]
    font: string
    fontKerning: CanvasFontKerning
    textAlign: CanvasTextAlign
    textBaseline: CanvasTextBaseline
    direction: CanvasDirection
    imageSmoothingEnabled: boolean
}

const initialState = (): State => ({
    clips: [],
    matrix: identity(),
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    lineDashOffset: 0,
    dash: [],
    font: '10px sans-serif',
    fontKerning: 'auto',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    direction: 'inherit',
    imageSmoothingEnabled: true,
})

// Native transform scalar precision affects glyph snapping and waveform mip
// thresholds. The browser-font module probes its policy once, without rendering.
const canvasScalar = (value: number) =>
    Math.max(-3.4028234663852886e38, Math.min(3.4028234663852886e38, Math.fround(value)))

const contexts = new WeakMap<HTMLCanvasElement, WebGLDrawContext>()
const pixiMatrix = (m: Matrix) => new PixiMatrix(...m)
export class RenderSurface {
    private readonly context: WebGLDrawContext
    constructor(
        resources: RenderingResources,
        private w: number,
        private h: number,
        readonly stageCache = false,
    ) {
        this.context = new WebGLDrawContext(this, resources)
    }
    get width() {
        return this.w
    }
    set width(v: number) {
        this.w = Math.max(1, Math.floor(v))
        this.context.resetSurface()
    }
    get height() {
        return this.h
    }
    set height(v: number) {
        this.h = Math.max(1, Math.floor(v))
        this.context.resetSurface()
    }
    getContext() {
        return this.context
    }
    dispose() {
        this.context.dispose()
    }
}
type Layer = {
    depth: number
    target?: RenderTexture
    scene: Container
    origin: [number, number]
    opacity: number
    temporary: RenderTexture
    position: [number, number]
}
/** A bounded vector-only editor range. Its native render instructions survive pans. */
export type RetainedVectors = {
    readonly group: Container
    readonly matrix: Matrix
    readonly owner: object
    readonly graphics: number
    readonly reusable: boolean
    /** Fixed-size point artwork, in input order, under the outer render group. */
    readonly pointGroups?: readonly Container[]
    /** Exclusively owned, detached geometry that can be re-expanded at a new UPS. */
    readonly eventStrokes?: readonly { mesh: EventStrokeMesh; width: number }[]
    released: boolean
    releaseGeometry?: () => void
}

/** Prepared numeric annotation; its raster keys share the bounded browser-font cache. */
export type PreparedEditorLabel = {
    readonly text: string
    readonly color: string
    readonly font: string
    readonly baseline: number
    readonly inverseScale: number
    readonly align: CanvasTextAlign
    readonly alignToPixels: boolean
    linear?: number[]
    raster?: PreparedTextRaster
}

/** A visible time-scale ease glyph owns one pin in the renderer's geometry cache. */
export type PreparedEaseGlyph = {
    readonly owner: object
    readonly resource: PathGraphicsResource
    readonly matrix: Matrix
    readonly factor: number
    readonly release: () => void
    released: boolean
}

/** Immutable logical-pixel crop owned by one occupied note-atlas slot. */
export type NoteAtlasRegion = {
    readonly texture: Texture
    readonly surface: RenderSurface
    readonly owner: object
    readonly release: () => void
}
export type NoteBody = {
    readonly region: NoteAtlasRegion
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    /** Multiplies the context alpha at creation. */
    readonly alpha: number
}

/** Borrows frame-valid atlas crops; it never owns or pins their slots. */
export type RetainedNoteBodies = {
    readonly group: Container
    readonly matrix: Matrix
    readonly owner: object
    readonly regions: readonly NoteAtlasRegion[]
    readonly pages: readonly RenderSurface[]
    readonly sources: readonly TextureSource[]
    readonly count: number
    readonly alpha: number
    readonly smoothing: boolean
    released: boolean
}
export class WebGLDrawContext {
    private readonly resources: RenderingResources
    private target?: RenderTexture
    private width = -1
    private height = -1
    private disposed = false
    private state = initialState()
    private states: State[] = []
    private layers: Layer[] = []
    private path = new DrawPath()
    private pathMatrix = identity()
    private readonly transformPrecision = getCanvasTransformPrecision()
    private inheritedStyle?: CSSStyleDeclaration
    private inheritedDirection?: {
        connected: boolean
        dir: string
        lang: string
        canvasDir: string
        value: CanvasDirection
    }
    private scene = new Container()
    private origin: [number, number] = [0, 0]
    private clearPending = true
    // Complete offscreen editor sections keep geometry resident across pans.
    // This is an accounting ceiling, not an upfront allocation or total VRAM.
    private readonly paths = new PathGraphicsCache(128 * 1024 * 1024)
    private readonly paints = new PaintStyles()
    private readonly graphicPool: Graphics[] = []
    private readonly graphicsByContext = new Map<GraphicsContext, Graphics[]>()
    private pooledGraphics = 0
    private readonly pathMeshPool: Mesh<PathMeshGeometry>[] = []
    private readonly meshesByGeometry = new Map<PathMeshGeometry, Mesh<PathMeshGeometry>[]>()
    private pooledPathMeshes = 0
    private readonly spritePool: Sprite[] = []
    private readonly axisLinePool: AxisLineSprite[] = []
    private readonly containerPool: Container[] = []
    private readonly frames: Texture[] = []
    private usedFrames = 0
    private activeClip?: Clip[]
    private activeParent?: Container
    private readonly reads = new Set<TextureSource>()
    private readonly flushReader = () => {
        this.flush()
    }
    private readonly primitivePaths = new Map<string, DrawPath>()
    private readonly retained = new Map<Container, RetainedVectors>()
    private capturingVectorPoints = false
    private eventStrokeCapture?: {
        originTime: number
        complete: boolean
        pressure: boolean
        strokes: { mesh: EventStrokeMesh; width: number }[]
    }
    readonly eventStrokeStats = {
        created: 0,
        updated: 0,
        declined: 0,
        released: 0,
        bytes: 0,
        peakBytes: 0,
    }
    private readonly retainedNoteBodies = new Map<Container, RetainedNoteBodies>()
    private readonly waveforms = new WaveformMeshes()
    private readonly stageMeshes = new StageMeshes()
    constructor(
        readonly canvas: HTMLCanvasElement | RenderSurface,
        resources?: RenderingResources,
    ) {
        this.resources = resources ?? new RenderingResources(canvas as HTMLCanvasElement)
        this.resources.clients.add(this)
        this.ensure()
    }
    get ready() {
        return this.resources.ready
    }
    get isReady() {
        return this.resources.initialized
    }
    get resourceOwner() {
        return this.resources.resourceOwner
    }
    get maxSurfaceSize() {
        return this.resources.maxSurfaceSize
    }
    isContextLost() {
        return this.disposed || this.resources.lost
    }
    private ensure() {
        if (this.disposed || this.resources.lost || !this.resources.initialized) return false
        if (this.width !== this.canvas.width || this.height !== this.canvas.height) {
            this.resetSurface()
            this.width = this.canvas.width
            this.height = this.canvas.height
            if (this.canvas instanceof RenderSurface)
                this.target = this.canvas.stageCache
                    ? this.resources.stageTarget(this.width, this.height)
                    : this.resources.target(this.width, this.height)
            else this.resources.renderer.resize(this.width, this.height, 1)
        }
        return true
    }
    resetSurface() {
        for (const range of [...this.retained.values()]) {
            range.group.removeFromParent()
            this.releaseVectors(range)
        }
        for (const range of [...this.retainedNoteBodies.values()]) {
            range.group.removeFromParent()
            this.releaseNoteBodies(range)
        }
        // A context may be disposed or resized while a group is open. Release
        // every temporary target, retaining only the outer scene container.
        const scenes = new Set([this.scene, ...this.layers.map((layer) => layer.scene)])
        const outer = this.layers[0]?.scene ?? this.scene
        for (const scene of scenes) {
            this.recycle(scene)
            if (scene !== outer) scene.destroy()
        }
        this.scene = outer
        const targets = new Set([
            this.target,
            ...this.layers.flatMap((layer) => [layer.target, layer.temporary]),
        ])
        for (const target of targets)
            if (target) {
                this.resources.flushReaders(target.source)
                target.destroy(true)
            }
        this.target = undefined
        this.layers = []
        this.origin = [0, 0]
        this.width = this.height = -1
        this.state = initialState()
        this.states = []
        this.path = new DrawPath()
        this.pathMatrix = identity()
        this.clearPending = true
    }
    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.resetSurface()
        this.resources.clients.delete(this)
        for (const texture of this.frames) texture.destroy()
        for (const node of this.graphicPool) node.destroy({ context: false })
        for (const nodes of this.graphicsByContext.values())
            for (const node of nodes) node.destroy({ context: false })
        this.graphicsByContext.clear()
        this.graphicPool.length = 0
        for (const node of this.pathMeshPool) node.destroy()
        for (const nodes of this.meshesByGeometry.values()) for (const node of nodes) node.destroy()
        this.pathMeshPool.length = 0
        this.meshesByGeometry.clear()
        for (const node of this.spritePool) node.destroy()
        for (const node of this.axisLinePool) node.destroy()
        for (const node of this.containerPool) node.destroy()
        this.scene.destroy({ children: true })
        this.waveforms.destroy()
        this.stageMeshes.destroy()
        this.paths.destroy()
        this.paints.destroy()
        if (!(this.canvas instanceof RenderSurface)) {
            contexts.delete(this.canvas)
            this.resources.dispose()
        }
    }
    createSurface(width: number, height: number) {
        return new RenderSurface(this.resources, width, height)
    }
    /** Full-redraw stage pixels keep no MSAA or stencil storage between updates. */
    createStageSurface(width: number, height: number) {
        return new RenderSurface(this.resources, width, height, true)
    }
    /** Ordered, premultiplied stage slice triangles already include their paint opacity. */
    drawStageTriangles(vertices: readonly number[]) {
        if (!vertices.length || !this.mutate()) return
        this.parent().addChild(this.stageMeshes.draw(vertices, this.state.matrix))
    }
    private recycleNodes(container: Container) {
        for (const child of container.removeChildren()) {
            // A retained range is detached after presentation, but its children
            // and render-group instructions remain intact for the next pan.
            const range = this.retained.get(child)
            if (range) {
                if (!range.reusable) this.releaseVectors(range)
                continue
            }
            if (this.retainedNoteBodies.has(child)) continue
            if (child instanceof Graphics) {
                child.mask = null
                this.recycleGraphic(child)
            } else if (child instanceof Mesh) {
                if (child instanceof EventStrokeMesh) {
                    this.eventStrokeStats.bytes -= child.geometry.byteSize
                    this.eventStrokeStats.released++
                    child.geometry.destroy()
                    child.destroy()
                } else if (child instanceof StageMesh) this.stageMeshes.recycle(child)
                else if (child.geometry instanceof PathMeshGeometry)
                    this.recyclePathMesh(child as Mesh<PathMeshGeometry>)
                else this.waveforms.recycle(child)
            } else if (child instanceof AxisLineSprite) {
                if (this.axisLinePool.length < 10240) this.axisLinePool.push(child)
                else child.destroy()
            } else if (child instanceof Sprite) {
                child.texture = Texture.EMPTY
                this.spritePool.push(child)
            } else {
                this.recycleNodes(child)
                child.mask = null
                for (const effect of [...(child.effects ?? [])])
                    if (effect instanceof PixelRectClip) child.removeEffect(effect)
                this.containerPool.push(child)
            }
        }
    }
    private recycle(container: Container) {
        this.recycleNodes(container)
        this.activeClip = undefined
        this.activeParent = undefined
        this.usedFrames = 0
        for (const source of this.reads) this.resources.removeReader(source, this.flushReader)
        this.reads.clear()
    }
    captureVectors(
        draw: () => void,
        origin?: readonly [number, number],
    ): RetainedVectors | undefined {
        if (!this.ensure() || this.layers.length || this.state.clips.length) return
        const scene = this.scene,
            state = this.state,
            states = this.states,
            path = this.path,
            pathMatrix = this.pathMatrix
        const activeClip = this.activeClip,
            activeParent = this.activeParent
        const matrix: Matrix = [...state.matrix]
        if (origin) {
            // Capture around a stable nearby world point, independent of which
            // viewport first saw this range. Replaying changes only the group.
            const x = -(matrix[0] * origin[0] + matrix[2] * origin[1])
            const y = -(matrix[1] * origin[0] + matrix[3] * origin[1])
            if (Number.isFinite(x) && Number.isFinite(y)) {
                matrix[4] = x
                matrix[5] = y
            }
        }
        const group = new Container({ isRenderGroup: true })
        this.scene = group
        this.state = { ...state, matrix }
        this.states = []
        this.path = path.clone()
        this.pathMatrix = [...pathMatrix]
        this.activeClip = undefined
        this.activeParent = undefined
        let complete = false
        try {
            draw()
            complete = true
        } finally {
            this.scene = scene
            this.state = state
            this.states = states
            this.path = path
            this.pathMatrix = pathMatrix
            this.activeClip = activeClip
            this.activeParent = activeParent
            if (!complete) {
                this.recycleNodes(group)
                group.destroy()
            }
        }
        const contexts = new Set<PathGraphicsResource>()
        let graphics = 0
        const collect = (container: Container) => {
            for (const node of container.children) {
                if (node instanceof Graphics) {
                    contexts.add(node.context)
                    graphics++
                } else if (node instanceof EventStrokeMesh) {
                    graphics++
                } else if (node instanceof Mesh && node.geometry instanceof PathMeshGeometry) {
                    contexts.add(node.geometry)
                    graphics++
                } else if (node instanceof AxisLineSprite) {
                    graphics++
                } else collect(node)
            }
        }
        collect(group)
        const releaseGeometry = this.paths.pin(contexts)
        // A range that does not fit is still useful for this frame. Render its
        // already-built nodes once instead of repeating all drawing work.
        if (!releaseGeometry) group.isRenderGroup = false
        const range: RetainedVectors = {
            group,
            matrix,
            owner: this.resourceOwner,
            graphics,
            reusable: !!releaseGeometry,
            released: false,
            releaseGeometry,
        }
        this.retained.set(group, range)
        return range
    }
    get isCapturingEventStrokes() {
        return !!this.eventStrokeCapture
    }
    /** Only complete connection-only ranges are eligible for PPS-independent replay. */
    captureEventStrokeVectors(draw: () => void, originTime: number, ups: number) {
        if (this.eventStrokeCapture || !Number.isFinite(originTime * ups)) return
        const capture = {
            originTime,
            complete: true,
            pressure: false,
            strokes: [] as { mesh: EventStrokeMesh; width: number }[],
        }
        this.eventStrokeCapture = capture
        try {
            const range = this.captureVectors(draw, [0, originTime * ups])
            if (!range) return
            if (capture.pressure) {
                // This frame can use its fallback; release older detached sections
                // before the next admission instead of retrying forever at the cap.
                range.group.isRenderGroup = false
                Object.assign(range, { reusable: false })
            }
            if (capture.complete && capture.strokes.length)
                Object.assign(range, { eventStrokes: capture.strokes })
            return range
        } finally {
            this.eventStrokeCapture = undefined
        }
    }
    /** Solid event centerlines only; a declined draw is performed by the caller. */
    strokeEventPath(prepared: PreparedEventStroke | undefined, ups: number) {
        const capture = this.eventStrokeCapture
        if (!capture) return false
        const s = this.state
        const [a, b, c, d, e] = s.matrix
        const decline = () => {
            capture.complete = false
            this.eventStrokeStats.declined++
            return false
        }
        if (
            !prepared ||
            !this.mutate() ||
            b ||
            c ||
            !a ||
            Math.abs(a) !== Math.abs(d) ||
            !s.matrix.every(Number.isFinite) ||
            s.globalCompositeOperation !== 'source-over' ||
            typeof s.strokeStyle !== 'string' ||
            s.lineCap !== 'butt' ||
            s.lineJoin !== 'miter' ||
            s.miterLimit !== 10 ||
            s.dash.length ||
            this.layers.length ||
            s.clips.length
        )
            return decline()
        const width = s.lineWidth * Math.abs(a)
        const x = prepared.originX * a + e
        const y = (prepared.originTime - capture.originTime) * d * ups
        if (!Number.isFinite(x) || !Number.isFinite(y)) return decline()
        const geometry = EventStrokeGeometry.create(prepared, a, d * ups, width)
        if (!geometry) return decline()
        // Owned positions, UVs, indices, centerline and staging arrays. Pixi's
        // batch copies/driver overhead are additional to this allocation bound.
        if (this.eventStrokeStats.bytes + geometry.byteSize > 32 * 1024 * 1024) {
            geometry.destroy()
            capture.pressure = true
            return decline()
        }
        const mesh = new EventStrokeMesh({ geometry, texture: Texture.WHITE })
        const [r, g, blue, alpha] = parseColor(s.strokeStyle)
        mesh.tint =
            (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(blue * 255)
        mesh.alpha = s.globalAlpha * alpha
        mesh.position.set(x, y)
        this.parent().addChild(mesh)
        capture.strokes.push({ mesh, width })
        this.eventStrokeStats.bytes += geometry.byteSize
        this.eventStrokeStats.peakBytes = Math.max(
            this.eventStrokeStats.peakBytes,
            this.eventStrokeStats.bytes,
        )
        this.eventStrokeStats.created++
        return true
    }
    updateEventStrokeVectors(range: RetainedVectors, originTime: number, ups: number) {
        if (
            !this.ensure() ||
            range.released ||
            range.owner !== this.resourceOwner ||
            this.retained.get(range.group) !== range ||
            range.group.parent ||
            !range.eventStrokes?.length ||
            this.layers.length ||
            this.state.clips.length
        )
            return false
        const matrix = this.state.matrix
        const origin = -matrix[3] * originTime * ups
        if (
            !matrix.every(Number.isFinite) ||
            !Number.isFinite(origin) ||
            range.matrix.slice(0, 4).some((value, index) => value !== matrix[index])
        )
            return false
        // Validate every stroke before publishing any positions. A refusal keeps
        // the previous range intact until the domain releases and recaptures it.
        for (const { mesh, width } of range.eventStrokes) {
            if (
                mesh.parent !== range.group ||
                mesh.destroyed ||
                !Number.isFinite(
                    (mesh.geometry.prepared.originTime - originTime) * matrix[3] * ups,
                ) ||
                !mesh.geometry.stage(matrix[0], matrix[3] * ups, width)
            )
                return false
        }
        for (const { mesh } of range.eventStrokes) {
            mesh.geometry.commit()
            mesh.position.y = (mesh.geometry.prepared.originTime - originTime) * matrix[3] * ups
            this.eventStrokeStats.updated++
        }
        range.matrix[5] = origin
        return true
    }
    /** Capture local-Y point artwork without stretching its strokes or markers. */
    capturePointVectors(
        points: readonly { y: number; draw: () => void }[],
        originY: number,
    ): RetainedVectors | undefined {
        if (!this.ensure() || this.capturingVectorPoints || !points.length) return
        const matrix = this.state.matrix
        const origin = -matrix[3] * originY
        if (
            matrix[1] !== 0 ||
            matrix[2] !== 0 ||
            !matrix.every(Number.isFinite) ||
            !Number.isFinite(origin) ||
            points.some(({ y }) => !Number.isFinite(y) || !Number.isFinite(matrix[3] * y + origin))
        )
            return
        const pointGroups: Container[] = []
        this.capturingVectorPoints = true
        try {
            const range = this.captureVectors(() => {
                const scene = this.scene
                for (const point of points) {
                    const group = this.containerPool.pop() ?? new Container()
                    group.position.set(0, matrix[3] * point.y + origin)
                    group.scale.set(1, 1)
                    group.alpha = 1
                    group.visible = true
                    scene.addChild(group)
                    pointGroups.push(group)
                    const state = this.state
                    const activeClip = this.activeClip
                    const activeParent = this.activeParent
                    this.scene = group
                    this.state = { ...state, matrix: [matrix[0], 0, 0, matrix[3], 0, 0] }
                    this.activeClip = undefined
                    this.activeParent = undefined
                    try {
                        point.draw()
                    } finally {
                        this.scene = scene
                        this.state = state
                        this.activeClip = activeClip
                        this.activeParent = activeParent
                    }
                }
            }, [0, originY])
            if (!range) return
            // Zero-paint points still own a Container and anchor metadata. Charge
            // at least one primitive per point under the existing section bound.
            return Object.assign(range, {
                pointGroups,
                graphics: Math.max(range.graphics, points.length),
            })
        } finally {
            this.capturingVectorPoints = false
        }
    }
    updateVectorPointPositions(range: RetainedVectors, ys: ArrayLike<number>, originY: number) {
        if (
            !this.ensure() ||
            range.released ||
            range.owner !== this.resourceOwner ||
            this.retained.get(range.group) !== range ||
            range.group.parent ||
            range.pointGroups?.length !== ys.length ||
            range.group.children.length !== range.pointGroups.length ||
            range.pointGroups.some((group) => group.parent !== range.group) ||
            this.layers.length ||
            this.state.clips.length
        )
            return false
        const matrix = this.state.matrix
        const origin = -matrix[3] * originY
        if (
            !matrix.every(Number.isFinite) ||
            !Number.isFinite(origin) ||
            range.matrix.slice(0, 4).some((value, index) => value !== matrix[index])
        )
            return false
        for (let index = 0; index < range.pointGroups.length; index++) {
            const y = ys[index]
            if (y === undefined || !Number.isFinite(y) || !Number.isFinite(matrix[3] * y + origin))
                return false
        }
        for (const [index, group] of range.pointGroups.entries()) {
            const y = ys[index]
            if (y !== undefined) group.position.y = matrix[3] * y + origin
        }
        range.matrix[5] = origin
        return true
    }
    drawVectors(range: RetainedVectors) {
        if (!this.mutate() || range.released || range.owner !== this.resourceOwner) return false
        const matrix = this.state.matrix
        if (range.matrix.slice(0, 4).some((value, index) => value !== matrix[index])) return false
        range.group.position.set(matrix[4] - range.matrix[4], matrix[5] - range.matrix[5])
        this.parent().addChild(range.group)
        return true
    }
    releaseVectors(range: RetainedVectors) {
        if (range.released) return
        // Eviction occurs after frame flush in the domain cache. A direct caller
        // may release a queued range, so preserve that queued draw first.
        if (range.group.parent && !this.disposed && !this.resources.lost) this.flush()
        range.group.removeFromParent()
        this.retained.delete(range.group)
        this.recycleNodes(range.group)
        range.group.destroy()
        range.releaseGeometry?.()
        range.released = true
    }
    flush() {
        if (!this.ensure() || !this.resources.initialized) return
        if (!this.clearPending && !this.scene.children.length) return
        this.scene.position.set(-this.origin[0], -this.origin[1])
        if (!this.resources.render(this.scene, this.target, this.clearPending)) return
        this.clearPending = false
        this.recycle(this.scene)
        this.paths.endFrame()
        this.paths.beginFrame()
    }
    private mutate() {
        if (!this.ensure()) return false
        if (this.target) this.resources.flushReaders(this.target.source)
        return true
    }
    private recycleGraphic(graphic: Graphics) {
        // A shared context can have thousands of marker instances. Reusing a
        // node with that same context avoids quadratic EventEmitter removals.
        if (this.pooledGraphics >= 10240) {
            graphic.destroy({ context: false })
            return
        }
        const context = graphic.context
        if (context.destroyed) this.graphicPool.push(graphic)
        else {
            let nodes = this.graphicsByContext.get(context)
            if (!nodes) {
                this.graphicsByContext.set(context, (nodes = []))
                const bucket = nodes
                context.once('destroy', () => {
                    this.graphicsByContext.delete(context)
                    if (!this.disposed) this.graphicPool.push(...bucket)
                    bucket.length = 0
                })
            }
            nodes.push(graphic)
        }
        this.pooledGraphics++
    }
    private graphic(context: GraphicsContext, matrix: Matrix, alpha = this.state.globalAlpha) {
        const reused = this.graphicsByContext.get(context)?.pop() ?? this.graphicPool.pop()
        if (reused) this.pooledGraphics--
        const graphic = reused ?? new Graphics({ context })
        graphic.context = context
        graphic.setFromMatrix(pixiMatrix(matrix))
        graphic.alpha = alpha
        graphic.blendMode = 'normal'
        graphic.renderable = true
        return graphic
    }
    private recyclePathMesh(mesh: Mesh<PathMeshGeometry>) {
        mesh.mask = null
        if (this.pooledPathMeshes >= 10240) {
            mesh.destroy()
            return
        }
        const geometry = mesh.geometry
        if (geometry.destroyed) this.pathMeshPool.push(mesh)
        else {
            let nodes = this.meshesByGeometry.get(geometry)
            if (!nodes) {
                this.meshesByGeometry.set(geometry, (nodes = []))
                const bucket = nodes
                geometry.once('destroy', () => {
                    this.meshesByGeometry.delete(geometry)
                    if (!this.disposed) this.pathMeshPool.push(...bucket)
                    bucket.length = 0
                })
            }
            nodes.push(mesh)
        }
        this.pooledPathMeshes++
    }
    private pathNode(
        resource: PathGraphicsResource,
        matrix: Matrix,
        alpha = this.state.globalAlpha,
    ) {
        if (!(resource instanceof PathMeshGeometry)) return this.graphic(resource, matrix, alpha)
        const reused = this.meshesByGeometry.get(resource)?.pop() ?? this.pathMeshPool.pop()
        if (reused) this.pooledPathMeshes--
        const mesh = reused ?? new Mesh({ geometry: resource, texture: resource.texture })
        mesh.geometry = resource
        mesh.texture = resource.texture
        mesh.tint = resource.tint
        mesh.alpha = alpha * resource.styleAlpha
        mesh.blendMode = 'normal'
        mesh.renderable = true
        // Float32 geometry stays near its local origin. Apply its large world
        // offset in the double-precision node matrix before Pixi packs vertices.
        mesh.setFromMatrix(
            pixiMatrix(multiply(matrix, [1, 0, 0, 1, resource.originX, resource.originY])),
        )
        return mesh
    }
    private parent() {
        if (!this.state.clips.length) {
            this.activeClip = undefined
            this.activeParent = undefined
            return this.scene
        }
        let parent = this.activeClip === this.state.clips ? this.activeParent : undefined
        if (parent) return parent
        parent = this.scene
        for (const clip of this.state.clips) {
            const group = this.containerPool.pop() ?? new Container()
            group.position.set(0, 0)
            group.scale.set(1, 1)
            group.alpha = 1
            group.visible = true
            if (clip.pixels) group.addEffect(new PixelRectClip(clip.pixels))
            else {
                const factor = resolutionScale(clip.matrix)
                const context = this.paths.get(
                    clip.path,
                    { color: 0xffffff },
                    false,
                    clip.rule,
                    'mask',
                    undefined,
                    factor,
                )
                if (this.paths.isEmpty(context)) group.visible = false
                else {
                    const mask = this.pathNode(
                        context,
                        multiply(clip.matrix, [1 / factor, 0, 0, 1 / factor, 0, 0]),
                        1,
                    )
                    group.addChild(mask)
                    group.mask = mask
                }
            }
            parent.addChild(group)
            parent = group
        }
        this.activeClip = this.state.clips
        this.activeParent = parent
        return parent
    }
    private drawShape(shape: DrawPath, stroke: boolean, rule: CanvasFillRule = 'nonzero') {
        if (!this.mutate()) return
        const s = this.state
        const paint = stroke
            ? this.paints.stroke(s.strokeStyle, s.lineWidth, s.lineCap, s.lineJoin, s.miterLimit)
            : this.paints.fill(s.fillStyle)
        const factor = resolutionScale(s.matrix)
        const context = this.paths.get(
            shape,
            paint.style,
            stroke,
            rule,
            paint.key,
            { dash: s.dash, dashOffset: s.lineDashOffset },
            factor,
        )
        if (this.paths.isEmpty(context)) return
        const graphic = this.pathNode(
            context,
            multiply(s.matrix, [1 / factor, 0, 0, 1 / factor, 0, 0]),
        )
        if (s.globalCompositeOperation === 'destination-out') graphic.blendMode = 'erase'
        this.parent().addChild(graphic)
    }
    private primitive(key: string, build: (path: DrawPath) => void) {
        let path = this.primitivePaths.get(key)
        if (!path) {
            build((path = new DrawPath()))
            this.primitivePaths.set(key, path)
        }
        if (this.primitivePaths.size > 8192) {
            const oldest = this.primitivePaths.keys().next().value
            if (oldest !== undefined) this.primitivePaths.delete(oldest)
        }
        return path
    }
    save() {
        if (this.ensure()) this.states.push({ ...this.state })
    }
    restore() {
        const state = this.states.pop()
        if (!state) return
        const layer = this.layers.at(-1)
        if (layer?.depth === this.states.length + 1) {
            this.flush()
            this.layers.pop()
            this.scene.destroy({ children: true })
            this.scene = layer.scene
            this.target = layer.target
            this.origin = layer.origin
            this.state = state
            this.clearPending = false
            const matrix = state.matrix,
                alpha = state.globalAlpha
            state.matrix = identity()
            state.globalAlpha = layer.opacity
            this.imageQuad(layer.temporary, [
                0,
                0,
                layer.temporary.width,
                layer.temporary.height,
                ...layer.position,
                layer.temporary.width,
                layer.temporary.height,
            ])
            this.flush()
            layer.temporary.destroy(true)
            state.matrix = matrix
            state.globalAlpha = alpha
        } else this.state = state
    }
    saveLayer(opacity: number, x: number, y: number, w: number, h: number) {
        if (!this.ensure()) return
        this.save()
        this.flush()
        const m = this.state.matrix
        const corners = [
            [x, y],
            [x + w, y],
            [x, y + h],
            [x + w, y + h],
        ] as const
        const xs = corners.map(([px, py]) => m[0] * px + m[2] * py + m[4])
        const ys = corners.map(([px, py]) => m[1] * px + m[3] * py + m[5])
        const left = Math.max(0, Math.floor(Math.min(...xs))),
            top = Math.max(0, Math.floor(Math.min(...ys)))
        const right = Math.min(this.width, Math.ceil(Math.max(...xs))),
            bottom = Math.min(this.height, Math.ceil(Math.max(...ys)))
        const temporary = this.resources.target(
            Math.max(1, right - left),
            Math.max(1, bottom - top),
        )
        temporary.label = `${left},${top}`
        this.layers.push({
            depth: this.states.length,
            target: this.target,
            scene: this.scene,
            origin: this.origin,
            opacity,
            temporary,
            position: [left, top],
        })
        this.scene = new Container()
        this.target = temporary
        this.origin = [left, top]
        this.clearPending = true
        this.state = { ...this.state, clips: [] }
    }
    getTransform() {
        this.ensure()
        return new DOMMatrix(this.state.matrix)
    }

    private transformScalar(value: number) {
        return this.transformPrecision.roundComposition ? Math.fround(value) : canvasScalar(value)
    }

    private composedTransform(matrix: Matrix, next: Matrix): Matrix {
        if (!this.transformPrecision.roundComposition) {
            return multiply(matrix, next)
        }
        const [a, b, c, d, e, f] = matrix
        const round = Math.fround
        return [
            round(round(a * next[0]) + round(c * next[1])),
            round(round(b * next[0]) + round(d * next[1])),
            round(round(a * next[2]) + round(c * next[3])),
            round(round(b * next[2]) + round(d * next[3])),
            round(round(round(a * next[4]) + round(c * next[5])) + e),
            round(round(round(b * next[4]) + round(d * next[5])) + f),
        ]
    }

    private composeTransform(next: Matrix) {
        this.state.matrix = this.composedTransform(this.state.matrix, next)
    }

    setTransform(transform?: DOMMatrix2DInit): void
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
    setTransform(
        a: number | DOMMatrix2DInit = {},
        b?: number,
        c?: number,
        d?: number,
        e?: number,
        f?: number,
    ) {
        this.ensure()
        let matrix =
            typeof a === 'number'
                ? ([a, b ?? 0, c ?? 0, d ?? 1, e ?? 0, f ?? 0] as Matrix)
                : matrixOf(a)
        if (!matrix.every(Number.isFinite)) return
        if (this.transformPrecision.roundMatrixArguments)
            matrix = matrix.map((value) => this.transformScalar(value)) as Matrix
        if (matrix.every(Number.isFinite)) this.state.matrix = matrix
    }
    resetTransform() {
        this.setTransform(1, 0, 0, 1, 0, 0)
    }
    transform(a: number, b: number, c: number, d: number, e: number, f: number) {
        this.ensure()
        let next: Matrix = [a, b, c, d, e, f]
        if (!next.every(Number.isFinite)) return
        if (this.transformPrecision.roundMatrixArguments)
            next = next.map((value) => this.transformScalar(value)) as Matrix
        if (next.every(Number.isFinite)) this.composeTransform(next)
    }
    translate(x: number, y: number) {
        this.transform(1, 0, 0, 1, x, y)
    }
    scale(x: number, y: number) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            this.ensure()
            return
        }
        if (this.transformPrecision.roundScaleArguments) {
            x = this.transformScalar(x)
            y = this.transformScalar(y)
        }
        this.transform(x, 0, 0, y, 0, 0)
    }
    rotate(angle: number) {
        this.ensure()
        if (!Number.isFinite(angle)) return
        if (this.transformPrecision.roundComposition) angle = Math.fround(angle)
        if (!Number.isFinite(angle)) return
        let cosine = Math.cos(angle)
        let sine = Math.sin(angle)
        if (this.transformPrecision.roundComposition) {
            cosine = Math.fround(cosine)
            sine = Math.fround(sine)
        }
        this.composeTransform([cosine, sine, -sine, cosine, 0, 0])
    }

    beginPath() {
        this.ensure()
        this.path.dispose()
        this.path = new DrawPath()
        this.pathMatrix = [...this.state.matrix]
    }

    private currentPath() {
        this.ensure()
        if (!equalMatrix(this.pathMatrix, this.state.matrix)) {
            const inverted = inverse(this.state.matrix)
            if (!inverted) return
            this.path.transform(matrixObject(multiply(inverted, this.pathMatrix)))
            this.pathMatrix = [...this.state.matrix]
        }
        return this.path
    }

    closePath() {
        this.currentPath()?.closePath()
    }
    moveTo(x: number, y: number) {
        this.currentPath()?.moveTo(x, y)
    }
    lineTo(x: number, y: number) {
        this.currentPath()?.lineTo(x, y)
    }
    quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
        this.currentPath()?.quadraticCurveTo(cx, cy, x, y)
    }
    bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
        this.currentPath()?.bezierCurveTo(c1x, c1y, c2x, c2y, x, y)
    }
    rect(x: number, y: number, width: number, height: number) {
        this.currentPath()?.rect(x, y, width, height)
    }
    arc(
        x: number,
        y: number,
        radius: number,
        start: number,
        end: number,
        counterclockwise = false,
    ) {
        this.currentPath()?.arc(x, y, radius, start, end, counterclockwise)
    }
    arcTo(x1: number, y1: number, x2: number, y2: number, radius: number) {
        this.currentPath()?.arcTo(x1, y1, x2, y2, radius)
    }
    ellipse(
        x: number,
        y: number,
        rx: number,
        ry: number,
        rotation: number,
        start: number,
        end: number,
        counterclockwise = false,
    ) {
        this.currentPath()?.ellipse(x, y, rx, ry, rotation, start, end, counterclockwise)
    }
    roundRect(
        x: number,
        y: number,
        width: number,
        height: number,
        radii?: number | DOMPointInit | (number | DOMPointInit)[],
    ) {
        this.currentPath()?.roundRect(x, y, width, height, radii)
    }

    fill(path?: DrawPath | CanvasFillRule, rule: CanvasFillRule = 'nonzero') {
        if (!this.ensure()) return
        const shape = path instanceof DrawPath ? path : this.currentPath()
        if (shape) this.drawShape(shape, false, typeof path === 'string' ? path : rule)
    }
    /** Connector body and gradient use one nearby, reference-time coordinate space. */
    fillConnectorBody(path: DrawPath, yScale: number, originY: number) {
        if (!this.ensure()) return false
        const state = this.state
        const matrix = multiply(state.matrix, [1, 0, 0, yScale, 0, originY])
        // The editor projects lanes and time independently. Outside this scope
        // keep the ordinary fill route, including singular/extreme transforms.
        if (
            ![yScale, originY, ...matrix].every(Number.isFinite) ||
            !matrix[0] ||
            !matrix[3] ||
            matrix[1] !== 0 ||
            matrix[2] !== 0 ||
            Math.max(Math.abs(matrix[0]), Math.abs(matrix[3])) > 65536
        )
            return false
        if (!this.mutate()) return false
        const paint = this.paints.fill(state.fillStyle)
        // This power-of-two upper bound includes the effective physical Y
        // stretch. New arbitrary PPS values reuse the same quality bucket;
        // crossing a bucket compiles finer curves under the existing byte cap.
        const factor = resolutionScale(matrix)
        const resource = this.paths.get(
            path,
            paint.style,
            false,
            'nonzero',
            paint.key,
            undefined,
            factor,
        )
        if (this.paths.isEmpty(resource)) return true
        // Nodes are per submission. Never mutate a previously queued transform
        // or the shared geometry/paint when another PPS is drawn in this frame.
        const node = this.pathNode(resource, multiply(matrix, [1 / factor, 0, 0, 1 / factor, 0, 0]))
        if (state.globalCompositeOperation === 'destination-out') node.blendMode = 'erase'
        this.parent().addChild(node)
        return true
    }
    stroke(path?: DrawPath) {
        if (!this.ensure()) return
        const shape = path ?? this.currentPath()
        if (shape) this.drawShape(shape, true)
    }
    /** Fake-connector cross: union the two certified stroke boundaries when possible. */
    strokeFakeMarker(path: DrawPath) {
        if (!this.mutate()) return
        const state = this.state
        const paint = this.paints.stroke(
            state.strokeStyle,
            state.lineWidth,
            state.lineCap,
            state.lineJoin,
            state.miterLimit,
        )
        const factor = resolutionScale(state.matrix)
        const resource = this.paths.getFakeMarkerStroke(
            path,
            paint.style,
            paint.key,
            { dash: state.dash, dashOffset: state.lineDashOffset },
            factor,
        )
        if (this.paths.isEmpty(resource)) return
        const node = this.pathNode(
            resource,
            multiply(state.matrix, [1 / factor, 0, 0, 1 / factor, 0, 0]),
        )
        if (state.globalCompositeOperation === 'destination-out') node.blendMode = 'erase'
        this.parent().addChild(node)
    }
    private drawCircle(x: number, y: number, radius: number, stroke: boolean) {
        if (![x, y, radius].every(Number.isFinite)) return
        if (radius < 0) throw new DOMException('Radii must be non-negative', 'IndexSizeError')
        if (!radius || !this.mutate()) return
        const state = this.state
        // Gradient coordinates belong to the original user space. Solid event
        // markers can share one native geometry regardless of chart position.
        const style = stroke ? state.strokeStyle : state.fillStyle
        if (style instanceof DrawGradient) {
            this.drawShape(
                this.primitive(`c:${x}:${y}:${radius}`, (path) => {
                    path.arc(x, y, radius, 0, Math.PI * 2)
                }),
                stroke,
            )
            return
        }
        // Share canonical circle geometry; the effective node scale determines
        // its native tessellation bucket, independently of its chart position.
        const scale = radius / 16
        const matrix = multiply(state.matrix, [scale, 0, 0, scale, x, y])
        const factor = resolutionScale(matrix)
        const path = this.primitive('circle:16', (path) => {
            path.arc(0, 0, 16, 0, Math.PI * 2)
        })
        const paint = stroke
            ? this.paints.stroke(
                  style,
                  state.lineWidth / scale,
                  state.lineCap,
                  state.lineJoin,
                  state.miterLimit,
              )
            : this.paints.fill(style)
        const context = this.paths.get(
            path,
            paint.style,
            stroke,
            'nonzero',
            paint.key,
            {
                dash: stroke ? state.dash.map((value) => value / scale) : [],
                dashOffset: stroke ? state.lineDashOffset / scale : 0,
            },
            factor,
        )
        if (this.paths.isEmpty(context)) return
        // Compose directly: this internal normalization must not round or
        // mutate the application's captured Canvas-compatible transform.
        const graphic = this.pathNode(
            context,
            multiply(matrix, [1 / factor, 0, 0, 1 / factor, 0, 0]),
        )
        if (state.globalCompositeOperation === 'destination-out') graphic.blendMode = 'erase'
        this.parent().addChild(graphic)
    }
    fillCircle(x: number, y: number, r: number) {
        this.drawCircle(x, y, r, false)
    }
    strokeCircle(x: number, y: number, r: number) {
        this.drawCircle(x, y, r, true)
    }
    strokeLine(x: number, y: number, x1: number, y1: number) {
        if (!this.mutate()) return
        const s = this.state
        if (
            s.lineCap === 'butt' &&
            !s.dash.length &&
            typeof s.strokeStyle === 'string' &&
            s.globalCompositeOperation === 'source-over' &&
            !s.matrix[1] &&
            !s.matrix[2] &&
            (x === x1 || y === y1)
        ) {
            const [a, , , d, e, f] = s.matrix
            const line = this.axisLinePool.pop() ?? new AxisLineSprite()
            const width = s.lineWidth * Math.abs(x === x1 ? a : d)
            if (line.setLine(a * x + e, d * y + f, a * x1 + e, d * y1 + f, width)) {
                const [r, g, b, alpha] = parseColor(s.strokeStyle)
                line.tint =
                    (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255)
                line.alpha = s.globalAlpha * alpha
                line.blendMode = 'normal'
                line.renderable = true
                this.parent().addChild(line)
                return
            }
            this.axisLinePool.push(line)
        }
        this.drawShape(
            this.primitive(`l:${x}:${y}:${x1}:${y1}`, (p) => {
                p.moveTo(x, y)
                p.lineTo(x1, y1)
            }),
            true,
        )
    }
    /** Shade the ribbon through an opaque stroke mask, unioning coverage on the GPU. */
    strokeClipped(path: DrawPath, body: DrawPath) {
        if (!this.mutate()) return
        const state = this.state
        if (state.globalCompositeOperation === 'source-over') {
            const factor = resolutionScale(state.matrix)
            const resource = this.paths.getStrokeMask(
                path,
                {
                    width: state.lineWidth,
                    cap: state.lineCap,
                    join: state.lineJoin,
                    miterLimit: state.miterLimit,
                },
                { dash: state.dash, dashOffset: state.lineDashOffset },
                factor,
            )
            if (resource) {
                if (this.paths.isEmpty(resource)) return
                const paint = this.paints.fill(state.strokeStyle)
                // Keep the normal fill selector: compound ribbon contours must
                // paint once even where they overlap inside the stroke mask.
                const fill = this.paths.get(
                    body,
                    paint.style,
                    false,
                    'nonzero',
                    paint.key,
                    undefined,
                    factor,
                )
                if (this.paths.isEmpty(fill)) return
                const matrix = multiply(state.matrix, [1 / factor, 0, 0, 1 / factor, 0, 0])
                const group = this.containerPool.pop() ?? new Container()
                group.position.set(0, 0)
                group.scale.set(1, 1)
                group.alpha = 1
                group.visible = true
                const mask = this.graphic(resource, matrix, 1)
                const content = this.pathNode(fill, matrix)
                group.addChild(mask, content)
                // Pixi's EQUAL + INCR stencil pass accepts each covered sample
                // once, so overlapping native stroke triangles cannot add alpha.
                group.mask = mask
                this.parent().addChild(group)
                return
            }
        }
        // Preserve the established clip/stroke route for unsupported geometry
        // and erase composition, including inherited clips and stroke union.
        this.save()
        this.clip(body)
        this.stroke(path)
        this.restore()
    }
    clip(path?: DrawPath | CanvasFillRule, rule: CanvasFillRule = 'nonzero') {
        const shape = path instanceof DrawPath ? path : this.currentPath()
        if (!shape) return
        const matrix = this.state.matrix
        const command = shape.commands.length === 1 ? shape.commands[0] : undefined
        let pixels: PixelBounds | undefined
        // Atlas artwork has integer device-space clipping boundaries. Avoid a
        // full-size multisampled stencil attachment for these simple clips.
        if (
            this.canvas instanceof RenderSurface &&
            command?.[0] === 'rect' &&
            !matrix[1] &&
            !matrix[2]
        ) {
            const [, x, y, width, height] = command
            const x0 = matrix[0] * x + matrix[4],
                x1 = matrix[0] * (x + width) + matrix[4]
            const y0 = matrix[3] * y + matrix[5],
                y1 = matrix[3] * (y + height) + matrix[5]
            if ([x0, x1, y0, y1].every(Number.isInteger))
                pixels = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
        }
        this.state.clips = [
            ...this.state.clips,
            {
                path: shape.clone(),
                matrix: [...matrix],
                rule: typeof path === 'string' ? path : rule,
                pixels,
            },
        ]
    }
    fillRect(x: number, y: number, w: number, h: number) {
        this.drawShape(
            this.primitive(`r:${x}:${y}:${w}:${h}`, (p) => {
                p.rect(x, y, w, h)
            }),
            false,
        )
    }
    strokeRect(x: number, y: number, w: number, h: number) {
        this.drawShape(
            this.primitive(`r:${x}:${y}:${w}:${h}`, (p) => {
                p.rect(x, y, w, h)
            }),
            true,
        )
    }
    clearRect(x: number, y: number, w: number, h: number) {
        if (
            !this.state.clips.length &&
            equalMatrix(this.state.matrix, identity()) &&
            x <= 0 &&
            y <= 0 &&
            x + w >= this.canvas.width &&
            y + h >= this.canvas.height
        ) {
            this.clear()
            return
        }
        this.save()
        this.state.globalCompositeOperation = 'destination-out'
        this.state.globalAlpha = 1
        this.state.fillStyle = '#fff'
        this.fillRect(x, y, w, h)
        this.restore()
    }
    clear() {
        if (!this.mutate()) return
        if (this.state.clips.length) {
            this.save()
            this.resetTransform()
            this.clearRect(0, 0, this.width, this.height)
            this.restore()
            return
        }
        this.recycle(this.scene)
        this.clearPending = true
        this.paths.endFrame()
        this.paths.beginFrame()
    }
    createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
        return new DrawGradient([x0, y0], [x1, y1])
    }
    setLineDash(dash: number[]) {
        if (!this.ensure()) return
        if (dash.some((v) => !Number.isFinite(v) || v < 0)) return
        this.state.dash = dash.some((v) => v > 0)
            ? dash.length % 2
                ? [...dash, ...dash]
                : [...dash]
            : []
    }
    getLineDash() {
        this.ensure()
        return [...this.state.dash]
    }
    drawImage(source: ImageSource | RenderSurface, ...args: number[]) {
        if (!this.ensure()) return
        let image: Texture
        if (source instanceof RenderSurface) {
            const context = source.getContext()
            if (context.resources !== this.resources) throw new Error('Cross-context render target')
            context.flush()
            if (!context.target) return
            image = context.target
        } else image = this.resources.image(source)
        this.imageQuad(image, args)
    }
    createNoteAtlasRegion(x: number, y: number, width: number, height: number) {
        if (!this.ensure() || !(this.canvas instanceof RenderSurface) || !this.target) return
        if (
            ![x, y, width, height].every(Number.isFinite) ||
            x < 0 ||
            y < 0 ||
            width <= 0 ||
            height <= 0 ||
            x + width > this.target.width ||
            y + height > this.target.height
        )
            return
        const texture = new Texture({
            source: this.target.source,
            frame: new Rectangle(x, y, width, height),
            orig: new Rectangle(0, 0, width, height),
        })
        const source = texture.source
        const release = () => {
            if (texture.destroyed) return
            source.off('destroy', release)
            // A normal release must detach queued Sprites first. Source disposal
            // already flushed them, or disabled drawing for context loss.
            if (!source.destroyed) this.resources.flushReaders(source)
            texture.destroy(false)
        }
        source.once('destroy', release)
        return {
            texture,
            surface: this.canvas,
            owner: this.resourceOwner,
            release,
        } satisfies NoteAtlasRegion
    }
    private validNoteRegion(region: NoteAtlasRegion) {
        return (
            region.owner === this.resourceOwner &&
            !region.texture.destroyed &&
            !region.texture.source.destroyed &&
            !region.surface.getContext().isContextLost() &&
            region.surface.getContext() !== this
        )
    }
    createNoteBodies(bodies: readonly NoteBody[], originY: number): RetainedNoteBodies | undefined {
        if (!this.ensure() || !bodies.length || this.layers.length || this.state.clips.length)
            return
        const { matrix, globalAlpha, imageSmoothingEnabled } = this.state
        const origin = -matrix[3] * originY
        if (
            this.state.globalCompositeOperation !== 'source-over' ||
            matrix[1] !== 0 ||
            matrix[2] !== 0 ||
            !matrix.every(Number.isFinite) ||
            !Number.isFinite(origin)
        )
            return
        // Validate before borrowing pool nodes; a declined run queues no paint.
        for (const body of bodies) {
            const { region, x, y, width, height, alpha } = body
            if (
                !this.validNoteRegion(region) ||
                ![x, y, width, height, alpha].every(Number.isFinite) ||
                width <= 0 ||
                height <= 0 ||
                alpha < 0 ||
                alpha > 1 ||
                ![
                    matrix[0] * x,
                    matrix[3] * y + origin,
                    matrix[0] * (width / region.texture.width),
                    matrix[3] * (height / region.texture.height),
                ].every(Number.isFinite)
            )
                return
        }
        const group = new Container({ isRenderGroup: true })
        const regions = [...new Set(bodies.map((body) => body.region))]
        const range: RetainedNoteBodies = {
            group,
            matrix: [matrix[0], 0, 0, matrix[3], 0, origin],
            owner: this.resourceOwner,
            regions,
            pages: [...new Set(regions.map((region) => region.surface))],
            sources: [...new Set(regions.map((region) => region.texture.source))],
            count: bodies.length,
            alpha: globalAlpha,
            smoothing: imageSmoothingEnabled,
            released: false,
        }
        try {
            for (const { region, x, y, width, height, alpha } of bodies) {
                const sprite = this.spritePool.pop() ?? new Sprite()
                group.addChild(sprite)
                sprite.texture = region.texture
                sprite.alpha = globalAlpha * alpha
                sprite.blendMode = 'normal'
                sprite.rotation = 0
                sprite.skew.set(0, 0)
                sprite.scale.set(
                    matrix[0] * (width / region.texture.width),
                    matrix[3] * (height / region.texture.height),
                )
                sprite.position.set(matrix[0] * x, matrix[3] * y + origin)
            }
            this.retainedNoteBodies.set(group, range)
            return range
        } finally {
            if (!this.retainedNoteBodies.has(group)) {
                this.recycleNodes(group)
                group.destroy()
            }
        }
    }
    /** Reposition fixed-size note artwork before the group is queued for drawing. */
    updateNoteBodyPositions(
        range: RetainedNoteBodies,
        ys: ArrayLike<number>,
        originY: number,
    ): boolean {
        if (
            !this.ensure() ||
            range.released ||
            range.owner !== this.resourceOwner ||
            this.retainedNoteBodies.get(range.group) !== range ||
            range.group.parent ||
            range.group.children.length !== range.count ||
            ys.length !== range.count ||
            this.layers.length ||
            this.state.clips.length ||
            this.state.globalCompositeOperation !== 'source-over' ||
            this.state.globalAlpha !== range.alpha ||
            this.state.imageSmoothingEnabled !== range.smoothing
        )
            return false
        const matrix = this.state.matrix
        const origin = -matrix[3] * originY
        if (
            !matrix.every(Number.isFinite) ||
            !Number.isFinite(origin) ||
            range.matrix.slice(0, 4).some((value, index) => value !== matrix[index]) ||
            !range.regions.every((region) => this.validNoteRegion(region))
        )
            return false
        // Validate the whole update before moving any Sprite. Failed updates
        // leave the previous group intact for the caller's normal fallback.
        for (let index = 0; index < range.count; index++) {
            const y = ys[index]
            if (y === undefined || !Number.isFinite(y) || !Number.isFinite(matrix[3] * y + origin))
                return false
        }
        for (const [index, child] of range.group.children.entries()) {
            const y = ys[index]
            if (y !== undefined) child.position.y = matrix[3] * y + origin
        }
        range.matrix[5] = origin
        return true
    }
    drawNoteBodies(range: RetainedNoteBodies): boolean {
        if (
            !this.ensure() ||
            range.released ||
            range.owner !== this.resourceOwner ||
            this.retainedNoteBodies.get(range.group) !== range ||
            range.group.parent ||
            this.layers.length ||
            this.state.clips.length ||
            this.state.globalCompositeOperation !== 'source-over' ||
            this.state.globalAlpha !== range.alpha ||
            this.state.imageSmoothingEnabled !== range.smoothing
        )
            return false
        const matrix = this.state.matrix
        if (
            !matrix.every(Number.isFinite) ||
            range.matrix.slice(0, 4).some((value, index) => value !== matrix[index]) ||
            !Number.isFinite(matrix[5] - range.matrix[5]) ||
            !range.regions.every((region) => this.validNoteRegion(region))
        )
            return false
        // Producers must finish before this group becomes one of their readers.
        for (const page of range.pages) page.getContext().flush()
        if (!range.regions.every((region) => this.validNoteRegion(region)) || !this.mutate())
            return false
        const sampling = range.smoothing ? 'linear' : 'nearest'
        for (const source of range.sources) {
            if (source.style.scaleMode !== sampling) {
                this.resources.flushReaders(source)
                source.style.scaleMode = sampling
                source.style.update()
            }
        }
        // A sampling change may flush this context and clear all earlier reads.
        for (const source of range.sources) {
            this.reads.add(source)
            this.resources.addReader(source, this.flushReader)
        }
        range.group.position.set(matrix[4], matrix[5] - range.matrix[5])
        this.parent().addChild(range.group)
        return true
    }
    releaseNoteBodies(range: RetainedNoteBodies) {
        if (range.released || this.retainedNoteBodies.get(range.group) !== range) return
        if (range.group.parent && !this.disposed && !this.resources.lost) this.flush()
        if (this.retainedNoteBodies.get(range.group) !== range) return
        range.group.removeFromParent()
        this.retainedNoteBodies.delete(range.group)
        this.recycleNodes(range.group)
        range.group.destroy()
        range.released = true
    }
    /** Note crops stay fixed; only their destination changes while scrolling. */
    drawNoteAtlasRegion(
        region: NoteAtlasRegion,
        x: number,
        y: number,
        width: number,
        height: number,
    ) {
        if (
            !this.ensure() ||
            region.owner !== this.resourceOwner ||
            region.texture.destroyed ||
            region.texture.source.destroyed
        )
            return
        region.surface.getContext().flush()
        if (width < 0) {
            x += width
            width = -width
        }
        if (height < 0) {
            y += height
            height = -height
        }
        const matrix = this.state.matrix
        if (matrix[1] !== 0 || matrix[2] !== 0) {
            this.imageQuad(region.texture, [x, y, width, height])
            return
        }
        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            !Number.isFinite(width) ||
            !Number.isFinite(height) ||
            width <= 0 ||
            height <= 0 ||
            !this.mutate()
        )
            return
        const texture = region.texture
        const sampling = this.state.imageSmoothingEnabled ? 'linear' : 'nearest'
        if (texture.source.style.scaleMode !== sampling) {
            this.resources.flushReaders(texture.source)
            texture.source.style.scaleMode = sampling
            texture.source.style.update()
        }
        const sprite = this.spritePool.pop() ?? new Sprite()
        sprite.texture = texture
        sprite.alpha = this.state.globalAlpha
        sprite.blendMode = 'normal'
        sprite.rotation = 0
        sprite.skew.set(0, 0)
        sprite.scale.set(matrix[0] * (width / texture.width), matrix[3] * (height / texture.height))
        sprite.position.set(matrix[0] * x + matrix[4], matrix[3] * y + matrix[5])
        this.parent().addChild(sprite)
        this.reads.add(texture.source)
        this.resources.addReader(texture.source, this.flushReader)
    }
    /** Peak waveforms select source rows monotonically even at near-1:1 zoom. */
    drawWaveform(source: ImageSource, ...args: number[]) {
        if (!this.ensure()) return
        this.imageQuad(this.resources.image(source), args, !this.target)
    }
    private imageQuad(image: Texture, args: number[], waveform = false) {
        let sx = 0,
            sy = 0,
            sw = image.width,
            sh = image.height,
            dx: number,
            dy: number,
            dw: number,
            dh: number
        if (args.length === 8)
            [sx, sy, sw, sh, dx, dy, dw, dh] = args as [
                number,
                number,
                number,
                number,
                number,
                number,
                number,
                number,
            ]
        else {
            dx = args[0] ?? 0
            dy = args[1] ?? 0
            dw = args[2] ?? sw
            dh = args[3] ?? sh
        }
        if (![sx, sy, sw, sh, dx, dy, dw, dh].every(Number.isFinite) || !sw || !sh || !dw || !dh)
            return
        if (sw < 0) {
            sx += sw
            sw = -sw
        }
        if (sh < 0) {
            sy += sh
            sh = -sh
        }
        if (dw < 0) {
            dx += dw
            dw = -dw
        }
        if (dh < 0) {
            dy += dh
            dh = -dh
        }
        const l = Math.max(0, sx),
            t = Math.max(0, sy),
            r = Math.min(image.width, sx + sw),
            b = Math.min(image.height, sy + sh)
        if (r <= l || b <= t || !this.mutate()) return
        const x = dx + ((l - sx) / sw) * dw,
            y = dy + ((t - sy) / sh) * dh,
            w = ((r - l) / sw) * dw,
            h = ((b - t) / sh) * dh
        const sampling = this.state.imageSmoothingEnabled ? 'linear' : 'nearest'
        if (image.source.style.scaleMode !== sampling) {
            // Already queued sprites must keep the sampler used when enqueued.
            this.resources.flushReaders(image.source)
            image.source.style.scaleMode = sampling
            image.source.style.update()
        }
        const matrix = multiply(this.state.matrix, [w / (r - l), 0, 0, h / (b - t), x, y])
        if (
            waveform &&
            sampling === 'nearest' &&
            matrix[1] === 0 &&
            matrix[2] === 0 &&
            [l, t, r, b].every(Number.isInteger)
        ) {
            const mesh = this.waveforms.draw(
                image,
                [l, t, r, b],
                matrix,
                this.height,
                this.state.globalAlpha,
            )
            this.parent().addChild(mesh)
            this.reads.add(image.source)
            this.resources.addReader(image.source, this.flushReader)
            return
        }
        let texture = image
        if (l !== 0 || t !== 0 || r !== image.width || b !== image.height) {
            const frame =
                this.frames[this.usedFrames] ??
                (this.frames[this.usedFrames] = new Texture({
                    source: image.source,
                    frame: new Rectangle(),
                    orig: new Rectangle(),
                    dynamic: true,
                }))
            this.usedFrames++
            if (frame.source !== image.source) frame.source = image.source
            frame.frame.copyFrom(new Rectangle(l, t, r - l, b - t))
            frame.orig.copyFrom(new Rectangle(0, 0, r - l, b - t))
            frame.update()
            texture = frame
        }
        const sprite = this.spritePool.pop() ?? new Sprite()
        sprite.texture = texture
        sprite.alpha = this.state.globalAlpha
        sprite.blendMode = 'normal'
        sprite.setFromMatrix(pixiMatrix(matrix))
        this.parent().addChild(sprite)
        this.reads.add(image.source)
        this.resources.addReader(image.source, this.flushReader)
    }
    releaseImage(source: ImageSource) {
        this.resources.releaseImage(source)
    }
    measureText(text: string) {
        this.ensure()
        return measureText(text, this.state.font, {
            ...this.state,
            direction: this.textDirection(),
        })
    }
    private textDirection(): CanvasDirection {
        if (this.state.direction !== 'inherit') return this.state.direction
        // Reading a computed style forces a style recalculation whenever the page changed since
        // the last one, such as the preview clock's text. The result changes only with the
        // page language or direction (or the canvas moving in or out of the page), so keep it
        // until the attributes that set them change.
        const canvas = this.resources.canvas
        const root = document.documentElement
        const cached = this.inheritedDirection
        if (
            cached &&
            cached.connected === canvas.isConnected &&
            cached.dir === root.dir &&
            cached.lang === root.lang &&
            cached.canvasDir === canvas.dir
        )
            return cached.value
        this.inheritedStyle ??= getComputedStyle(canvas)
        const value = this.inheritedStyle.direction === 'rtl' ? 'rtl' : 'ltr'
        this.inheritedDirection = {
            connected: canvas.isConnected,
            dir: root.dir,
            lang: root.lang,
            canvasDir: canvas.dir,
            value,
        }
        return value
    }
    fillText(text: string, x: number, y: number, maxWidth?: number) {
        if (!this.ensure()) return
        if (typeof this.state.fillStyle !== 'string') return
        const raster = getTextRaster({
            ...this.state,
            direction: this.textDirection(),
            text,
            x,
            y,
            maxWidth,
            fillStyle: this.state.fillStyle,
            viewport: this.canvas,
        })
        if (!raster) return
        const matrix = this.state.matrix
        this.state.matrix = identity()
        this.drawImage(raster.source, raster.left, raster.top)
        this.state.matrix = matrix
    }

    /** Draw a native-shaped editor label without changing the surrounding drawing state. */
    drawEditorLabel(
        text: string,
        x: number,
        y: number,
        color: string,
        fontFamily: string,
        scale: number,
        size: number,
        align: CanvasTextAlign,
        middle: number,
        alignToPixels = false,
    ) {
        this.drawLabel(text, x, y, color, fontFamily, scale, size, align, middle, alignToPixels)
    }

    /** Grid numerals stay sharp on integer device pixels while chart geometry moves continuously. */
    drawGridLabel(
        text: string,
        x: number,
        y: number,
        fontFamily: string,
        scale: number,
        align: 'start' | 'end',
        middle: number,
    ) {
        this.drawLabel(text, x, y, '#fff', fontFamily, scale, 0.4, align, middle, true)
    }

    private drawLabel(
        text: string,
        x: number,
        y: number,
        color: string,
        fontFamily: string,
        scale: number,
        size: number,
        align: CanvasTextAlign,
        middle: number,
        alignToPixels: boolean,
    ) {
        if (!text || !this.mutate()) return
        const fontSize = size * scale
        let inverseScale = 1 / scale
        if (![x, y, fontSize, inverseScale, middle].every(Number.isFinite)) return
        if (this.transformPrecision.roundMatrixArguments) {
            x = this.transformScalar(x)
            y = this.transformScalar(y)
        }
        if (
            this.transformPrecision.roundScaleArguments ||
            this.transformPrecision.roundMatrixArguments
        )
            inverseScale = this.transformScalar(inverseScale)
        // Match translate(), then scale(), including the browser's native
        // argument and intermediate precision.
        const translated = this.composedTransform(this.state.matrix, [1, 0, 0, 1, x, y])
        const matrix = this.composedTransform(translated, [inverseScale, 0, 0, inverseScale, 0, 0])
        const baseline = fontSize * middle
        if (alignToPixels) {
            // Round the raw final baseline anchor, before the raster cache's
            // 1/64 phase policy. Only this temporary text transform moves, by
            // at most half a physical pixel per axis; the scene state is intact.
            const offsetX = matrix[2] * baseline
            const offsetY = matrix[3] * baseline
            matrix[4] = Math.round(offsetX + matrix[4]) - offsetX
            matrix[5] = Math.round(offsetY + matrix[5]) - offsetY
        }
        const raster = getTextRaster({
            text,
            x: 0,
            y: baseline,
            font: `${fontSize}px ${fontFamily}`,
            fontKerning: 'normal',
            textBaseline: 'alphabetic',
            textAlign: align,
            direction: this.textDirection(),
            fillStyle: color,
            matrix,
            viewport: this.canvas,
        })
        if (!raster) return
        this.drawLabelSprite(raster.source, raster.left, raster.top, this.state.globalAlpha)
    }

    prepareEditorLabel(
        text: string,
        color: string,
        fontFamily: string,
        scale: number,
        size: number,
        align: CanvasTextAlign,
        middle: number,
        alignToPixels = false,
    ): PreparedEditorLabel {
        let inverseScale = 1 / scale
        if (
            this.transformPrecision.roundScaleArguments ||
            this.transformPrecision.roundMatrixArguments
        )
            inverseScale = this.transformScalar(inverseScale)
        const fontSize = size * scale
        return {
            text,
            color,
            font: `${fontSize}px ${fontFamily}`,
            baseline: fontSize * middle,
            inverseScale,
            align,
            alignToPixels,
        }
    }

    /** Reuse annotation layout, with the caller's live-label baseline alignment policy. */
    drawPreparedEditorLabel(label: PreparedEditorLabel, x: number, y: number, opacity = 1) {
        if (
            !label.text ||
            !this.mutate() ||
            ![x, y, label.inverseScale, label.baseline].every(Number.isFinite)
        )
            return
        if (this.transformPrecision.roundMatrixArguments) {
            x = this.transformScalar(x)
            y = this.transformScalar(y)
        }
        const translated = this.composedTransform(this.state.matrix, [1, 0, 0, 1, x, y])
        const matrix = this.composedTransform(translated, [
            label.inverseScale,
            0,
            0,
            label.inverseScale,
            0,
            0,
        ])
        if (label.alignToPixels) {
            const offsetX = matrix[2] * label.baseline
            const offsetY = matrix[3] * label.baseline
            matrix[4] = Math.round(offsetX + matrix[4]) - offsetX
            matrix[5] = Math.round(offsetY + matrix[5]) - offsetY
        }
        if (
            !label.raster ||
            !label.linear ||
            label.linear.some((value, index) => value !== matrix[index])
        ) {
            label.linear = matrix.slice(0, 4)
            label.raster = new PreparedTextRaster({
                text: label.text,
                x: 0,
                y: label.baseline,
                font: label.font,
                fontKerning: 'normal',
                textBaseline: 'alphabetic',
                textAlign: label.align,
                fillStyle: label.color,
                matrix,
            })
        }
        const raster = label.raster.get(matrix[4], matrix[5], this.canvas, this.textDirection())
        if (raster)
            this.drawLabelSprite(
                raster.source,
                raster.left,
                raster.top,
                this.state.globalAlpha * opacity,
            )
    }

    prepareEaseGlyph(path: DrawPath, color: string, width: number): PreparedEaseGlyph | undefined {
        if (!this.ensure()) return
        const matrix = [...this.state.matrix] as Matrix
        const factor = resolutionScale(matrix)
        const paint = this.paints.stroke(color, width, 'round', 'round', 10)
        const resource = this.paths.get(
            path,
            paint.style,
            true,
            'nonzero',
            paint.key,
            { dash: [], dashOffset: 0 },
            factor,
        )
        const release = this.paths.pin([resource])
        if (!release) return
        return {
            owner: this.resourceOwner,
            resource,
            matrix,
            factor,
            release,
            released: false,
        }
    }

    drawPreparedEaseGlyph(glyph: PreparedEaseGlyph, x: number, y: number, opacity = 1) {
        if (
            !this.mutate() ||
            glyph.released ||
            glyph.owner !== this.resourceOwner ||
            glyph.matrix.slice(0, 4).some((value, index) => value !== this.state.matrix[index])
        )
            return false
        if (this.transformPrecision.roundMatrixArguments) {
            x = this.transformScalar(x)
            y = this.transformScalar(y)
        }
        const translated = this.composedTransform(this.state.matrix, [1, 0, 0, 1, x, y])
        const node = this.pathNode(
            glyph.resource,
            multiply(translated, [1 / glyph.factor, 0, 0, 1 / glyph.factor, 0, 0]),
            this.state.globalAlpha * opacity,
        )
        this.parent().addChild(node)
        return true
    }

    releasePreparedEaseGlyph(glyph: PreparedEaseGlyph) {
        if (glyph.released) return
        glyph.released = true
        glyph.release()
    }

    /** Whole immutable name artwork in device pixels; the scene transform is already applied. */
    drawNameSprite(source: HTMLCanvasElement, x: number, y: number) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !this.mutate()) return
        this.drawLabelSprite(source, x, y, this.state.globalAlpha)
    }

    private drawLabelSprite(source: HTMLCanvasElement, x: number, y: number, alpha: number) {
        const texture = this.resources.image(source)
        const sampling = this.state.imageSmoothingEnabled ? 'linear' : 'nearest'
        if (texture.source.style.scaleMode !== sampling) {
            this.resources.flushReaders(texture.source)
            texture.source.style.scaleMode = sampling
            texture.source.style.update()
        }
        const sprite = this.spritePool.pop() ?? new Sprite()
        sprite.texture = texture
        sprite.alpha = alpha
        sprite.blendMode = 'normal'
        sprite.rotation = 0
        sprite.skew.set(0, 0)
        sprite.scale.set(1, 1)
        sprite.position.set(x, y)
        this.parent().addChild(sprite)
        this.reads.add(texture.source)
        this.resources.addReader(texture.source, this.flushReader)
    }
    getImageData(sx: number, sy: number, sw: number, sh: number) {
        if (sw < 0) {
            sx += sw
            sw = -sw
        }
        if (sh < 0) {
            sy += sh
            sh = -sh
        }
        const data = new ImageData(Math.trunc(sw), Math.trunc(sh))
        if (!this.ensure()) return data
        this.flush()
        if (!this.resources.initialized)
            throw new Error('Await context.ready before reading pixels')
        const gl = this.resources.gl,
            renderer = this.resources.renderer
        const x = Math.max(0, Math.trunc(sx)),
            y = Math.max(0, Math.trunc(sy)),
            w = Math.min(this.width, sx + sw) - x,
            h = Math.min(this.height, sy + sh) - y
        if (w <= 0 || h <= 0) return data
        if (!this.target)
            renderer.renderTarget.bind({
                target: this.resources.canvas,
                clear: false,
            })
        const extracted = this.target ? this.resources.pixels(this.target) : undefined
        const bytes = extracted?.pixels ?? new Uint8Array(w * h * 4)
        if (!extracted)
            gl.readPixels(x, this.height - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
        for (let row = 0; row < h; row++)
            for (let col = 0; col < w; col++) {
                const from = extracted
                        ? ((row + y) * extracted.width + col + x) * 4
                        : ((h - 1 - row) * w + col) * 4,
                    to = ((row + y - sy) * sw + col + x - sx) * 4,
                    a = bytes[from + 3] ?? 0
                for (let c = 0; c < 3; c++)
                    data.data[to + c] = a
                        ? Math.min(255, Math.round(((bytes[from + c] ?? 0) * 255) / a))
                        : 0
                data.data[to + 3] = a
            }
        return data
    }
    createImageData(w: number, h: number) {
        return new ImageData(w, h)
    }
    putImageData(data: ImageData, x: number, y: number) {
        this.save()
        this.state.clips = []
        this.resetTransform()
        this.globalAlpha = 1
        this.clearRect(x, y, data.width, data.height)
        this.releaseImage(data)
        this.drawImage(data, x, y)
        this.restore()
    }
    get fillStyle() {
        this.ensure()
        return this.state.fillStyle
    }
    set fillStyle(value: DrawStyle) {
        this.ensure()
        this.state.fillStyle = value
    }
    get strokeStyle() {
        this.ensure()
        return this.state.strokeStyle
    }
    set strokeStyle(value: DrawStyle) {
        this.ensure()
        this.state.strokeStyle = value
    }
    get globalAlpha() {
        this.ensure()
        return this.state.globalAlpha
    }
    set globalAlpha(value: number) {
        this.ensure()
        if (value >= 0 && value <= 1) this.state.globalAlpha = value
    }
    get globalCompositeOperation() {
        this.ensure()
        return this.state.globalCompositeOperation
    }
    set globalCompositeOperation(value: GlobalCompositeOperation) {
        this.ensure()
        this.state.globalCompositeOperation = value
    }
    get lineWidth() {
        this.ensure()
        return this.state.lineWidth
    }
    set lineWidth(value: number) {
        this.ensure()
        if (value > 0 && Number.isFinite(value)) this.state.lineWidth = value
    }
    get lineCap() {
        this.ensure()
        return this.state.lineCap
    }
    set lineCap(value: CanvasLineCap) {
        this.ensure()
        this.state.lineCap = value
    }
    get lineJoin() {
        this.ensure()
        return this.state.lineJoin
    }
    set lineJoin(value: CanvasLineJoin) {
        this.ensure()
        this.state.lineJoin = value
    }
    get miterLimit() {
        this.ensure()
        return this.state.miterLimit
    }
    set miterLimit(value: number) {
        this.ensure()
        if (value > 0 && Number.isFinite(value)) this.state.miterLimit = value
    }
    get lineDashOffset() {
        this.ensure()
        return this.state.lineDashOffset
    }
    set lineDashOffset(value: number) {
        this.ensure()
        if (Number.isFinite(value)) this.state.lineDashOffset = value
    }
    get font() {
        this.ensure()
        return this.state.font
    }
    set font(value: string) {
        this.ensure()
        this.state.font = value
    }
    get fontKerning() {
        this.ensure()
        return this.state.fontKerning
    }
    set fontKerning(value: CanvasFontKerning) {
        this.ensure()
        this.state.fontKerning = value
    }
    get textAlign() {
        this.ensure()
        return this.state.textAlign
    }
    set textAlign(value: CanvasTextAlign) {
        this.ensure()
        this.state.textAlign = value
    }
    get textBaseline() {
        this.ensure()
        return this.state.textBaseline
    }
    set textBaseline(value: CanvasTextBaseline) {
        this.ensure()
        this.state.textBaseline = value
    }
    get direction() {
        this.ensure()
        return this.state.direction
    }
    set direction(value: CanvasDirection) {
        this.ensure()
        this.state.direction = value
    }
    get imageSmoothingEnabled() {
        this.ensure()
        return this.state.imageSmoothingEnabled
    }
    set imageSmoothingEnabled(value: boolean) {
        this.ensure()
        this.state.imageSmoothingEnabled = value
    }
}
export const getDrawContext = (canvas: HTMLCanvasElement | RenderSurface): WebGLDrawContext => {
    if ('dispose' in canvas) return canvas.getContext()
    let context = contexts.get(canvas)
    if (!context) contexts.set(canvas, (context = new WebGLDrawContext(canvas)))
    return context
}
export const peekDrawContext = (canvas: HTMLCanvasElement) => contexts.get(canvas)
export const disposeDrawContext = (canvas: HTMLCanvasElement | RenderSurface) => {
    if ('dispose' in canvas) canvas.dispose()
    else contexts.get(canvas)?.dispose()
}
