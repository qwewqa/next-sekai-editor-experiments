import assert from 'node:assert/strict'
import test from 'node:test'
import type { Chart } from '../../src/chart'
import type { GroupId } from '../../src/chart/groups'
import type { NoteObject } from '../../src/chart/note'
import type { StageId } from '../../src/chart/stages'
import { createNameLayer } from '../../src/editor/canvas/names'
import { orderEntities, toDrawSteps, type DrawStep } from '../../src/editor/canvas/ordering'
import type { DrawSection } from '../../src/editor/canvas/sections'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import { VectorRanges, type IdleScheduler } from '../../src/editor/canvas/vectorRanges'
import { createComposedLayout } from '../../src/editor/composed'
import { createScopeLookup } from '../../src/editor/scopeRules'
import type { RetainedVectors, WebGLDrawContext } from '../../src/rendering/context'
import { createState, type State } from '../../src/state'
import type { Entity, EntityType } from '../../src/state/entities'
import { beatToTime } from '../../src/state/integrals/bpms'
import { replaceBpm } from '../../src/state/mutations/bpm'
import { replaceStageTransformEventJoint } from '../../src/state/mutations/events/stage/transform'
import { replaceNote } from '../../src/state/mutations/slides/note'
import { createTransaction } from '../../src/state/transaction'

const groupId = 1 as GroupId
const stageId = 1 as StageId
const note = (beat: number, left: number): NoteObject => ({
    groupId,
    stageId,
    beat,
    left,
    size: 2,
    noteStyle: 'default',
    connectorStyle: 'default',
    noteType: 'default',
    isAttached: false,
    isCritical: false,
    flickDirection: 'none',
    isFake: false,
    sfx: 'default',
    isConnectorSeparator: false,
    connectorType: 'active',
    connectorEase: 'linear',
    connectorIsFake: false,
    connectorActiveIsCritical: false,
    connectorGuideAlpha: 1,
    connectorLayer: 'top',
    connectorIsPassThrough: false,
    connectorPresentation: 'default',
})

const fixture = (extraSlides: NoteObject[][] = []) => {
    const chart: Chart = {
        initialLife: 1000,
        isDynamicStages: true,
        bpms: [{ beat: 0, bpm: 120 }],
        groups: new Map([[groupId, { name: 'Group A' }]]),
        stages: new Map([
            [
                stageId,
                {
                    name: 'Stage A',
                    isFromStart: true,
                    isUntilEnd: true,
                    generateSimLines: 'global',
                },
            ],
        ]),
        cameraEvents: [],
        stageMaskEvents: [],
        stagePivotEvents: [],
        stageStyleEvents: [],
        stageTransformEvents: [0, 40].map((beat) => ({
            stageId,
            beat,
            rotation: 0,
            xTranslation: beat / 10,
            yTranslation: 0,
            elevation: 0,
            anchor: 'default',
            eventEase: 'linear',
        })),
        timeScales: [
            {
                groupId,
                beat: 2,
                editorLane: 0,
                timeScale: 1,
                skip: 0,
                timeScaleEase: 'linear',
                timeScaleTransition: 'timeScale',
                hideNotes: false,
            },
        ],
        // Separate beat buckets make the unaffected slide a distinct retained range.
        slides: [[note(0, -4), note(4, -2)], [note(32, 1), note(36, 3)], ...extraSlides],
    }
    return createState(chart, 0)
}

const entitiesOf = (state: State): Entity[] => [
    ...new Set(
        Object.values(state.store.grid).flatMap((grid) =>
            [...grid.values()].flatMap((bucket) => [...bucket]),
        ),
    ),
]

// Record draw inputs rather than emulating WebGL. Real state transactions,
// composition and painter ordering supply every dependency under test.
const command = (context: EditorDrawContext, step: DrawStep, hovered: ReadonlySet<Entity>) => {
    const { entity } = step
    let geometry: unknown
    if (entity.type === 'connector') {
        geometry = [entity.head, entity.tail].map((endpoint) => ({
            ...(context.composed?.connectorPosition(entity, endpoint.beat) ?? endpoint),
            y: beatToTime(context.state.bpms, endpoint.beat) * context.ups,
        }))
    } else if (entity.type === 'note') {
        geometry = context.composed?.notePosition(entity) ?? {
            left: entity.left,
            size: entity.size,
        }
    } else if (entity.type === 'stageTransformEventJoint') {
        geometry =
            entity.xTranslation + (context.composed?.offset(entity.stageId, entity.beat) ?? 0)
    } else if (entity.type === 'stageTransformEventConnection') {
        geometry = [entity.min, entity.max].map((joint) => [
            joint.xTranslation,
            beatToTime(context.state.bpms, joint.beat) * context.ups,
        ])
    } else if (entity.type === 'timeScale' && step.part === 'label') {
        geometry = context.state.groups.get(entity.groupId)?.name
    }
    return {
        ...step,
        // Hover affects live notes and name requests, not retained vector art.
        hovered: entity.type === 'note' && hovered.has(entity),
        y: beatToTime(context.state.bpms, entity.beat) * context.ups,
        geometry,
    }
}

type Command = ReturnType<typeof command>
type RecordedRange = RetainedVectors & {
    commands: Command[]
    origin?: readonly [number, number]
    points?: { from: number; to: number; y: number }[]
}

class RecordingRenderer {
    readonly resourceOwner = {}
    readonly canvas = { width: 1600, height: 1000 }
    readonly ranges: RecordedRange[] = []
    output: Command[] = []
    callbacks: Entity[] = []
    graphicsPerCommand = 1
    reusable = true
    pinBudget = Infinity
    rejectCapture = false
    rejectReplay = false
    rejectPointCapture = false
    rejectPointUpdate = false
    pointCaptures = 0
    readonly pointUpdates: { range: RecordedRange; ys: number[]; originY: number }[] = []
    matrix = { a: 40, b: 0, c: 0, d: 40, e: 100, f: 900 }
    fillStyle = '#000000'
    private recording?: Command[]
    private saved: { matrix: RecordingRenderer['matrix']; fillStyle: string }[] = []

    getTransform() {
        return this.matrix
    }

    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
        this.matrix = { a, b, c, d, e, f }
    }

    save() {
        this.saved.push({ matrix: this.matrix, fillStyle: this.fillStyle })
    }

    restore() {
        const state = this.saved.pop()
        if (state) ({ matrix: this.matrix, fillStyle: this.fillStyle } = state)
    }

    getLineDash() {
        return []
    }

    isContextLost() {
        return false
    }

    record(value: Command) {
        this.callbacks.push(value.entity)
        ;(this.recording ?? this.output).push(value)
    }

    captureVectors(draw: () => void, origin?: readonly [number, number]) {
        if (this.rejectCapture) return
        const commands: Command[] = []
        this.recording = commands
        try {
            draw()
        } finally {
            this.recording = undefined
        }
        // Only the retained ownership protocol is exercised; no native scene is needed.
        const graphics = commands.length * this.graphicsPerCommand
        const pinned = this.ranges.reduce(
            (total, range) => total + (range.reusable && !range.released ? range.graphics : 0),
            0,
        )
        const range = {
            commands,
            origin,
            owner: this.resourceOwner,
            graphics,
            reusable: this.reusable && pinned + graphics <= this.pinBudget,
            released: false,
        } as RecordedRange
        this.ranges.push(range)
        return range
    }

    capturePointVectors(points: readonly { y: number; draw: () => void }[], originY: number) {
        if (this.rejectPointCapture) return
        const anchors: NonNullable<RecordedRange['points']> = []
        const range = this.captureVectors(() => {
            for (const { y, draw } of points) {
                const from = this.recording!.length
                draw()
                anchors.push({ from, to: this.recording!.length, y })
            }
        }, [0, originY])
        if (range) {
            range.points = anchors
            this.pointCaptures++
        }
        return range
    }

    updateVectorPointPositions(range: RecordedRange, ys: ArrayLike<number>, originY: number) {
        assert.equal(range.released, false)
        assert.equal(range.points?.length, ys.length)
        if (this.rejectPointUpdate) return false
        if (!Number.isFinite(originY) || !Array.from(ys).every(Number.isFinite)) return false
        for (const [index, point] of range.points!.entries()) point.y = ys[index]!
        range.origin = [0, originY]
        this.pointUpdates.push({ range, ys: Array.from(ys), originY })
        return true
    }

    drawVectors(range: RecordedRange) {
        assert.equal(range.released, false, 'released geometry must never be replayed')
        if (this.rejectReplay) return false
        if (range.points)
            for (const { from, to, y } of range.points)
                this.output.push(
                    ...range.commands.slice(from, to).map((value) => ({
                        ...value,
                        y: value.y === 0 ? y : y + value.y,
                    })),
                )
        else this.output.push(...range.commands)
        // The real context owns unpinned captures until its frame flush.
        return true
    }

    releaseVectors(range: RecordedRange) {
        assert.equal(range.released, false, 'each retained range is released once')
        range.released = true
    }
}

const queueNames = (context: EditorDrawContext, step: DrawStep, hovered: ReadonlySet<Entity>) => {
    const { entity } = step
    const highlighted = step.highlighted || hovered.has(entity)
    if (!highlighted && !context.recentlyActive) return
    const texts: string[] = []
    if (
        (entity.type === 'note' || entity.type === 'stageTransformEventJoint') &&
        context.state.isDynamicStages &&
        context.showStageName
    ) {
        texts.push(context.state.stages.get(entity.stageId)?.name ?? '')
    }
    if (entity.type === 'note' && context.showGroupName)
        texts.push(context.state.groups.get(entity.groupId)?.name ?? '')
    for (const text of texts)
        context.names?.names.push({
            owner: entity,
            highlighted,
            text,
            x: 0,
            y: beatToTime(context.state.bpms, entity.beat) * context.ups,
            color: '#fff',
            size: 1,
            align: 'left',
            alpha: step.opacity,
        })
}

const harness = (composed: boolean) => {
    const renderer = new RecordingRenderer()
    const cache = new VectorRanges()
    const render = (
        state: State,
        hovered: ReadonlySet<Entity> = new Set(),
        recentlyActive = true,
        options: { liveEntities?: ReadonlySet<Entity>; previewState?: State } = {},
    ) => {
        const context: EditorDrawContext = {
            ctx: renderer as unknown as WebGLDrawContext,
            state,
            composed: composed ? createComposedLayout(state) : undefined,
            scale: 40,
            pixelRatio: 1,
            bounds: { l: -10, r: 10, t: -100, b: 0, w: 20, h: 100 },
            ups: -2,
            defaultGroupId: undefined,
            showStageName: true,
            showGroupName: true,
            nameContrast: false,
            recentlyActive,
            fontFamily: 'sans-serif',
            fontMiddle: 0.25,
            figureMiddle: 0.375,
            names: createNameLayer(),
        }
        const visibilities = Object.fromEntries(
            Object.keys(state.store.grid).map((type) => [type, true]),
        ) as Record<EntityType, boolean>
        const steps = toDrawSteps(
            orderEntities(entitiesOf(state), new Set(state.selectedEntities), {
                scope: createScopeLookup({}),
                visibilities,
                showOtherObjects: true,
            }),
        )
        // Match the editor caller: affected entities share the context used by
        // note preparation, while ordinary captures keep their private names.
        const previewContext = options.previewState && { ...context, state: options.previewState }
        const effectiveContext = (target: EditorDrawContext, step: DrawStep) =>
            previewContext && options.liveEntities?.has(step.entity) ? previewContext : target
        const callbacks: {
            step: DrawStep
            target: EditorDrawContext
            effective: EditorDrawContext
        }[] = []
        const draw = (ctx: EditorDrawContext, step: DrawStep) => {
            const effective = effectiveContext(ctx, step)
            callbacks.push({ step, target: ctx, effective })
            renderer.record(command(effective, step, hovered))
            queueNames(effective, step, hovered)
        }
        renderer.output = []
        renderer.callbacks = []
        const before = { ...cache.stats }
        cache.beginFrame(context, ['background', 1])
        cache.prepare(steps.objects, steps.raisedAt, options.liveEntities)
        const releasedAfterPrepare = renderer.ranges.filter(({ released }) => released)
        cache.draw(context, steps.objects, 0, steps.raisedAt, 'normal', hovered, draw)
        cache.draw(
            context,
            steps.objects,
            steps.raisedAt,
            steps.objects.length,
            'raised',
            hovered,
            draw,
        )
        // BPM/time-scale labels and notes remain live, as in the editor caller.
        for (const step of steps.labels) draw(context, step)
        cache.endFrame()
        const allSteps = [...steps.objects, ...steps.labels]
        const expectedNames = createNameLayer()
        for (const step of allSteps)
            queueNames({ ...effectiveContext(context, step), names: expectedNames }, step, hovered)
        assert.deepEqual(
            renderer.output,
            allSteps.map((step) => command(effectiveContext(context, step), step, hovered)),
            'retained commands preserve the uncached painter order and current geometry',
        )
        assert.deepEqual(
            context.names,
            expectedNames,
            'retained and live names are appended exactly once in painter order',
        )
        return {
            context,
            previewContext,
            callbackContexts: callbacks,
            releasedAfterPrepare,
            output: renderer.output,
            callbacks: renderer.callbacks,
            captures: cache.stats.captures - before.captures,
            replays: cache.stats.replays - before.replays,
            vectors: steps.objects.filter(({ entity }) => entity.type !== 'note'),
        }
    }
    return { render, cache, renderer }
}

for (const composed of [false, true]) {
    const mode = composed ? 'composed' : 'basic'
    test(`${mode}: note edits and undo replay unaffected ranges and recapture the edited connector`, () => {
        const state = fixture()
        const { render } = harness(composed)
        const original = render(state)
        const notes = [...state.store.slides.note.values()]
        const moved = notes[0]![1]!
        const unchanged = [...state.store.slides.connector.values()][1]![0]!
        const transaction = createTransaction(state)
        replaceNote(transaction, moved, { ...moved, left: moved.left + 1 })
        const edited = transaction.commit([])
        const changed = edited.store.slides.connector.get(moved.slideId)![0]!
        assert.notEqual(changed, state.store.slides.connector.get(moved.slideId)![0])
        assert.equal(edited.store.slides.connector.get(unchanged.head.slideId)![0], unchanged)
        const frame = render(edited)
        if (composed) {
            assert.notEqual(frame.context.composed, original.context.composed)
            assert.equal(frame.context.composed?.stages, original.context.composed?.stages)
        }
        assert.equal(frame.captures, 1)
        assert.equal(frame.replays, original.captures - 1)
        assert.ok(frame.callbacks.includes(changed))
        assert.ok(!frame.callbacks.includes(unchanged))
        assert.ok(frame.callbacks.includes(edited.store.slides.note.get(moved.slideId)![1]!))
        const undo = render(state)
        assert.equal(undo.captures, 1)
        assert.equal(undo.replays, original.captures - 1)
        assert.ok(!undo.callbacks.includes(unchanged))
        assert.deepEqual(undo.output, original.output)
    })

    test(`${mode}: metadata and group-name edits preserve vectors while live names update`, () => {
        const state = fixture()
        const { render } = harness(composed)
        const original = render(state)
        const updated: State = {
            ...state,
            levelInfo: { ...state.levelInfo, title: 'renamed' },
            initialLife: 500,
            bgm: { offset: 0.5 },
            groups: new Map([[groupId, { name: 'Renamed Group' }]]),
            selectedEntities: [],
        }
        const frame = render(updated)
        assert.equal(frame.captures, 0)
        assert.equal(frame.replays, original.captures)
        assert.ok(frame.context.names?.names.some(({ text }) => text === 'Renamed Group'))
        assert.ok(!frame.context.names?.names.some(({ text }) => text === 'Group A'))
        assert.ok(
            frame.callbacks.every(
                (entity) =>
                    entity.type === 'note' || entity.type === 'bpm' || entity.type === 'timeScale',
            ),
        )
    })

    test(`${mode}: idle, active and hover transitions update names without recapturing geometry`, () => {
        const state = fixture()
        const { render } = harness(composed)
        const original = render(state, new Set(), false)
        assert.equal(original.context.names?.names.length, 0)
        const active = render(state)
        assert.equal(active.captures, 0)
        assert.equal(active.replays, original.captures)
        assert.ok(active.context.names?.names.some(({ text }) => text === 'Stage A'))
        const inactive = render(state, new Set(), false)
        assert.equal(inactive.captures, 0)
        assert.equal(inactive.context.names?.names.length, 0)

        const joint = [...state.store.grid.stageTransformEventJoint.values()][0]!
            .values()
            .next().value!
        const hover = render(state, new Set([joint]), false)
        assert.equal(hover.captures, 0)
        assert.equal(hover.replays, original.captures)
        assert.deepEqual(
            hover.context.names?.names.map(({ owner, highlighted, text }) => ({
                owner,
                highlighted,
                text,
            })),
            [{ owner: joint, highlighted: true, text: 'Stage A' }],
        )
        const leave = render(state, new Set(), false)
        assert.equal(leave.captures, 0)
        assert.equal(leave.context.names?.names.length, 0, 'hover never mutates cached metadata')

        const selected = createTransaction(state).commit([joint])
        const selection = render(selected, new Set(), false)
        assert.ok(selection.captures > 0, 'selection still changes painter membership')
        assert.ok(
            selection.context.names?.names.some(
                ({ owner, highlighted }) => owner === joint && highlighted,
            ),
        )
        const selectedActive = render(selected)
        assert.equal(selectedActive.captures, 0)
        const selectedIdle = render(selected, new Set(), false)
        assert.equal(selectedIdle.captures, 0)
        assert.deepEqual(selectedIdle.context.names, selection.context.names)
    })

    test(`${mode}: a preview releases its whole range before drawing and preserves unrelated raised ranges`, () => {
        const originalState = fixture([[note(8, -1), note(12, 1)]])
        const [affected, raised, sibling] = [...originalState.store.slides.connector.values()].map(
            (connectors) => connectors[0]!,
        )
        assert.ok(affected && raised && sibling)
        const state = createTransaction(originalState).commit([raised])
        const { render, renderer } = harness(composed)
        const original = render(state)
        const oldRange = renderer.ranges.find(({ commands }) =>
            commands.some(({ entity }) => entity === affected),
        )!
        const raisedRange = renderer.ranges.find(({ commands }) =>
            commands.some(({ entity }) => entity === raised),
        )!
        assert.ok(oldRange.commands.some(({ entity }) => entity === sibling))
        assert.notEqual(oldRange, raisedRange)
        const options = { liveEntities: new Set<Entity>([affected]), previewState: { ...state } }
        const preview = render(state, new Set(), true, options)
        assert.ok(
            preview.releasedAfterPrepare.includes(oldRange),
            'the affected entry is released before the first live draw',
        )
        assert.equal(raisedRange.released, false)
        assert.equal(preview.captures, 0)
        assert.equal(preview.replays, original.captures - 1)
        assert.ok(!preview.callbacks.includes(raised), 'the raised pass still replays')
        for (const entity of [affected, sibling]) {
            const callback = preview.callbackContexts.find(({ step }) => step.entity === entity)!
            assert.equal(callback.target, preview.context, 'every member of the range stays live')
            assert.equal(
                callback.effective,
                entity === affected ? preview.previewContext : preview.context,
            )
        }
        assert.deepEqual(preview.output, original.output)
        const ongoing = render(state, new Set(), true, options)
        assert.equal(ongoing.captures, 0, 'continued preview never creates a disposable capture')
        assert.equal(ongoing.replays, original.captures - 1)
        assert.equal(renderer.ranges.length, original.captures)

        const ended = render(state)
        assert.equal(ended.captures, 1, 'omitting the live set recaptures only the affected range')
        assert.equal(ended.replays, original.captures - 1)
        assert.equal(raisedRange.released, false)
        assert.deepEqual(ended.output, original.output)
        const warm = render(state)
        assert.equal(warm.captures, 0)
        assert.equal(warm.replays, original.captures)
    })

    test(`${mode}: live preview notes share preparation context while captures keep private names and activity`, () => {
        const state = fixture()
        const affectedNote = [...state.store.slides.note.values()][0]![1]!
        const affectedConnector = [...state.store.slides.connector.values()][0]![0]!
        const liveEntities = new Set<Entity>([affectedNote, affectedConnector])
        const previewState = {
            ...state,
            groups: new Map([[groupId, { name: 'Preview Group' }]]),
        }
        const { render } = harness(composed)
        const options = { liveEntities, previewState }
        const idle = render(state, new Set(), false, options)
        assert.equal(idle.context.names?.names.length, 0)
        for (const entity of liveEntities) {
            const callback = idle.callbackContexts.find(({ step }) => step.entity === entity)!
            assert.equal(callback.target, idle.context)
            assert.equal(callback.effective, idle.previewContext)
            assert.equal(callback.effective.state, previewState)
            assert.equal(callback.effective.names, idle.context.names)
            assert.equal(callback.effective.recentlyActive, false)
        }
        const capturedJoint = idle.callbackContexts.find(
            ({ step }) => step.entity.type === 'stageTransformEventJoint',
        )!
        assert.notEqual(capturedJoint.target, idle.context)
        assert.equal(capturedJoint.effective, capturedJoint.target)
        assert.notEqual(capturedJoint.effective.names, idle.context.names)
        assert.equal(capturedJoint.effective.recentlyActive, true)
        assert.ok(capturedJoint.effective.names?.names.some(({ text }) => text === 'Stage A'))

        const hover = render(state, new Set([affectedNote]), false, options)
        assert.equal(hover.captures, 0)
        assert.deepEqual(
            hover.context.names?.names.map(({ owner, highlighted, text }) => ({
                owner,
                highlighted,
                text,
            })),
            ['Stage A', 'Preview Group'].map((text) => ({
                owner: affectedNote,
                highlighted: true,
                text,
            })),
        )
        const active = render(state, new Set(), true, options)
        assert.equal(active.captures, 0)
        assert.deepEqual(
            active.context.names?.names
                .filter(({ owner }) => owner === affectedNote)
                .map(({ text }) => text),
            ['Stage A', 'Preview Group'],
            'live names use preview metadata once, in painter order',
        )
    })

    test(`${mode}: live notes alone preserve vector entries and clearing a preview leaves no live-set residue`, () => {
        const state = fixture()
        const affected = [...state.store.slides.note.values()][0]![1]!
        const { render, renderer, cache } = harness(composed)
        const original = render(state)
        const ranges = [...renderer.ranges]
        const frame = render(state, new Set(), true, {
            liveEntities: new Set([affected]),
            previewState: { ...state },
        })
        assert.equal(frame.captures, 0)
        assert.equal(frame.replays, original.captures)
        assert.ok(ranges.every(({ released }) => !released))
        assert.equal(
            frame.callbackContexts.find(({ step }) => step.entity === affected)?.effective,
            frame.previewContext,
        )
        cache.clear()
        assert.ok(ranges.every(({ released }) => released))
        const restarted = render(state)
        assert.equal(restarted.captures, original.captures)
        assert.equal(restarted.replays, 0)
        assert.deepEqual(restarted.output, original.output)
    })
}

test('retained captures use beat-bucket origins independent of pan and derived from current tempo', () => {
    const state = fixture()
    const { render, renderer, cache } = harness(false)
    const original = render(state)
    const origins = renderer.ranges.map(({ commands, origin }) => {
        const first = commands[0]!
        assert.deepEqual(origin, [
            0,
            beatToTime(state.bpms, 16 * Math.floor(first.entity.beat / 16)) * original.context.ups,
        ])
        return origin
    })
    renderer.matrix = { ...renderer.matrix, e: -373.25, f: 8123.5 }
    assert.equal(render(state).captures, 0, 'pan replays the same canonical captures')
    cache.clear()
    renderer.ranges.length = 0
    render(state)
    assert.deepEqual(
        renderer.ranges.map(({ origin }) => origin),
        origins,
    )

    const bpm = [...state.store.grid.bpm.values()][0]!.values().next().value!
    const transaction = createTransaction(state)
    replaceBpm(transaction, bpm, { ...bpm, bpm: 180 })
    const changed = transaction.commit([])
    renderer.ranges.length = 0
    render(changed)
    for (const { commands, origin } of renderer.ranges)
        assert.deepEqual(origin, [
            0,
            beatToTime(changed.bpms, 16 * Math.floor(commands[0]!.entity.beat / 16)) *
                original.context.ups,
        ])
    assert.notDeepEqual(
        renderer.ranges.map(({ origin }) => origin),
        origins,
    )
})

test('retained ranges stop at 192, release overflow after presentation and invalidate full caches', () => {
    const state = fixture(
        Array.from({ length: 205 }, (_, i) => [note(64 + i * 32, -2), note(68 + i * 32, 2)]),
    )
    const { render, renderer, cache } = harness(false)
    render(state)
    assert.equal(cache.stats.ranges, 192)
    assert.ok(cache.stats.declined > 0)
    const retained = renderer.ranges.filter(({ released }) => !released)
    assert.equal(retained.length, 192)
    assert.equal(renderer.ranges.length - retained.length, cache.stats.declined)
    const declined = cache.stats.declined
    const warm = render(state)
    assert.equal(warm.captures, 0)
    assert.equal(warm.replays, 192)
    assert.equal(cache.stats.declined, declined * 2)
    assert.equal(renderer.ranges.filter(({ released }) => !released).length, 192)

    // Zoom invalidation must release every old pin before replacing a full cache.
    renderer.matrix = { ...renderer.matrix, a: 80, d: 80 }
    const zoomed = render(state)
    assert.equal(zoomed.captures, 192)
    assert.equal(zoomed.replays, 0)
    assert.ok(retained.every(({ released }) => released))
    cache.clear()
    assert.ok(renderer.ranges.every(({ released }) => released))
    cache.clear()
})

test('the 20000-primitive bound still limits ranges before the enlarged group capacity', () => {
    const state = fixture(
        Array.from({ length: 205 }, (_, i) => [note(64 + i * 32, -2), note(68 + i * 32, 2)]),
    )
    const { render, renderer, cache } = harness(false)
    renderer.graphicsPerCommand = 250
    render(state)
    assert.equal(cache.stats.graphics, 20000)
    assert.ok(cache.stats.ranges < 192)
    assert.ok(cache.stats.declined > 0)
    const live = renderer.ranges.filter(({ released }) => !released)
    assert.equal(
        live.reduce((total, range) => total + range.graphics, 0),
        20000,
    )
    const warm = render(state)
    assert.equal(warm.captures, 0)
    assert.equal(warm.replays, live.length)
    assert.equal(cache.stats.graphics, 20000)
    cache.clear()
    assert.ok(renderer.ranges.every(({ released }) => released))
})

test('selection changes recapture affected membership while hover preserves vector art and name order', () => {
    const state = fixture()
    const { render } = harness(false)
    const original = render(state)
    const connector = [...state.store.slides.connector.values()][0]![0]!
    const selected = createTransaction(state).commit([connector])
    const selection = render(selected)
    assert.equal(selection.captures, 1)
    assert.equal(selection.replays, original.captures - 1)
    assert.equal(
        selection.vectors.at(-1)?.entity,
        connector,
        'selected connector moves above normal notes',
    )
    assert.equal(selection.output.find(({ entity }) => entity === connector)?.highlighted, true)
    const hovered = render(selected, new Set([connector]))
    assert.equal(hovered.captures, 0)
    assert.equal(hovered.replays, original.captures)
    assert.equal(hovered.output.find(({ entity }) => entity === connector)?.hovered, false)
    const restored = render(state)
    assert.equal(restored.captures, 1)
    assert.deepEqual(restored.output, original.output)
})

test('stage definition and name changes invalidate unchanged entities and queued stage names', () => {
    const state = fixture()
    const { render, renderer } = harness(false)
    const original = render(state)
    const oldRanges = [...renderer.ranges]
    const changed: State = { ...state, stages: new Map(state.stages) }
    changed.stages.set(stageId, {
        ...state.stages.get(stageId)!,
        name: 'Renamed Stage',
        isFromStart: false,
    })
    assert.deepEqual(entitiesOf(changed), entitiesOf(state))
    const frame = render(changed)
    assert.equal(frame.captures, original.captures)
    assert.equal(frame.replays, 0)
    assert.ok(oldRanges.every((range) => range.released))
    assert.ok(frame.context.names?.names.some(({ text }) => text === 'Renamed Stage'))
    assert.ok(!frame.context.names?.names.some(({ text }) => text === 'Stage A'))
})

test('dynamic-stage mode invalidates basic-view ranges even without a composed layout', () => {
    const state = fixture()
    const { render } = harness(false)
    const original = render(state)
    const frame = render({ ...state, isDynamicStages: false })
    assert.equal(frame.captures, original.captures)
    assert.equal(frame.replays, 0)
    assert.ok(!frame.context.names?.names.some(({ text }) => text === 'Stage A'))
})

test('BPM transactions invalidate unchanged connectors and their beat-to-time geometry', () => {
    const state = fixture()
    const { render } = harness(false)
    const original = render(state)
    const bpm = [...state.store.grid.bpm.values()][0]!.values().next().value!
    const transaction = createTransaction(state)
    replaceBpm(transaction, bpm, { beat: bpm.beat, bpm: 180 })
    const edited = transaction.commit([])
    const connector = [...state.store.slides.connector.values()][0]![0]!
    assert.equal(edited.store.slides.connector.get(connector.head.slideId)![0], connector)
    const frame = render(edited)
    assert.equal(frame.captures, original.captures)
    assert.equal(frame.replays, 0)
    assert.notDeepEqual(
        frame.output.find(({ entity }) => entity === connector)?.geometry,
        original.output.find(({ entity }) => entity === connector)?.geometry,
    )
})

test('composed stage-event edits invalidate unchanged connector geometry through the stage layout', () => {
    const state = fixture()
    const { render } = harness(true)
    const original = render(state)
    const joint = [...state.store.grid.stageTransformEventJoint.values()][0]!.values().next().value!
    const transaction = createTransaction(state)
    replaceStageTransformEventJoint(transaction, joint, {
        ...joint,
        xTranslation: joint.xTranslation + 3,
    })
    const edited = transaction.commit([])
    const connector = [...state.store.slides.connector.values()][0]![0]!
    assert.equal(edited.bpms, state.bpms)
    assert.equal(edited.stages, state.stages)
    assert.equal(edited.store.slides.connector.get(connector.head.slideId)![0], connector)
    const frame = render(edited)
    assert.notEqual(frame.context.composed?.stages, original.context.composed?.stages)
    assert.equal(frame.captures, original.captures)
    assert.equal(frame.replays, 0)
    assert.notDeepEqual(
        frame.output.find(({ entity }) => entity === connector)?.geometry,
        original.output.find(({ entity }) => entity === connector)?.geometry,
    )
})

const sectionOf = (
    key: string,
    steps: DrawStep[],
    pass: DrawSection['pass'] = 'normal',
): DrawSection => ({
    key,
    steps,
    pass,
    minBeat: Math.min(...steps.map(({ entity }) => entity.beat)),
    maxBeat: Math.max(...steps.map(({ entity }) => entity.beat)),
})

const sectionHarness = (state: State, idle?: IdleScheduler) => {
    const renderer = new RecordingRenderer()
    const cache = new VectorRanges(idle)
    const base: EditorDrawContext = {
        ctx: renderer as unknown as WebGLDrawContext,
        state,
        scale: 40,
        pixelRatio: 1,
        bounds: { l: -10, r: 10, t: -100, b: 0, w: 20, h: 100 },
        ups: -2,
        defaultGroupId: undefined,
        showStageName: true,
        showGroupName: true,
        nameContrast: false,
        recentlyActive: true,
        fontFamily: 'sans-serif',
        fontMiddle: 0.25,
        figureMiddle: 0.375,
    }
    const render = (
        plan: readonly DrawSection[],
        active: readonly DrawSection[],
        options: {
            hovered?: ReadonlySet<Entity>
            visibleOwners?: ReadonlySet<Entity>
            recentlyActive?: boolean
            legacy?: boolean
            state?: State
            ups?: number
        } = {},
    ) => {
        const hovered = options.hovered ?? new Set<Entity>()
        const context = {
            ...base,
            state: options.state ?? state,
            ups: options.ups ?? base.ups,
            recentlyActive: options.recentlyActive ?? true,
            names: createNameLayer(),
        }
        const draw = (target: EditorDrawContext, step: DrawStep) => {
            renderer.record(command(target, step, hovered))
            queueNames(target, step, hovered)
        }
        renderer.output = []
        renderer.callbacks = []
        const before = { ...cache.stats }
        cache.beginFrame(context, [])
        if (options.legacy) {
            const steps = active.flatMap((section) => section.steps)
            cache.prepare(steps, steps.length)
            cache.draw(context, steps, 0, steps.length, 'normal', hovered, draw)
        } else {
            cache.prepareSections(plan, active)
            for (const section of active)
                cache.drawSection(context, section, hovered, draw, options.visibleOwners)
        }
        // Model the real renderer's flush, which recycles unpinned one-shots.
        for (const range of renderer.ranges)
            if (!range.reusable && !range.released) renderer.releaseVectors(range)
        cache.endFrame()
        const steps = active.flatMap((section) => section.steps)
        assert.deepEqual(
            renderer.output,
            steps.map((step) => command(context, step, hovered)),
        )
        const expectedNames = createNameLayer()
        for (const step of steps)
            if (!options.visibleOwners || options.visibleOwners.has(step.entity))
                queueNames({ ...context, names: expectedNames }, step, hovered)
        assert.deepEqual(context.names, expectedNames)
        return {
            context,
            captures: cache.stats.captures - before.captures,
            replays: cache.stats.replays - before.replays,
            declined: cache.stats.declined - before.declined,
            callbacks: [...renderer.callbacks],
        }
    }
    return { render, renderer, cache, base }
}

const vectorSections = (state: State) =>
    [...state.store.slides.connector.values()].map((connectors, index) =>
        sectionOf(
            `connector:${index}`,
            connectors.map((entity) => ({
                entity,
                highlighted: false,
                raised: false,
                opacity: 1,
            })),
        ),
    )

test('complete vector sections survive offscreen frames and legacy preview fallback', () => {
    const state = fixture()
    const plan = vectorSections(state)
    const [first, second] = plan as [DrawSection, DrawSection]
    const { render, renderer, cache } = sectionHarness(state)
    assert.equal(render(plan, [first]).captures, 1)
    const original = renderer.ranges[0]!
    assert.equal(render(plan, [second]).captures, 1)
    assert.equal(original.released, false, 'pan does not release the preceding complete section')
    assert.equal(cache.stats.ranges, 2)
    assert.equal(render(plan, [], { legacy: true }).captures, 0)
    assert.equal(
        original.released,
        false,
        'legacy prepare/endFrame cannot prune persistent sections',
    )
    const legacy = render(plan, [first], { legacy: true })
    assert.equal(legacy.captures, 1)
    assert.equal(original.released, false)
    const resumed = render(plan, [first])
    assert.equal(resumed.captures, 0)
    assert.equal(resumed.replays, 1)
    assert.deepEqual(resumed.callbacks, [], 'unchanged replay never traverses the source steps')
    assert.equal(renderer.ranges.at(-1)!.released, true, 'unused legacy captures still expire')
    cache.clear()
    assert.ok(renderer.ranges.every(({ released }) => released))
})

test('complete section identity detects same-count replacements and prunes removed chart sections', () => {
    const state = fixture()
    const plan = vectorSections(state)
    const { render, renderer, cache } = sectionHarness(state)
    render(plan, plan)
    const [oldFirst, oldSecond] = renderer.ranges
    const step = plan[0]!.steps[0]!
    const replacement = sectionOf(plan[0]!.key, [{ ...step, opacity: 0.25 }])
    const next = [replacement, plan[1]!]
    const frame = render(next, next)
    assert.equal(frame.captures, 1)
    assert.equal(frame.replays, 1)
    assert.equal(oldFirst!.released, true)
    assert.equal(oldSecond!.released, false)
    assert.equal(render(next, next).captures, 0)
    render([], [])
    assert.equal(cache.stats.ranges, 0)
    assert.ok(renderer.ranges.every(({ released }) => released))
})

test('complete section names use exact visible owners and current hover/activity without metadata mutation', () => {
    const state = fixture()
    const joints = [...state.store.grid.stageTransformEventJoint.values()].flatMap((set) => [
        ...set,
    ])
    const steps = joints.map((entity) => ({
        entity,
        highlighted: false,
        raised: false,
        opacity: 1,
    }))
    const section = sectionOf('joint-names', steps)
    const plan = [section]
    const { render } = sectionHarness(state)
    const first = joints[0]!,
        second = joints[1]!
    const active = render(plan, plan, { visibleOwners: new Set([first]) })
    assert.deepEqual(
        active.context.names.names.map(({ owner }) => owner),
        [first],
    )
    const hovered = render(plan, plan, {
        recentlyActive: false,
        hovered: new Set(joints),
        visibleOwners: new Set([second]),
    })
    assert.equal(hovered.captures, 0)
    assert.deepEqual(
        hovered.context.names.names.map(({ owner }) => owner),
        [second],
    )
    assert.equal(hovered.context.names.names[0]!.highlighted, true)
    assert.equal(render(plan, plan, { recentlyActive: false }).context.names.names.length, 0)
    assert.equal(render(plan, plan, { visibleOwners: new Set() }).context.names.names.length, 0)
    assert.equal(render(plan, plan).context.names.names.length, 2)
})

test('complete section capture/replay refusal preserves live output and filters offscreen names', () => {
    const state = fixture()
    const joint = [...state.store.grid.stageTransformEventJoint.values()][0]!.values().next().value!
    const section = sectionOf('joint', [
        { entity: joint, highlighted: false, raised: false, opacity: 1 },
    ])
    const plan = [section]
    const { render, renderer, cache } = sectionHarness(state)
    renderer.rejectCapture = true
    assert.equal(render(plan, plan, { visibleOwners: new Set() }).declined, 1)
    assert.equal(cache.stats.ranges, 0)
    renderer.rejectCapture = false
    render(plan, plan)
    const retained = renderer.ranges[0]!
    renderer.rejectReplay = true
    assert.equal(render(plan, plan, { visibleOwners: new Set() }).captures, 0)
    assert.equal(retained.released, true)
    assert.equal(cache.stats.ranges, 0)
    renderer.rejectReplay = false
    renderer.reusable = false
    assert.equal(render(plan, plan, { visibleOwners: new Set() }).declined, 1)
    assert.equal(cache.stats.ranges, 0, 'path pin refusal never becomes persistent ownership')
    assert.equal(renderer.ranges.at(-1)!.released, true)
})

test('complete sections evict only inactive LRU groups and protect upcoming active ranges', () => {
    const state = fixture(
        Array.from({ length: 1023 }, (_, i) => [note(64 + i * 32, -2), note(68 + i * 32, 2)]),
    )
    const plan = vectorSections(state)
    assert.equal(plan.length, 1025)
    const { render, renderer, cache } = sectionHarness(state)
    render(plan, plan.slice(0, 1024))
    assert.equal(cache.stats.ranges, 1024)
    const first = renderer.ranges[0]!,
        second = renderer.ranges[1]!
    const frame = render(plan, [plan[1024]!, plan[0]!])
    assert.equal(frame.replays, 1)
    assert.equal(frame.captures, 1)
    assert.equal(first.released, false, 'an active range is protected before it has been queued')
    assert.equal(second.released, true, 'the oldest unused section is evicted first')
    const all = render(plan, plan)
    assert.ok(all.declined > 0, 'one extra visible section uses a one-shot at the hard cap')
    assert.equal(cache.stats.ranges, 1024)
    assert.equal(renderer.ranges.filter(({ released }) => !released).length, 1024)
    cache.clear()
    assert.ok(renderer.ranges.every(({ released }) => released))
})

test('path pin refusal renders once and releases only inactive pins for the next frame', () => {
    const state = fixture([
        [note(64, -2), note(68, 2)],
        [note(96, -2), note(100, 2)],
    ])
    const plan = vectorSections(state)
    const { render, renderer, cache } = sectionHarness(state)
    renderer.pinBudget = 3
    render(plan, plan.slice(0, 3))
    const [inactive, queued, upcoming] = renderer.ranges
    const active = [plan[1]!, plan[3]!, plan[2]!]
    const pressured = render(plan, active)
    assert.equal(pressured.captures, 0)
    assert.equal(pressured.replays, 2)
    assert.equal(pressured.declined, 1)
    assert.equal(renderer.ranges.length, 4, 'the refused capture is not rebuilt within this frame')
    assert.equal(inactive!.released, true)
    assert.equal(queued!.released, false, 'already queued geometry keeps its pin')
    assert.equal(upcoming!.released, false, 'active geometry not yet queued keeps its pin')
    assert.equal(renderer.ranges[3]!.reusable, false)
    assert.equal(
        renderer.ranges[3]!.released,
        true,
        'the context recycles the one-shot after flush',
    )
    assert.equal(cache.stats.ranges, 2)
    const recovered = render(plan, active)
    assert.equal(recovered.captures, 1, 'freeing inactive pins admits the new section next frame')
    assert.equal(recovered.replays, 2)
    assert.equal(recovered.declined, 0)
    assert.equal(cache.stats.ranges, 3)
    const warm = render(plan, active)
    assert.equal(warm.captures, 0)
    assert.equal(warm.replays, 3)
    cache.clear()
    assert.ok(renderer.ranges.every(({ released }) => released))
})

test('legacy preview admission evicts inactive sections at the shared primitive cap and cancel reuses survivors', () => {
    const state = fixture([
        [note(64, -2), note(68, 2)],
        [note(96, -2), note(100, 2)],
        [note(128, -2), note(132, 2)],
    ])
    const plan = vectorSections(state)
    const { render, renderer, cache } = sectionHarness(state)
    renderer.graphicsPerCommand = 10000
    render(plan, plan)
    assert.equal(cache.stats.graphics, 50000)
    const retained = [...renderer.ranges]
    const preview = render(plan, [plan[0]!], { legacy: true })
    assert.equal(preview.captures, 1, 'legacy geometry can replace an inactive persistent section')
    assert.equal(preview.declined, 0)
    assert.equal(cache.stats.graphics, 50000, 'the shared cap remains unchanged')
    assert.equal(retained[0]!.released, true)
    assert.ok(retained.slice(1).every(({ released }) => !released))
    const previewRange = renderer.ranges.at(-1)!
    const cancelled = render(plan, [plan[1]!])
    assert.equal(cancelled.captures, 0)
    assert.equal(cancelled.replays, 1, 'cancel preserves unaffected committed section captures')
    assert.equal(previewRange.released, true, 'unused legacy geometry still expires after flush')
    assert.equal(cache.stats.graphics, 40000)
    assert.equal(render(plan, [plan[0]!]).captures, 1, 'only the evicted section needs rebuilding')
    cache.clear()
    assert.ok(renderer.ranges.every(({ released }) => released))
})

test('complete section primitive limits, zoom and metadata invalidation release all retained pins', () => {
    const state = fixture([[note(64, -2), note(68, 2)]])
    const plan = vectorSections(state)
    const { render, renderer, cache } = sectionHarness(state)
    renderer.graphicsPerCommand = 25000
    const first = render(plan, plan)
    assert.equal(first.captures, 2)
    assert.equal(first.declined, 1)
    assert.equal(cache.stats.graphics, 50000)
    const old = renderer.ranges.filter(({ released }) => !released)
    renderer.matrix = { ...renderer.matrix, a: 80, d: 80 }
    render(plan, [plan[0]!])
    assert.ok(
        old.every(({ released }) => released),
        'zoom releases all old pinned sections',
    )
    const zoomed = renderer.ranges.at(-1)!
    render(plan, [plan[0]!], { state: { ...state, stages: new Map(state.stages) } })
    assert.equal(zoomed.released, true, 'shared stage metadata invalidates unchanged membership')
    cache.clear()
    assert.ok(renderer.ranges.every(({ released }) => released))
})

const jointSteps = (state: State) =>
    [...state.store.grid.stageTransformEventJoint.values()]
        .flatMap((bucket) => [...bucket])
        .map((entity): DrawStep => ({ entity, highlighted: false, raised: false, opacity: 1 }))

test('point sections reuse fixed artwork through first-use fractional PPS and preserve old names', () => {
    const state = fixture()
    const steps = jointSteps(state)
    const plan = [sectionOf('points', steps)]
    const { render, renderer, cache } = sectionHarness(state)
    const first = render(plan, plan)
    const range = renderer.ranges[0]!
    const oldNames = structuredClone(first.context.names.names.map(({ y }) => y))
    for (const ups of [-2.0037, -2.13731, -1.91357, -3.00743]) {
        const frame = render(plan, plan, { ups })
        assert.equal(frame.captures, 0)
        assert.equal(frame.replays, 1)
        assert.deepEqual(frame.callbacks, [], 'new PPS values do not redraw point artwork')
        assert.equal(renderer.pointUpdates.at(-1)!.range, range)
        assert.deepEqual(
            renderer.pointUpdates.at(-1)!.ys,
            steps.map(({ entity }) => beatToTime(state.bpms, entity.beat) * ups),
        )
        assert.deepEqual(
            first.context.names.names.map(({ y }) => y),
            oldNames,
        )
    }
    assert.equal(renderer.pointCaptures, 1)
    assert.ok(
        range.commands.every(({ y }) => y === 0),
        'captured artwork stays local to its anchor',
    )
    cache.clear()
    assert.equal(range.released, true)
})

test('all reviewed point types and parts use independent time anchors', () => {
    const state = fixture()
    const joint = jointSteps(state)[0]!.entity
    const bpm = entitiesOf(state).find((entity) => entity.type === 'bpm')!
    const timeScale = entitiesOf(state).find((entity) => entity.type === 'timeScale')!
    const steps: DrawStep[] = [
        ...(
            [
                'cameraEventJoint',
                'stageMaskEventJoint',
                'stagePivotEventJoint',
                'stageStyleEventJoint',
                'stageTransformEventJoint',
            ] as const
        ).map((type, index) => ({
            entity: { ...joint, type, beat: 2 ** 20 + index + 0.125 } as Entity,
            highlighted: false,
            raised: false,
            opacity: 0.25,
        })),
        { entity: bpm, highlighted: false, raised: false, opacity: 1, part: 'line' },
        { entity: timeScale, highlighted: false, raised: false, opacity: 1, part: 'line' },
        { entity: timeScale, highlighted: false, raised: false, opacity: 1, part: 'marker' },
    ]
    const plan = steps.map((step, index) => sectionOf(`point:${index}`, [step]))
    const { render, renderer, cache } = sectionHarness(state)
    render(plan, plan)
    const changed = render(plan, plan, { ups: -3.14159 })
    assert.equal(changed.captures, 0)
    assert.equal(changed.replays, plan.length)
    assert.equal(renderer.pointCaptures, plan.length)
    assert.equal(renderer.pointUpdates.length, plan.length)
    for (const [index, update] of renderer.pointUpdates.entries())
        assert.equal(
            update.originY,
            beatToTime(state.bpms, Math.floor(plan[index]!.minBeat / 16) * 16) * -3.14159,
        )
    cache.clear()
})

test('PPS changes release legacy and spanning vectors while retaining point sections offscreen', () => {
    const state = fixture()
    const point = sectionOf('point', jointSteps(state))
    const connection = vectorSections(state)[0]!
    const plan = [point, connection]
    const { render, renderer, cache } = sectionHarness(state)
    render(plan, plan)
    const [pointRange, connectionRange] = renderer.ranges
    render(plan, [point], { legacy: true })
    const legacy = renderer.ranges.at(-1)!
    assert.equal(legacy.points, undefined, 'legacy previews never use point capture')
    render(plan, [], { ups: -2.13731 })
    assert.equal(pointRange!.released, false)
    assert.equal(connectionRange!.released, true)
    assert.equal(legacy.released, true)
    render(plan, [], { ups: -3.00743 })
    assert.equal(renderer.pointUpdates.length, 0, 'offscreen anchors are not traversed during zoom')
    const returned = render(plan, plan, { ups: -3.00743 })
    assert.equal(returned.captures, 1, 'only the spanning connection needs recapture')
    assert.equal(returned.replays, 1)
    assert.equal(renderer.pointUpdates.length, 1)
    assert.equal(renderer.pointUpdates[0]!.range, pointRange)
    assert.deepEqual(
        renderer.pointUpdates[0]!.ys,
        point.steps.map(({ entity }) => beatToTime(state.bpms, entity.beat) * -3.00743),
    )
    cache.clear()
})

test('zoomed point names retain selection, hover, activity, owner filtering and request order', () => {
    const state = fixture()
    const steps = jointSteps(state)
    steps[0] = { ...steps[0]!, highlighted: true }
    const plan = [sectionOf('names', steps)]
    const { render, renderer, cache } = sectionHarness(state)
    render(plan, plan)
    const hovered = render(plan, plan, {
        ups: -2.13731,
        recentlyActive: false,
        hovered: new Set([steps[1]!.entity]),
        visibleOwners: new Set([steps[1]!.entity]),
    })
    assert.equal(hovered.context.names.names.length, 1)
    assert.equal(hovered.context.names.names[0]!.owner, steps[1]!.entity)
    assert.equal(hovered.context.names.names[0]!.highlighted, true)
    const selected = render(plan, plan, { ups: -3.00743, recentlyActive: false })
    assert.deepEqual(
        selected.context.names.names.map(({ owner }) => owner),
        [steps[0]!.entity],
    )
    const active = render(plan, plan, { ups: -3.00743 })
    assert.deepEqual(
        active.context.names.names.map(({ owner }) => owner),
        steps.map(({ entity }) => entity),
    )
    assert.equal(renderer.pointCaptures, 1)
    cache.clear()
})

test('point capture and position-update refusal preserve the existing live or rebuilt output', () => {
    const state = fixture()
    const plan = [sectionOf('point', jointSteps(state))]
    const { render, renderer, cache } = sectionHarness(state)
    renderer.rejectPointCapture = true
    render(plan, plan)
    const legacy = renderer.ranges[0]!
    assert.equal(
        legacy.points,
        undefined,
        'declined point capture uses the existing UPS-specific capture',
    )
    renderer.rejectPointCapture = false
    render(plan, plan, { ups: -2.13731 })
    assert.equal(legacy.released, true)
    const point = renderer.ranges.at(-1)!
    renderer.rejectPointUpdate = true
    const rebuilt = render(plan, plan, { ups: -3.00743 })
    assert.equal(point.released, true)
    assert.equal(rebuilt.captures, 1)
    assert.equal(rebuilt.replays, 0)
    assert.equal(renderer.pointUpdates.length, 0)
    assert.equal(renderer.pointCaptures, 2)
    cache.clear()
})

test('point reuse keeps source, metadata and linear-transform invalidation', () => {
    const state = fixture()
    let plan = [sectionOf('point', jointSteps(state))]
    const { render, renderer, cache } = sectionHarness(state)
    render(plan, plan)
    const beforeSelection = renderer.ranges.at(-1)!
    plan = [
        sectionOf(
            'point',
            plan[0]!.steps.map((step) => ({ ...step, highlighted: true })),
        ),
    ]
    assert.equal(render(plan, plan, { ups: -2.13731 }).captures, 1)
    assert.equal(beforeSelection.released, true)
    const beforeBpm = renderer.ranges.at(-1)!
    const changedState = {
        ...state,
        bpms: state.bpms.map((value) => ({ ...value, s: value.s * 2 })),
    }
    assert.equal(render(plan, plan, { state: changedState, ups: -3.00743 }).captures, 1)
    assert.equal(beforeBpm.released, true)
    const beforeMatrix = renderer.ranges.at(-1)!
    renderer.matrix = { ...renderer.matrix, d: 50 }
    assert.equal(render(plan, plan, { state: changedState, ups: -3.00743 }).captures, 1)
    assert.equal(beforeMatrix.released, true)
    cache.clear()
})

test('labels, unsplit events, live sections and unknown parts never use point capture', () => {
    const state = fixture()
    const joint = jointSteps(state)[0]!
    const bpm = entitiesOf(state).find((entity) => entity.type === 'bpm')!
    const timeScale = entitiesOf(state).find((entity) => entity.type === 'timeScale')!
    const plan = [
        { ...sectionOf('live', [joint]), live: true },
        sectionOf('joint-label', [{ ...joint, part: 'label' }]),
        ...[bpm, timeScale].flatMap((entity) =>
            ([undefined, 'label'] as const).map((part) =>
                sectionOf(`${entity.type}:${part}`, [{ ...joint, entity, part }]),
            ),
        ),
        sectionOf('future', [
            { ...joint, entity: { ...joint.entity, type: 'futurePoint' } as unknown as Entity },
        ]),
        ...vectorSections(state),
    ]
    const { render, renderer, cache } = sectionHarness(state)
    render(plan, plan)
    const old = [...renderer.ranges]
    const changed = render(plan, plan, { ups: -2.13731 })
    assert.equal(changed.replays, 0)
    assert.equal(renderer.pointCaptures, 0)
    assert.ok(old.every(({ released }) => released))
    cache.clear()
})

test('point sections preserve active pins and one-shot refusal through a PPS change', () => {
    const state = fixture()
    const joint = jointSteps(state)[0]!
    const plan = Array.from({ length: 4 }, (_, index) =>
        sectionOf(`point:${index}`, [{ ...joint, entity: { ...joint.entity, beat: index * 16 } }]),
    )
    const { render, renderer, cache } = sectionHarness(state)
    renderer.pinBudget = 3
    render(plan, plan.slice(0, 3))
    const [inactive, queued, upcoming] = renderer.ranges
    const active = [plan[1]!, plan[3]!, plan[2]!]
    const pressured = render(plan, active, { ups: -2.13731 })
    assert.equal(pressured.captures, 0)
    assert.equal(pressured.replays, 2)
    assert.equal(pressured.declined, 1)
    assert.equal(renderer.ranges.length, 4)
    assert.equal(inactive!.released, true)
    assert.equal(queued!.released, false)
    assert.equal(upcoming!.released, false)
    assert.equal(renderer.ranges[3]!.reusable, false)
    assert.equal(renderer.ranges[3]!.released, true)
    const recovered = render(plan, active, { ups: -2.13731 })
    assert.equal(recovered.captures, 1)
    assert.equal(recovered.replays, 2)
    cache.clear()
})

test('point capture declines oversized or nonfinite anchors before allocating point metadata', () => {
    const state = fixture()
    const joint = jointSteps(state)[0]!
    const { renderer, cache, base } = sectionHarness(state)
    let pointCalls = 0
    renderer.capturePointVectors = () => {
        pointCalls++
        return undefined
    }
    renderer.rejectCapture = true
    const cases = [
        { steps: Array.from({ length: 50_001 }, () => joint), ups: -2 },
        { steps: [{ ...joint, entity: { ...joint.entity, beat: Infinity } }], ups: -2 },
        { steps: [joint], ups: NaN },
    ]
    for (const [index, { steps, ups }] of cases.entries()) {
        const context = { ...base, ups, names: createNameLayer() }
        const section = sectionOf(`invalid:${index}`, steps)
        let live = 0
        cache.beginFrame(context, [])
        cache.prepareSections([section], [section])
        cache.drawSection(context, section, undefined, () => {
            live++
        })
        cache.endFrame()
        assert.equal(live, steps.length, 'the existing live fallback still handles every step')
    }
    assert.equal(pointCalls, 0)
    assert.equal(cache.stats.ranges, 0)
    cache.clear()
})

/** Idle callbacks a test runs when it chooses, with the time it gives them. */
const manualIdle = () => {
    const queue: Parameters<IdleScheduler>[0][] = []
    const idle: IdleScheduler = (run) => {
        queue.push(run)
    }
    const run = (ms = 50) => {
        const pending = queue.splice(0)
        for (const callback of pending) callback({ timeRemaining: () => ms })
        return pending.length
    }
    return { idle, run, queue }
}

// The view spans beats 0 to 100 (times 0 to 50 s at 120 BPM), so idle time compiles up to beat 200.
const aheadFixture = () =>
    fixture([
        [note(120, -2), note(124, 2)],
        [note(180, -2), note(184, 2)],
        [note(400, -2), note(404, 2)],
    ])

test('idle time compiles the sections nearest the view, and they replay unchanged', () => {
    const state = aheadFixture()
    const plan = vectorSections(state)
    const [first, second, near, farther, far] = plan as [
        DrawSection,
        DrawSection,
        DrawSection,
        DrawSection,
        DrawSection,
    ]
    const idle = manualIdle()
    const { render, renderer, cache } = sectionHarness(state, idle.idle)
    assert.equal(render(plan, [first, second]).captures, 2)
    assert.equal(idle.queue.length, 1)
    renderer.callbacks = []
    idle.run()
    assert.equal(cache.stats.ahead, 2)
    // Nearest first; the section past one view span is left for its first visit.
    assert.deepEqual(
        renderer.callbacks,
        [...near.steps, ...farther.steps].map(({ entity }) => entity),
    )
    assert.equal(idle.run(), 0, 'nothing is left to compile near this view')
    const visit = render(plan, [near, farther])
    assert.equal(visit.captures, 0)
    assert.equal(visit.replays, 2)
    assert.deepEqual(visit.callbacks, [])
    assert.equal(render(plan, [far]).captures, 1)
    cache.clear()
    assert.ok(renderer.ranges.every(({ released }) => released))
})

test('idle compilation uses the frame’s transform, and none when the drawing state changed', () => {
    const state = aheadFixture()
    const plan = vectorSections(state)
    const idle = manualIdle()
    const { render, renderer, cache } = sectionHarness(state, idle.idle)
    render(plan, plan.slice(0, 2))
    const frame = renderer.matrix
    renderer.setTransform(1, 0, 0, 1, 0, 0)
    renderer.fillStyle = '#ffffff'
    idle.run()
    assert.equal(cache.stats.ahead, 0)
    assert.equal(renderer.fillStyle, '#ffffff', 'the state is restored')
    renderer.fillStyle = '#000000'
    renderer.matrix = frame
    render(plan, plan.slice(0, 2))
    renderer.setTransform(1, 0, 0, 1, 0, 0)
    let captured: unknown
    const capture = renderer.captureVectors.bind(renderer)
    renderer.captureVectors = (draw, origin) => {
        captured = renderer.matrix
        return capture(draw, origin)
    }
    idle.run()
    assert.equal(cache.stats.ahead, 2)
    assert.deepEqual(captured, frame)
    assert.deepEqual(renderer.matrix, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
})

test('idle compilation waits for time its estimate fits, and a cleared cache drops it', () => {
    const state = aheadFixture()
    const plan = vectorSections(state)
    const idle = manualIdle()
    const { render, cache } = sectionHarness(state, idle.idle)
    const realNow = performance.now.bind(performance)
    let now = 0
    performance.now = () => now
    const capture = (cache as unknown as { captureSection: (...args: unknown[]) => unknown })
        .captureSection
    ;(cache as unknown as { captureSection: unknown }).captureSection = function (
        this: unknown,
        ...args: unknown[]
    ) {
        now += 10
        return capture.apply(this, args)
    }
    try {
        render(plan, plan.slice(0, 2))
        // Each capture took 10 ms; 1 ms of idle time fits none of them.
        idle.run(1)
        assert.equal(cache.stats.ahead, 0)
        assert.equal(idle.queue.length, 1, 'it waits for the next idle time')
        cache.clear()
        idle.run()
        assert.equal(cache.stats.ahead, 0)
    } finally {
        performance.now = realNow
    }
})

test('idle compilation never evicts an active section', () => {
    const state = fixture(
        Array.from({ length: 1023 }, (_, i) => [note(64 + i * 4, -2), note(66 + i * 4, 2)]),
    )
    const plan = vectorSections(state)
    const idle = manualIdle()
    const { render, renderer, cache } = sectionHarness(state, idle.idle)
    // The first section is in reach of the view, and every other one is active.
    const visible = plan.slice(1)
    render(plan, visible)
    assert.equal(cache.stats.ranges, 1024)
    const kept = renderer.ranges.slice()
    idle.run()
    assert.equal(cache.stats.ahead, 0)
    assert.ok(kept.every(({ released }) => !released))
    assert.equal(renderer.ranges.at(-1)!.released, true, 'the capture that did not fit is released')
})

test('a zoom frame leaves idle compilation for a steady frame', () => {
    const state = aheadFixture()
    const plan = vectorSections(state)
    const idle = manualIdle()
    const { render } = sectionHarness(state, idle.idle)
    render(plan, plan.slice(0, 2))
    idle.run()
    render(plan, plan.slice(0, 2), { ups: -3 })
    assert.equal(idle.queue.length, 0)
    render(plan, plan.slice(0, 2), { ups: -3 })
    assert.equal(idle.queue.length, 1)
})
