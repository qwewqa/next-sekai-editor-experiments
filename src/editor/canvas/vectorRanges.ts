import type { RetainedVectors, WebGLDrawContext } from '../../rendering/context'
import type { Entity } from '../../state/entities'
import { beatToTime, timeToBeat } from '../../state/integrals/bpms'
import { createNameLayer, type NameLayer } from './names'
import { drawKeyOf, type DrawStep } from './ordering'
import type { DrawSection } from './sections'
import type { EditorDrawContext } from './types'

const bucketBeats = 16
const maxRanges = 192
const maxGraphics = 20000
const maxSectionRanges = 1024
const maxSectionGraphics = 50000
// An idle period this long fits any one section; shorter ones take what their estimate fits.
const fullIdleMs = 40
// Without requestIdleCallback (Safari), a task after the frame with this budget.
const fallbackIdleMs = 4
// Sections compiled mid-zoom would be released by its next frame; this long without one ends it.
const zoomSettleMs = 250

type IdleDeadline = { timeRemaining: () => number }
/** Runs `run` at the next idle time. */
export type IdleScheduler = (run: (deadline: IdleDeadline) => void) => void

const browserIdle = (): IdleScheduler | undefined => {
    if (typeof requestIdleCallback === 'function')
        return (run) => {
            requestIdleCallback(run)
        }
    // Node (unit tests) has neither; they pass a scheduler of their own.
    if (typeof document === 'undefined') return
    return (run) => {
        setTimeout(() => {
            const start = performance.now()
            run({ timeRemaining: () => fallbackIdleMs - (performance.now() - start) })
        }, 0)
    }
}

/** What a capture reads from the draw context, besides its transform. */
const drawState = (ctx: WebGLDrawContext) => [
    ctx.fillStyle,
    ctx.strokeStyle,
    ctx.globalAlpha,
    ctx.globalCompositeOperation,
    ctx.lineWidth,
    ctx.lineCap,
    ctx.lineJoin,
    ctx.miterLimit,
    ctx.lineDashOffset,
    ctx.getLineDash().join(),
    ctx.font,
    ctx.fontKerning,
    ctx.textAlign,
    ctx.textBaseline,
    ctx.direction,
    ctx.imageSmoothingEnabled,
]

/** The frame's inputs for compiling sections near the view at idle time. */
type AheadSource = {
    context: EditorDrawContext
    draw: (context: EditorDrawContext, step: DrawStep) => void
    owner: object
    matrix: DOMMatrix
    state: unknown[]
}
type Entry = {
    range: RetainedVectors
    steps: DrawStep[]
    names: NameLayer
    frame: number
}
type SectionEntry = {
    section: DrawSection
    range: RetainedVectors
    names: NameLayer
    frame: number
    points?: PointSection
    strokes?: { originTime: number; ups: number }
}

type PointSection = {
    times: Float64Array
    ys: Float64Array
    originTime: number
    ups: number
    localNames: NameLayer
    nameTimes: Float64Array
}

// Only these draw branches use UPS solely for a fixed-size artwork's time anchor.
// Labels, connections, connectors and legacy preview ranges retain their old path.
const isPointStep = ({ entity, part }: DrawStep) => {
    switch (entity.type) {
        case 'cameraEventJoint':
        case 'stageMaskEventJoint':
        case 'stagePivotEventJoint':
        case 'stageStyleEventJoint':
        case 'stageTransformEventJoint':
            return part === undefined
        case 'bpm':
            return part === 'line'
        case 'timeScale':
            return part === 'line' || part === 'marker'
        case 'cameraEventConnection':
        case 'stageMaskEventConnection':
        case 'stagePivotEventConnection':
        case 'stageStyleEventConnection':
        case 'stageTransformEventConnection':
        case 'note':
        case 'connector':
        default:
            return false
    }
}

const pointNames = ({ localNames, nameTimes }: PointSection, ups: number): NameLayer => ({
    names: localNames.names.map((name, index) => {
        const y = (nameTimes[index] ?? NaN) * ups
        // Preserve the original signed-zero result when there is no local offset.
        return { ...name, y: name.y === 0 ? y : y + name.y }
    }),
})

/** Consecutive vector ranges preserve the editor's layer/tier/beat painter order. */
export class VectorRanges {
    private context?: WebGLDrawContext
    private key: unknown[] = []
    private ups?: number
    private entries = new Map<string, Entry>()
    private sections = new Map<string, SectionEntry>()
    private sectionPlan?: readonly DrawSection[]
    private sectionGraphics = 0
    private activeSectionKeys = new Set<string>()
    private frame = 0
    private graphics = 0
    private transient: RetainedVectors[] = []
    private liveEntities?: ReadonlySet<Entity>
    private activeSections: readonly DrawSection[] = []
    private ahead?: AheadSource
    private aheadPending = false
    private zoomed = false
    private settling = false
    private aheadDone: unknown[] = []
    private msPerSection = 0
    private msPerStep = 0
    readonly stats = { captures: 0, replays: 0, declined: 0, ahead: 0, ranges: 0, graphics: 0 }

    /** `idle` compiles sections near the view at idle time; none in Node by default. */
    constructor(private readonly idle: IdleScheduler | undefined = browserIdle()) {}

    beginFrame(context: EditorDrawContext, invalidation: readonly unknown[]) {
        this.liveEntities = undefined
        this.ahead = undefined
        this.zoomed = this.ups !== undefined && this.ups !== context.ups
        this.activeSectionKeys.clear()
        const { ctx } = context
        const matrix = ctx.getTransform()
        const key = [
            ctx.resourceOwner,
            ctx.canvas.width,
            ctx.canvas.height,
            matrix.a,
            matrix.b,
            matrix.c,
            matrix.d,
            // Immutable edits preserve unrelated entities; membership below
            // checks each range. These shared inputs can change their artwork
            // or queued stage names even when an entity itself stays the same.
            context.state.bpms,
            context.state.stages,
            context.state.isDynamicStages,
            context.composed?.stages,
            context.scale,
            context.defaultGroupId,
            context.showStageName,
            context.showGroupName,
            context.nameContrast,
            context.fontFamily,
            context.fontMiddle,
            context.figureMiddle,
            ...invalidation,
        ]
        if (
            this.context !== ctx ||
            key.length !== this.key.length ||
            key.some((value, index) => value !== this.key[index])
        ) {
            this.clear()
            this.context = ctx
            this.key = key
        } else if (this.ups !== context.ups) {
            // Point sections keep fixed-size artwork and update their anchors
            // lazily on return. Every other range still depends on the old UPS.
            for (const [key, entry] of this.entries) this.remove(key, entry)
            for (const [key, entry] of this.sections)
                if (!entry.points && !entry.strokes) this.removeSection(key, entry)
        }
        this.ups = context.ups
        this.frame++
    }

    /** The complete immutable plan, not just this viewport's sections. */
    prepareSections(sections: readonly DrawSection[], active: readonly DrawSection[]) {
        this.activeSectionKeys = new Set(active.map((section) => section.key))
        this.activeSections = active
        if (sections === this.sectionPlan) return
        const current = new Map(sections.map((section) => [section.key, section]))
        for (const [key, entry] of this.sections)
            if (current.get(key) !== entry.section) this.removeSection(key, entry)
        this.sectionPlan = sections
    }

    drawSection(
        context: EditorDrawContext,
        section: DrawSection,
        hovered: ReadonlySet<Entity> | undefined,
        draw: (context: EditorDrawContext, step: DrawStep) => void,
        visibleOwners?: ReadonlySet<Entity>,
    ) {
        const { ctx } = context
        // The state every section of this frame is captured in, for those compiled at idle.
        if (!this.ahead && this.idle) {
            this.ahead = {
                context,
                draw,
                owner: ctx.resourceOwner,
                matrix: ctx.getTransform(),
                state: drawState(ctx),
            }
        }
        let entry = this.sections.get(section.key)
        if (entry && (entry.section !== section || entry.range.released)) {
            this.removeSection(section.key, entry)
            entry = undefined
        }
        if (entry?.points && entry.points.ups !== context.ups) {
            const { points } = entry
            for (const [index, time] of points.times.entries())
                points.ys[index] = time * context.ups
            if (
                !ctx.updateVectorPointPositions(
                    entry.range,
                    points.ys,
                    points.originTime * context.ups,
                )
            ) {
                this.removeSection(section.key, entry)
                entry = undefined
            } else {
                entry.names = pointNames(points, context.ups)
                points.ups = context.ups
            }
        }
        if (entry?.strokes && entry.strokes.ups !== context.ups) {
            if (!ctx.updateEventStrokeVectors(entry.range, entry.strokes.originTime, context.ups)) {
                this.removeSection(section.key, entry)
                entry = undefined
            } else entry.strokes.ups = context.ups
        }
        if (entry) this.stats.replays++
        else {
            // Evict only older, detached sections. Never flush a group already
            // queued in this frame merely to admit another cache entry.
            this.makeSectionRoom(0)
            const start = performance.now()
            const { captured, names, points, strokes } = this.captureSection(context, section, draw)
            this.learn(section, performance.now() - start)
            if (captured?.reusable && this.makeSectionRoom(captured.graphics)) {
                entry = this.keepSection(section, captured, names, points, strokes)
                this.stats.captures++
            } else {
                this.stats.declined++
                if (captured) {
                    // Pin refusal may leave new paths in this frame's overflow.
                    // Keep the already-built one-shot and free old, inactive
                    // pins for the next frame; recapturing now cannot promote it.
                    if (!captured.reusable) this.releaseInactiveSections()
                    if (ctx.drawVectors(captured)) {
                        this.appendNames(context, names, hovered, visibleOwners)
                        if (captured.reusable) this.transient.push(captured)
                        return
                    }
                    ctx.releaseVectors(captured)
                }
            }
        }
        if (entry) {
            if (ctx.drawVectors(entry.range)) {
                entry.frame = this.frame
                // Map insertion order is the section LRU; pan does not inspect
                // or copy every step of an unchanged section.
                this.sections.delete(section.key)
                this.sections.set(section.key, entry)
                this.appendNames(context, entry.names, hovered, visibleOwners)
                return
            }
            this.removeSection(section.key, entry)
        }
        // Unsupported capture/replay still draws every vector, but offscreen
        // name requests must not influence this frame's placement decisions.
        const names = createNameLayer()
        const liveContext = { ...context, names }
        for (const step of section.steps) draw(liveContext, step)
        this.appendNames(context, names, hovered, visibleOwners)
    }

    prepare(steps: DrawStep[], raisedAt: number, liveEntities?: ReadonlySet<Entity>) {
        this.liveEntities = liveEntities
        const retained = new Set<string>()
        for (let index = 0; index < steps.length;) {
            const first = steps[index]
            if (!first) break
            if (first.entity.type === 'note') {
                index++
                continue
            }
            const pass = index < raisedAt ? 'normal' : 'raised'
            const limit = index < raisedAt ? raisedAt : steps.length
            const key = this.rangeKey(first, pass)
            let end = index + 1
            while (end < limit) {
                const next = steps[end]
                if (!next || next.entity.type === 'note' || this.rangeKey(next, pass) !== key) break
                end++
            }
            const entry = this.entries.get(key)
            if (
                entry &&
                !this.hasLiveEntity(steps, index, end) &&
                this.matches(entry, steps, index, end)
            )
                retained.add(key)
            index = end
        }
        // A jump must free the old viewport before building the new one. Holding
        // both until presentation would turn a bounded working set into misses.
        for (const [key, entry] of this.entries) if (!retained.has(key)) this.remove(key, entry)
    }

    draw(
        context: EditorDrawContext,
        steps: DrawStep[],
        from: number,
        to: number,
        pass: string,
        hovered: ReadonlySet<Entity> | undefined,
        draw: (context: EditorDrawContext, step: DrawStep) => void,
        drawNotes?: (from: number, to: number, pass: string) => void,
    ) {
        const { ctx } = context
        for (let index = from; index < to;) {
            const first = steps[index]
            if (!first) break
            // Notes use their own frame-validated atlas path, never vector capture.
            if (first.entity.type === 'note') {
                const key = this.rangeKey(first, pass)
                let end = index + 1
                if (drawNotes) {
                    while (end < to) {
                        const next = steps[end]
                        if (next?.entity.type !== 'note' || this.rangeKey(next, pass) !== key) break
                        end++
                    }
                    drawNotes(index, end, pass)
                } else draw(context, first)
                index = end
                continue
            }
            const key = this.rangeKey(first, pass)
            let end = index + 1
            while (end < to) {
                const next = steps[end]
                if (!next || next.entity.type === 'note' || this.rangeKey(next, pass) !== key) break
                end++
            }
            // Attached-slide previews can change geometry through slide metadata,
            // even when an endpoint's identity is unchanged. Keep their complete
            // ordered ranges live; unrelated ranges remain reusable.
            if (this.hasLiveEntity(steps, index, end)) {
                for (let cursor = index; cursor < end; cursor++) {
                    const step = steps[cursor]
                    if (step) draw(context, step)
                }
                index = end
                continue
            }
            let entry = this.entries.get(key)
            let drawn = false
            const matches = entry && this.matches(entry, steps, index, end)
            if (!matches) {
                if (entry) this.remove(key, entry)
                entry = undefined
                const beat = Math.floor(drawKeyOf(first).beat / bucketBeats) * bucketBeats
                const { captured, names } = this.capture(context, steps, index, end, beat, draw)
                if (
                    captured &&
                    captured.reusable &&
                    this.entries.size < maxRanges &&
                    this.graphics + captured.graphics <= maxGraphics &&
                    this.makeSectionRoom(captured.graphics)
                ) {
                    entry = {
                        range: captured,
                        steps: steps.slice(index, end),
                        names,
                        frame: this.frame,
                    }
                    this.entries.set(key, entry)
                    this.graphics += captured.graphics
                    this.stats.captures++
                } else {
                    if (captured) {
                        if (!captured.reusable) this.releaseInactiveSections()
                        drawn = ctx.drawVectors(captured)
                        if (drawn) {
                            this.appendNames(context, names, hovered)
                        } else ctx.releaseVectors(captured)
                        // Unpinned ranges recycle themselves after presentation;
                        // a pinned range exceeding the node/group cap is one-shot.
                        if (drawn && captured.reusable) this.transient.push(captured)
                    }
                    this.stats.declined++
                }
            } else this.stats.replays++
            if (entry && ctx.drawVectors(entry.range)) {
                entry.frame = this.frame
                this.appendNames(context, entry.names, hovered)
            } else if (!drawn) {
                for (let cursor = index; cursor < end; cursor++) {
                    const step = steps[cursor]
                    if (step) draw(context, step)
                }
            }
            index = end
        }
    }

    endFrame() {
        // Flush has detached every queued group before geometry can be unpinned.
        for (const range of this.transient) this.context?.releaseVectors(range)
        this.transient = []
        for (const [key, entry] of this.entries)
            if (entry.frame !== this.frame) this.remove(key, entry)
        this.stats.ranges = this.entries.size + this.sections.size
        this.stats.graphics = this.graphics + this.sectionGraphics
        this.scheduleAhead()
    }

    private scheduleAhead() {
        const { idle } = this
        if (!idle || !this.ahead || this.aheadPending) return
        if (this.zoomed) {
            this.afterZoom()
            return
        }
        const key = [this.sectionPlan, this.activeSections, this.ahead.owner]
        if (key.every((value, index) => value === this.aheadDone[index])) return
        this.aheadPending = true
        idle((deadline) => {
            this.aheadPending = false
            const left = this.compileAhead(deadline)
            if (left === 'more') this.scheduleAhead()
            else if (left === 'done') this.aheadDone = key
            // On 'frame', the next frame that draws sections asks again.
        })
    }

    /** Compiles ahead once no frame has come for `zoomSettleMs`: the zoom paused. */
    private afterZoom() {
        if (this.settling) return
        this.settling = true
        const wait = (frame: number) =>
            setTimeout(() => {
                if (this.frame !== frame) {
                    wait(this.frame)
                    return
                }
                this.settling = false
                this.zoomed = false
                this.scheduleAhead()
            }, zoomSettleMs)
        wait(this.frame)
    }

    /**
     * Compiles the sections nearest the view, within a view span of it, as the frame would have:
     * same context, transform and drawing state. Says what is left: more for the next idle
     * period, a frame to wait for, or nothing.
     */
    private compileAhead(deadline: IdleDeadline): 'more' | 'frame' | 'done' {
        const source = this.ahead
        const ctx = this.context
        if (
            !source ||
            !ctx ||
            source.context.ctx !== ctx ||
            source.owner !== ctx.resourceOwner ||
            ctx.isContextLost()
        )
            return 'done'
        const candidates = this.aheadSections(source)
        if (!candidates.length) return 'done'
        // Eviction takes only sections outside the view and its reach.
        const active = this.activeSectionKeys
        this.activeSectionKeys = new Set([...active, ...candidates.map(({ key }) => key)])
        ctx.save()
        try {
            const { a, b, c, d, e, f } = source.matrix
            ctx.setTransform(a, b, c, d, e, f)
            const state = drawState(ctx)
            if (state.some((value, index) => value !== source.state[index])) return 'done'
            let compiled = 0
            for (const section of candidates) {
                const estimate = Math.max(this.msPerSection, this.msPerStep * section.steps.length)
                // While the app clock runs, each idle period ends before its next frame, so
                // the next is no longer: after one too short for the nearest section, wait
                // for a frame that draws.
                if (deadline.timeRemaining() < Math.min(estimate, fullIdleMs))
                    return compiled ? 'more' : 'frame'
                const stale = this.sections.get(section.key)
                if (stale) this.removeSection(section.key, stale)
                const start = performance.now()
                const { captured, names, points, strokes } = this.captureSection(
                    source.context,
                    section,
                    source.draw,
                )
                this.learn(section, performance.now() - start)
                if (!captured?.reusable || !this.makeSectionRoom(captured.graphics)) {
                    if (captured) ctx.releaseVectors(captured)
                    return 'done'
                }
                this.keepSection(section, captured, names, points, strokes)
                this.stats.ahead++
                compiled++
            }
            return 'done'
        } finally {
            ctx.restore()
            this.activeSectionKeys = active
        }
    }

    /** Uncompiled vector sections within one view span of the view, nearest first. */
    private aheadSections({ context }: AheadSource) {
        const plan = this.sectionPlan
        const { bounds, ups, state } = context
        const times = [bounds.t / ups, bounds.b / ups]
        const from = timeToBeat(state.bpms, Math.max(0, Math.min(...times)))
        const to = timeToBeat(state.bpms, Math.max(0, ...times))
        if (!plan || !(from <= to)) return []
        const reach = Math.max(to - from, 1)
        const distance = ({ minBeat, maxBeat }: DrawSection) =>
            Math.max(0, from - maxBeat, minBeat - to)
        return plan
            .filter(
                (section) =>
                    !section.live &&
                    section.steps.length &&
                    section.steps[0]?.entity.type !== 'note' &&
                    !this.activeSectionKeys.has(section.key) &&
                    this.sections.get(section.key)?.section !== section &&
                    distance(section) <= reach,
            )
            .sort((a, b) => distance(a) - distance(b))
    }

    private learn(section: DrawSection, ms: number) {
        // Recent captures weigh most; the estimate only paces idle work.
        this.msPerSection = this.msPerSection * 0.8 + ms * 0.2
        this.msPerStep = this.msPerStep * 0.8 + (ms / Math.max(1, section.steps.length)) * 0.2
    }

    private captureSection(
        context: EditorDrawContext,
        section: DrawSection,
        draw: (context: EditorDrawContext, step: DrawStep) => void,
    ) {
        const pointCapture = this.capturePoints(context, section, draw)
        const strokeCapture = pointCapture ? undefined : this.captureStrokes(context, section, draw)
        const { captured, names } =
            pointCapture ??
            strokeCapture ??
            this.capture(
                context,
                section.steps,
                0,
                section.steps.length,
                Math.floor(section.minBeat / bucketBeats) * bucketBeats,
                draw,
            )
        return { captured, names, points: pointCapture?.points, strokes: strokeCapture?.strokes }
    }

    private keepSection(
        section: DrawSection,
        range: RetainedVectors,
        names: NameLayer,
        points?: PointSection,
        strokes?: SectionEntry['strokes'],
    ) {
        const entry: SectionEntry = { section, range, names, frame: this.frame, points, strokes }
        this.sections.set(section.key, entry)
        this.sectionGraphics += range.graphics
        return entry
    }

    clear() {
        for (const range of this.transient) this.context?.releaseVectors(range)
        this.transient = []
        for (const [key, entry] of this.entries) this.remove(key, entry)
        for (const [key, entry] of this.sections) this.removeSection(key, entry)
        this.sectionPlan = undefined
        this.activeSectionKeys.clear()
        this.activeSections = []
        this.ahead = undefined
        this.context = undefined
        this.key = []
        this.ups = undefined
        this.liveEntities = undefined
    }

    private hasLiveEntity(steps: DrawStep[], from: number, to: number) {
        if (!this.liveEntities) return false
        for (let index = from; index < to; index++) {
            const step = steps[index]
            if (step && this.liveEntities.has(step.entity)) return true
        }
        return false
    }

    private rangeKey(step: DrawStep, pass: string) {
        const { tier, isFull, layer, beat } = drawKeyOf(step)
        return `${pass}:${tier}:${+isFull}:${layer}:${Math.floor(beat / bucketBeats)}`
    }

    private matches(entry: Entry, steps: DrawStep[], from: number, to: number) {
        return (
            !entry.range.released &&
            entry.steps.length === to - from &&
            entry.steps.every((old, offset) => {
                const current = steps[from + offset]
                return (
                    !!current &&
                    old.entity === current.entity &&
                    old.part === current.part &&
                    old.opacity === current.opacity &&
                    old.highlighted === current.highlighted &&
                    old.raised === current.raised
                )
            })
        )
    }

    private appendNames(
        context: EditorDrawContext,
        names: NameLayer,
        hovered: ReadonlySet<Entity> | undefined,
        visibleOwners?: ReadonlySet<Entity>,
    ) {
        const target = context.names
        if (!target) return
        for (const name of names.names) {
            if (visibleOwners && !visibleOwners.has(name.owner)) continue
            const highlighted = name.highlighted || !!hovered?.has(name.owner)
            if (!highlighted && !context.recentlyActive) continue
            target.names.push(highlighted === name.highlighted ? name : { ...name, highlighted })
        }
    }

    private remove(key: string, entry: Entry) {
        this.context?.releaseVectors(entry.range)
        this.entries.delete(key)
        this.graphics -= entry.range.graphics
    }

    private capture(
        context: EditorDrawContext,
        steps: readonly DrawStep[],
        from: number,
        to: number,
        beat: number,
        draw: (context: EditorDrawContext, step: DrawStep) => void,
    ) {
        const names = createNameLayer()
        // Stage-joint names are metadata, collected even while idle. Selection
        // belongs to membership; hover and activity are resolved during replay.
        const captureContext = { ...context, names, recentlyActive: true }
        const originY = beatToTime(context.state.bpms, beat) * context.ups
        const captured = context.ctx.captureVectors(() => {
            for (let cursor = from; cursor < to; cursor++) {
                const step = steps[cursor]
                if (step) draw(captureContext, step)
            }
        }, [0, originY])
        if (names.names.length) {
            const selected = new Set<Entity>()
            for (let cursor = from; cursor < to; cursor++) {
                const step = steps[cursor]
                if (step?.highlighted) selected.add(step.entity)
            }
            for (const name of names.names) name.highlighted = selected.has(name.owner)
        }
        return { captured, names }
    }

    private capturePoints(
        context: EditorDrawContext,
        section: DrawSection,
        draw: (context: EditorDrawContext, step: DrawStep) => void,
    ) {
        const { steps } = section
        if (
            section.live ||
            !steps.length ||
            steps.length > maxSectionGraphics ||
            !steps.every(isPointStep)
        )
            return
        const times = Float64Array.from(steps, ({ entity }) =>
            beatToTime(context.state.bpms, entity.beat),
        )
        const ys = times.map((time) => time * context.ups)
        const originTime = beatToTime(
            context.state.bpms,
            Math.floor(section.minBeat / bucketBeats) * bucketBeats,
        )
        const originY = originTime * context.ups
        if (
            !times.every(Number.isFinite) ||
            !ys.every(Number.isFinite) ||
            !Number.isFinite(originY)
        )
            return
        const localNames = createNameLayer()
        const captureContext = { ...context, ups: 0, names: localNames, recentlyActive: true }
        const captured = context.ctx.capturePointVectors(
            steps.map((step, index) => ({
                y: ys[index] ?? NaN,
                draw: () => {
                    draw(captureContext, step)
                },
            })),
            originY,
        )
        if (!captured) return
        if (localNames.names.length) {
            const selected = new Set(
                steps.filter((step) => step.highlighted).map(({ entity }) => entity),
            )
            for (const name of localNames.names) name.highlighted = selected.has(name.owner)
        }
        const nameTimes = Float64Array.from(localNames.names, ({ owner }) =>
            beatToTime(context.state.bpms, owner.beat),
        )
        if (!nameTimes.every(Number.isFinite)) {
            context.ctx.releaseVectors(captured)
            return
        }
        const points: PointSection = {
            times,
            ys,
            originTime,
            ups: context.ups,
            localNames,
            nameTimes,
        }
        return { captured, names: pointNames(points, context.ups), points }
    }

    private captureStrokes(
        context: EditorDrawContext,
        section: DrawSection,
        draw: (context: EditorDrawContext, step: DrawStep) => void,
    ) {
        if (
            section.live ||
            !section.steps.length ||
            typeof context.ctx.captureEventStrokeVectors !== 'function' ||
            !section.steps.every(({ entity }) => entity.type.endsWith('EventConnection'))
        )
            return
        const originTime = beatToTime(
            context.state.bpms,
            Math.floor(section.minBeat / bucketBeats) * bucketBeats,
        )
        const names = createNameLayer()
        const captureContext = { ...context, names }
        const captured = context.ctx.captureEventStrokeVectors(
            () => {
                for (const step of section.steps) draw(captureContext, step)
            },
            originTime,
            context.ups,
        )
        if (!captured) return
        // A mixed/unsupported section still keeps the ordinary pan cache; only
        // complete owned stroke groups survive UPS changes. Connections have no labels.
        const strokes = captured.eventStrokes?.length ? { originTime, ups: context.ups } : undefined
        return { captured, names, strokes }
    }

    private makeSectionRoom(graphics: number) {
        if (graphics > maxSectionGraphics) return false
        for (const [key, entry] of this.sections) {
            if (
                this.entries.size + this.sections.size < maxSectionRanges &&
                this.graphics + this.sectionGraphics + graphics <= maxSectionGraphics
            )
                return true
            if (entry.frame !== this.frame && !this.activeSectionKeys.has(key))
                this.removeSection(key, entry)
        }
        return (
            this.entries.size + this.sections.size < maxSectionRanges &&
            this.graphics + this.sectionGraphics + graphics <= maxSectionGraphics
        )
    }

    private removeSection(key: string, entry: SectionEntry) {
        this.context?.releaseVectors(entry.range)
        this.sections.delete(key)
        this.sectionGraphics -= entry.range.graphics
    }

    private releaseInactiveSections() {
        for (const [key, entry] of this.sections)
            if (entry.frame !== this.frame && !this.activeSectionKeys.has(key))
                this.removeSection(key, entry)
    }
}
