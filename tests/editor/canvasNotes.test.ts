import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createNoteRenderer } from '../../src/editor/canvas/notes'
import type { DrawStep } from '../../src/editor/canvas/ordering'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import type {
    NoteAtlasRegion,
    NoteBody,
    RenderSurface,
    RetainedNoteBodies,
    WebGLDrawContext,
} from '../../src/rendering/context'
import type { NoteEntity } from '../../src/state/entities/slides/note'
import { getNoteVisualType } from '../../src/state/entities/slides/visualType'
import { recordEditorLabel } from './recordedLabel'

const note = (beat: number, properties: Partial<NoteEntity> = {}) =>
    ({
        type: 'note',
        beat,
        noteType: 'default',
        connectorType: 'active',
        isConnectorSeparator: false,
        ...properties,
    }) as NoteEntity

const retainedSurface = (createContext: () => WebGLDrawContext, width: number, height: number) => {
    const ctx = createContext()
    const surface = {
        width,
        height,
        getContext: () => ctx,
        dispose() {
            surface.width = surface.height = 0
        },
    }
    return surface
}

test('canvas notes retain the head, tick, tail and isolated roles of active slides', () => {
    const head = note(0)
    const middle = note(1)
    const nonTick = note(2, { noteType: 'forceNonTick' })
    const tail = note(3)
    const infos = [head, middle, nonTick, tail].map((note) => ({
        note,
        activeHead: head,
        activeTail: tail,
    }))
    const lookup = new Map(infos.map((info) => [info.note, info]))

    for (const index of [undefined, lookup]) {
        assert.deepEqual(
            [head, middle, nonTick, tail].map((entity) => getNoteVisualType(entity, infos, index)),
            ['head', 'tick', 'single', 'tail'],
        )
    }
    assert.equal(
        getNoteVisualType(head, [{ note: head, activeHead: head, activeTail: head }]),
        'single',
    )
    assert.equal(getNoteVisualType(head, [{ note: head }]), 'single')
    assert.equal(getNoteVisualType(head), 'single')
})

test('explicit note types retain their appearance regardless of slide position', () => {
    for (const [noteType, expected] of [
        ['anchor', 'anchor'],
        ['damage', 'damage'],
        ['trace', 'trace'],
        ['forceTick', 'tick'],
    ] as const) {
        const entity = note(0, { noteType })
        assert.equal(getNoteVisualType(entity, [{ note: entity, activeHead: entity }]), expected)
        assert.equal(getNoteVisualType(entity), expected)
    }
})

test('moving note ghosts retain the role of the original note', () => {
    const head = note(0)
    const middle = note(1)
    const tail = note(2)
    const infos = [head, middle, tail].map((note) => ({
        note,
        activeHead: head,
        activeTail: tail,
    }))

    assert.equal(getNoteVisualType(note(10, { useInfoOf: head }), infos), 'head')
    assert.equal(getNoteVisualType(note(-10, { useInfoOf: tail }), infos), 'tail')
    assert.equal(
        getNoteVisualType(note(10, { noteType: 'forceNonTick', useInfoOf: middle }), infos),
        'tick',
    )
})

test('new note ghosts infer roles before, within and after active slide segments', () => {
    const head = note(1)
    const tail = note(3)
    const infos = [head, tail].map((note) => ({ note }))

    assert.equal(getNoteVisualType(note(0), infos), 'head')
    assert.equal(getNoteVisualType(note(2), infos), 'tick')
    assert.equal(getNoteVisualType(note(4), infos), 'tail')
    assert.equal(getNoteVisualType(note(0, { connectorType: 'guide' }), infos), 'single')
    assert.equal(
        getNoteVisualType(note(2, { isConnectorSeparator: true, connectorType: 'guide' }), infos),
        'tail',
    )
})

test('new note ghosts respect inactive separators at the same beat', () => {
    const infos = [
        note(1, { connectorType: 'guide' }),
        note(3, { isConnectorSeparator: true }),
        note(5, { isConnectorSeparator: true, connectorType: 'damage' }),
        note(7),
    ].map((note) => ({ note }))

    assert.equal(getNoteVisualType(note(2), infos), 'single')
    assert.equal(getNoteVisualType(note(2, { isConnectorSeparator: true }), infos), 'head')
    assert.equal(getNoteVisualType(note(3), infos), 'tick')
    assert.equal(getNoteVisualType(note(5), infos), 'single')
    assert.equal(getNoteVisualType(note(6, { isConnectorSeparator: true }), infos), 'head')
    assert.equal(getNoteVisualType(note(8, { isConnectorSeparator: true }), infos), 'single')
})

const artworkFixture = (t: TestContext, scale = 40, pixelRatio = 1, atlasRegions = false) => {
    let images = 0
    const imageDraws: { source: unknown; alpha: number; values: number[] }[] = []
    const layers: number[][] = []
    const fillAlphas: number[] = []
    const strokePaints: { color: unknown; width: unknown; alpha: number }[] = []
    let resourceOwner = {}
    const canvases: { width: number; height: number }[] = []
    const regions: { region: NoteAtlasRegion; crop: number[] }[] = []
    const lifecycle: { kind: 'body' | 'region' | 'surface'; value: unknown }[] = []
    const createSurface = (width: number, height: number) => {
        const surface = retainedSurface(makeCanvasContext, width, height)
        canvases.push(surface)
        if (atlasRegions) {
            const source = { destroyed: false }
            surface.getContext().createNoteAtlasRegion = (x, y, width, height) => {
                const texture = { destroyed: false, source }
                const region: NoteAtlasRegion = {
                    texture: texture as NoteAtlasRegion['texture'],
                    surface: surface as RenderSurface,
                    owner: resourceOwner,
                    release() {
                        if (texture.destroyed) return
                        texture.destroyed = true
                        lifecycle.push({ kind: 'region', value: region })
                    },
                }
                regions.push({ region, crop: [x, y, width, height] })
                return region
            }
            const dispose = surface.dispose
            surface.dispose = () => {
                lifecycle.push({ kind: 'surface', value: surface })
                source.destroyed = true
                dispose()
            }
        }
        return surface
    }
    const makeCanvasContext = () => {
        const stack: number[] = []
        const state = {
            globalAlpha: 1,
            get resourceOwner() {
                return resourceOwner
            },
            maxSurfaceSize: 4096,
            createSurface,
            isContextLost: () => false,
        }
        return new Proxy(state, {
            get(target, property) {
                if (property in target) return Reflect.get(target, property)
                if (property === 'save') return () => stack.push(state.globalAlpha)
                if (property === 'saveLayer')
                    return (...args: number[]) => {
                        stack.push(state.globalAlpha)
                        layers.push(args)
                    }
                if (property === 'restore') return () => (state.globalAlpha = stack.pop()!)
                if (property === 'fill') return () => fillAlphas.push(state.globalAlpha)
                if (property === 'stroke')
                    return () =>
                        strokePaints.push({
                            color: Reflect.get(state, 'strokeStyle'),
                            width: Reflect.get(state, 'lineWidth'),
                            alpha: state.globalAlpha,
                        })
                if (property === 'drawImage')
                    return (source: unknown, ...values: number[]) => {
                        images++
                        imageDraws.push({ source, alpha: state.globalAlpha, values })
                    }
                if (atlasRegions && property === 'drawNoteAtlasRegion')
                    return (region: NoteAtlasRegion, ...values: number[]) => {
                        assert.ok(!region.texture.destroyed && !region.texture.source.destroyed)
                        images++
                        imageDraws.push({ source: region, alpha: state.globalAlpha, values })
                    }
                return () => {}
            },
        }) as unknown as WebGLDrawContext
    }
    const renderer = createNoteRenderer()
    t.after(() => renderer.clear())
    const context = {
        ctx: makeCanvasContext(),
        scale,
        pixelRatio,
        ups: -2,
        recentlyActive: false,
        state: {
            bpms: [{ x: 0, y: 0, s: 0.5 }],
            store: { slides: { info: new Map() } },
        },
    } as unknown as EditorDrawContext
    const draw = (size: number, noteStyle: NoteEntity['noteStyle'] = 'default') =>
        renderer.draw(
            context,
            note(0, {
                size,
                noteStyle,
                left: 0,
                flickDirection: 'none',
                isCritical: false,
                isFake: false,
            }),
            false,
        )
    return {
        context,
        renderer,
        canvases,
        draw,
        imageDraws,
        fillAlphas,
        strokePaints,
        layers,
        regions,
        lifecycle,
        images: () => images,
        restoreOwner() {
            resourceOwner = {}
        },
    }
}

const artworkNote = (properties: Partial<NoteEntity> = {}) =>
    note(0, {
        size: 2,
        left: 0,
        noteStyle: 'default',
        flickDirection: 'none',
        isCritical: false,
        isFake: false,
        ...properties,
    })

const bodyStep = (entity: NoteEntity, opacity = 1): DrawStep => ({
    entity,
    opacity,
    highlighted: false,
    raised: false,
})

// Domain tests record the context boundary; real GL groups/readers are tested in the browser.
const bodyFixture = (t: TestContext) => {
    const fixture = artworkFixture(t, 40, 1, true)
    const { context, renderer, lifecycle } = fixture
    context.names = { names: [] }
    const captures: { range: RetainedNoteBodies; bodies: readonly NoteBody[]; origin: number }[] =
        []
    const draws: RetainedNoteBodies[] = []
    const live: { context: EditorDrawContext; step: DrawStep }[] = []
    context.ctx.createNoteBodies = (bodies, origin) => {
        const range = {
            owner: context.ctx.resourceOwner,
            regions: bodies.map(({ region }) => region),
            count: bodies.length,
            released: false,
        } as unknown as RetainedNoteBodies
        captures.push({ range, bodies, origin })
        return range
    }
    context.ctx.drawNoteBodies = (range) => {
        assert.equal(range.released, false)
        assert.equal(range.owner, context.ctx.resourceOwner)
        assert.ok(
            range.regions.every(({ texture }) => !texture.destroyed && !texture.source.destroyed),
        )
        draws.push(range)
        return true
    }
    context.ctx.releaseNoteBodies = (range) => {
        assert.equal(range.released, false, 'domain releases each retained run once')
        range.released = true
        lifecycle.push({ kind: 'body', value: range })
    }
    let frame = 0
    const render = (
        steps: DrawStep[],
        spans: readonly (readonly [number, number])[] = [[0, steps.length]],
        hovered?: ReadonlySet<NoteEntity>,
        preview?: { context: EditorDrawContext; entities: ReadonlySet<NoteEntity> },
    ) => {
        renderer.beginFrame(++frame)
        if (context.names) context.names.names.length = 0
        for (const step of steps)
            renderer.prepare(
                preview?.entities.has(step.entity as NoteEntity) ? preview.context : context,
                step.entity as NoteEntity,
                step.highlighted || !!hovered?.has(step.entity as NoteEntity),
                step.opacity,
            )
        renderer.prepareRuns(context, steps, steps.length, preview?.entities)
        for (const [from, to] of spans)
            renderer.drawRun(context, steps, from, to, 'normal', hovered, (target, step) => {
                if (preview?.entities.has(step.entity as NoteEntity)) target = preview.context
                live.push({ context: target, step })
                renderer.draw(
                    target,
                    step.entity as NoteEntity,
                    step.highlighted || !!hovered?.has(step.entity as NoteEntity),
                    step.opacity,
                )
            })
        renderer.endFrame()
    }
    return { ...fixture, captures, draws, live, render }
}

test('note body runs reuse artwork across recreated preparation and keep names live', (t) => {
    const { context, renderer, captures, draws, live, render } = bodyFixture(t)
    context.names = { names: [] }
    context.showGroupName = true
    context.defaultGroupId = 1 as never
    context.state = { ...context.state, groups: new Map([[2, { name: 'Group' }]]) } as never
    const entity = artworkNote({ groupId: 2 as never })
    const steps = [bodyStep(entity, 0.5)]
    context.ctx.globalAlpha = 0.75
    render(steps)
    assert.equal(captures.length, 1)
    assert.equal(captures[0]!.bodies[0]!.alpha, 0.5)
    assert.deepEqual(context.names.names, [])
    context.recentlyActive = true
    render(steps)
    assert.equal(
        captures.length,
        1,
        'new PreparedNote wrappers do not invalidate unchanged artwork',
    )
    assert.equal(draws[0], draws[1])
    assert.equal(renderer.bodyStats.replays, 1)
    assert.deepEqual(
        context.names.names.map(({ text, alpha, highlighted }) => [text, alpha, highlighted]),
        [['Group', 0.375, false]],
    )
    context.showGroupName = false
    render(steps, undefined, new Set([entity]))
    assert.equal(draws[2], draws[0], 'hover changes names without recapturing an unchanged body')
    assert.deepEqual(context.names.names, [])
    assert.equal(context.ctx.globalAlpha, 0.75)
    assert.deepEqual(live, [])
    context.names = undefined
    render(steps)
    assert.equal(captures[0]!.range.released, true)
    assert.equal(live.length, 1, 'contexts without deferred names retain immediate drawing order')
})

test('note body runs revalidate composed position and width for the same entity', (t) => {
    const { context, captures, render } = bodyFixture(t)
    let left = 4,
        size = 2,
        projections = 0
    context.composed = {
        notePosition() {
            projections++
            return { left, size }
        },
    } as unknown as NonNullable<EditorDrawContext['composed']>
    const entity = artworkNote({ beat: 18, left: -1 })
    const steps = [bodyStep(entity)]
    render(steps)
    const first = captures[0]!
    assert.equal(first.origin, -16)
    left = 7
    render(steps)
    const moved = captures[1]!
    assert.equal(first.range.released, true)
    assert.equal(moved.bodies[0]!.region, first.bodies[0]!.region)
    assert.equal(moved.bodies[0]!.x - first.bodies[0]!.x, 3)
    size = 3
    render(steps)
    assert.equal(moved.range.released, true)
    assert.notEqual(captures[2]!.bodies[0]!.region, moved.bodies[0]!.region)
    assert.ok(captures[2]!.bodies[0]!.width > moved.bodies[0]!.width)
    assert.equal(projections, 3, 'one composed resolution per visible note per frame')
    assert.equal(entity.left, -1)
    assert.equal(entity.size, 2)
})

test('retained anchor bodies follow hover and activity while hidden anchors paint nothing', (t) => {
    const { context, captures, draws, imageDraws, render } = bodyFixture(t)
    context.names = { names: [] }
    context.showStageName = context.showGroupName = true
    context.defaultGroupId = 1 as never
    context.state = {
        ...context.state,
        isDynamicStages: true,
        stages: new Map([[2, { name: 'Stage' }]]),
        groups: new Map([[2, { name: 'Group' }]]),
    } as never
    context.ctx.globalAlpha = 0.75
    const entity = artworkNote({ noteType: 'anchor', stageId: 2 as never, groupId: 2 as never })
    const steps = [bodyStep(entity, 0.5)]
    render(steps)
    assert.equal(captures.length, 0)
    assert.deepEqual(imageDraws, [])
    assert.deepEqual(context.names.names, [])
    render(steps, undefined, new Set([entity]))
    assert.equal(captures.length, 1)
    assert.deepEqual(
        context.names.names.map(({ text, x, y, alpha, highlighted }) => [
            text,
            x,
            y,
            alpha,
            highlighted,
        ]),
        [
            ['Stage', 0.9, 0, 0.375, true],
            ['Group', 1.1, 0, 0.375, true],
        ],
    )
    context.recentlyActive = true
    render(steps)
    assert.equal(draws[1], draws[0], 'active and hovered anchors share the same visible outline')
    assert.ok(context.names.names.every(({ highlighted }) => !highlighted))
    context.recentlyActive = false
    render(steps)
    assert.equal(captures[0]!.range.released, true)
    assert.deepEqual(context.names.names, [])
    assert.deepEqual(imageDraws, [], 'hidden anchors never fall through to an image submission')
})

test('preview notes stay live without invalidating unrelated retained note buckets', (t) => {
    const { context, captures, draws, live, render } = bodyFixture(t)
    const affected = artworkNote({ beat: 18 })
    const unrelated = artworkNote({ beat: 2, noteStyle: 'red' })
    const steps = [bodyStep(affected), bodyStep(unrelated)]
    const spans = [
        [0, 1],
        [1, 2],
    ] as const
    render(steps, spans)
    const [affectedRun, unrelatedRun] = captures.map(({ range }) => range)
    const preview = {
        context: { ...context, state: { ...context.state } },
        entities: new Set([affected]),
    }
    render(steps, spans, undefined, preview)
    assert.equal(affectedRun!.released, true)
    assert.equal(unrelatedRun!.released, false)
    assert.equal(captures.length, 2)
    assert.equal(draws.at(-1), unrelatedRun)
    assert.equal(live.length, 1)
    assert.equal(live[0]!.context, preview.context)
    assert.equal(live[0]!.step.entity, affected)
    render(steps, spans)
    assert.equal(captures.length, 3, 'ending the preview restores only its affected bucket')
    assert.equal(draws.at(-1), unrelatedRun)
})

test('note body runs reject released crops and restored owners even when slots are reused', (t) => {
    const { captures, regions, render, restoreOwner } = bodyFixture(t)
    const steps = [bodyStep(artworkNote()), bodyStep(artworkNote({ noteStyle: 'red' }))]
    render(steps)
    const first = captures[0]!
    const released = regions[0]!
    released.region.release()
    render(steps)
    const replacement = captures[1]!
    assert.equal(first.range.released, true)
    assert.notEqual(replacement.bodies[0]!.region, released.region)
    assert.equal(replacement.bodies[0]!.region.surface, released.region.surface)
    assert.deepEqual(
        regions[2]!.crop,
        released.crop,
        'reuse of the same slot is not region identity',
    )
    assert.equal(replacement.bodies[1]!.region, first.bodies[1]!.region)
    restoreOwner()
    render(steps)
    assert.equal(replacement.range.released, true)
    assert.notEqual(captures[2]!.range.owner, replacement.range.owner)
    assert.ok(replacement.bodies.every(({ region }) => region.texture.destroyed))
})

test('note body runs preserve member order and recapture changed per-note opacity', (t) => {
    const { captures, render } = bodyFixture(t)
    const a = bodyStep(artworkNote({ left: -2 }), 0.25)
    const b = bodyStep(artworkNote({ left: 3, noteStyle: 'red' }), 0.25)
    render([a, b])
    const first = captures[0]!
    render([b, a])
    const reordered = captures[1]!
    assert.equal(first.range.released, true)
    assert.deepEqual(
        reordered.bodies.map(({ region }) => region),
        first.bodies.map(({ region }) => region).reverse(),
    )
    render([{ ...b, opacity: 0.5 }, a])
    assert.equal(reordered.range.released, true)
    assert.deepEqual(
        captures[2]!.bodies.map(({ alpha }) => alpha),
        [0.5, 0.25],
    )
})

test('note body retention bounds sprites and groups and frees the preceding viewport', (t) => {
    for (const mode of ['sprites', 'groups'] as const) {
        const { renderer, captures, live, render } = bodyFixture(t)
        const steps = Array.from({ length: mode === 'sprites' ? 4097 : 193 }, (_, index) =>
            bodyStep(
                artworkNote({
                    beat: mode === 'sprites' ? (index < 4096 ? 16 : 0) : (192 - index) * 16,
                }),
            ),
        )
        const spans: [number, number][] =
            mode === 'sprites'
                ? [
                      [0, 4096],
                      [4096, 4097],
                  ]
                : steps.map((_, index) => [index, index + 1])
        render(steps, spans)
        assert.equal(renderer.bodyStats.sprites, mode === 'sprites' ? 4096 : 192, mode)
        assert.equal(renderer.bodyStats.ranges, mode === 'sprites' ? 1 : 192, mode)
        assert.equal(live.length, 1, mode)
        assert.equal(live[0]!.step, steps.at(-1), mode)
        const preceding = captures.map(({ range }) => range)
        render([steps.at(-1)!])
        assert.ok(
            preceding.every(({ released }) => released),
            mode,
        )
        assert.equal(renderer.bodyStats.ranges, 1, mode)
        assert.equal(renderer.bodyStats.sprites, 1, mode)
        assert.equal(live.length, 1, 'new viewport reclaims the capacity before capture')
    }
})

test('clearing note bodies releases groups before atlas regions and page disposal', (t) => {
    const { renderer, captures, lifecycle, canvases, render } = bodyFixture(t)
    render([bodyStep(artworkNote()), bodyStep(artworkNote({ noteStyle: 'red' }))])
    renderer.clear()
    assert.equal(captures[0]!.range.released, true)
    assert.deepEqual(
        lifecycle.map(({ kind }) => kind),
        ['body', 'region', 'region', 'surface'],
    )
    assert.ok(canvases.every(({ width, height }) => width === 0 && height === 0))
    renderer.clear()
    assert.equal(lifecycle.length, 4, 'clearing twice does not release resources twice')
    render([bodyStep(artworkNote())])
    assert.equal(captures.length, 2)
    assert.notEqual(captures[1]!.bodies[0]!.region, captures[0]!.bodies[0]!.region)
})

test('preparing note artwork draws no main images and preserves slots, alpha and reversed draw order', (t) => {
    const staged = artworkFixture(t)
    const direct = artworkFixture(t)
    const entities = [
        artworkNote(),
        artworkNote({ noteStyle: 'red' }),
        artworkNote({ noteStyle: 'blue', isFake: true }),
        artworkNote({ size: 0, noteType: 'trace' }),
        artworkNote({ flickDirection: 'upLeft', isCritical: true }),
        artworkNote({ noteType: 'forceTick' }),
    ]
    staged.renderer.beginFrame(1)
    direct.renderer.beginFrame(1)
    staged.context.ctx.globalAlpha = direct.context.ctx.globalAlpha = 0.75
    for (const entity of entities) {
        staged.renderer.prepare(staged.context, entity, true, 0.5)
        direct.renderer.draw(direct.context, entity, true, 0.5)
    }
    assert.equal(staged.images(), 0, 'preparation never queues main image draws')
    assert.equal(staged.context.ctx.globalAlpha, 0.75)
    assert.equal(staged.layers.length, 0)
    const artworkFills = staged.fillAlphas.length
    for (let i = entities.length - 1; i >= 0; i--) {
        staged.renderer.draw(staged.context, entities[i]!, true, 0.5)
        const actual = staged.imageDraws.at(-1)!
        const expected = direct.imageDraws[i]!
        assert.deepEqual(actual.values, expected.values, `correct prepared slot for note ${i}`)
        assert.equal(actual.alpha, 0.375)
    }
    assert.equal(staged.fillAlphas.length, artworkFills, 'draw does not repaint prepared slots')
    assert.equal(staged.context.ctx.globalAlpha, 0.75)
})

test('prepared composed notes reuse projected appearance once and explicit positions bypass it', (t) => {
    const { context, renderer, imageDraws } = artworkFixture(t)
    let projections = 0
    context.composed = {
        notePosition() {
            projections++
            return { left: 7, size: 3 }
        },
    } as unknown as NonNullable<EditorDrawContext['composed']>
    const entity = artworkNote({ beat: 2, size: 2, left: -1 })
    renderer.beginFrame(1)
    renderer.prepare(context, entity, false)
    renderer.draw(context, entity, false)
    assert.equal(projections, 1)
    const projected = imageDraws.at(-1)!
    renderer.draw(context, entity, false, 1, { left: -1, y: -2.3 })
    const explicit = imageDraws.at(-1)!
    assert.equal(projections, 1)
    assert.equal(projected.values[4]! - explicit.values[4]!, 8)
    assert.ok(
        projected.values[2]! > explicit.values[2]!,
        'composed width does not leak to explicit draw',
    )
    assert.equal(projected.values[5], explicit.values[5])
    assert.equal(entity.size, 2)
    assert.equal(entity.left, -1)
})

test('prepared notes reject stale frame, highlight, owner and context appearances', (t) => {
    const staged = artworkFixture(t)
    const ghost = artworkFixture(t)
    const entity = artworkNote({ noteType: 'anchor' })
    staged.renderer.beginFrame(1)
    staged.renderer.prepare(staged.context, entity, false)
    assert.equal(staged.canvases.length, 0, 'unoutlined anchor has no sprite')
    staged.renderer.draw(staged.context, entity, true)
    assert.equal(staged.images(), 1, 'highlight change resolves its visible outline')

    staged.renderer.prepare(staged.context, entity, true)
    staged.renderer.draw(ghost.context, entity, true)
    assert.equal(ghost.images(), 1)
    assert.notEqual(ghost.imageDraws[0]!.source, staged.imageDraws[0]!.source)

    staged.renderer.prepare(staged.context, entity, true)
    staged.restoreOwner()
    staged.renderer.draw(staged.context, entity, true)
    assert.notEqual(staged.imageDraws.at(-1)!.source, staged.imageDraws[0]!.source)

    const previousWidth = staged.imageDraws.at(-1)!.values[2]!
    staged.renderer.beginFrame(2)
    entity.size = 3
    staged.renderer.draw(staged.context, entity, true)
    assert.ok(staged.imageDraws.at(-1)!.values[2]! > previousWidth)
    staged.renderer.prepare(staged.context, entity, true)
    const oldSource = staged.imageDraws.at(-1)!.source
    staged.renderer.clear()
    staged.renderer.draw(staged.context, entity, true)
    assert.notEqual(staged.imageDraws.at(-1)!.source, oldSource)
})

test('preparation skips hidden anchors before layout but prepares highlighted and active outlines', (t) => {
    const { context, renderer, imageDraws } = artworkFixture(t)
    let projections = 0
    context.composed = {
        notePosition() {
            projections++
            return { left: 1, size: 2 }
        },
    } as unknown as NonNullable<EditorDrawContext['composed']>
    const entity = artworkNote({ noteType: 'anchor' })
    renderer.beginFrame(1)
    renderer.prepare(context, entity, false)
    assert.equal(projections, 0)
    renderer.prepare(context, entity, true)
    renderer.draw(context, entity, true)
    assert.equal(projections, 1)
    assert.equal(imageDraws.length, 1)

    renderer.beginFrame(2)
    context.recentlyActive = true
    renderer.prepare(context, entity, false)
    renderer.draw(context, entity, false)
    assert.equal(projections, 2)
    assert.equal(imageDraws.length, 2)
})

test('hidden explicit anchors skip layout, slide lookup, artwork and names at every position', (t) => {
    const fixture = artworkFixture(t)
    const { context, renderer } = fixture
    context.names = { names: [] }
    context.showStageName = context.showGroupName = true
    context.composed = {
        notePosition() {
            assert.fail('a hidden explicit anchor needs no composed position')
        },
    } as unknown as NonNullable<EditorDrawContext['composed']>
    t.mock.method(context.state.store.slides.info, 'get', () => {
        assert.fail('a hidden explicit anchor needs no slide lookup')
    })
    const entity = artworkNote({
        noteType: 'anchor',
        useInfoOf: artworkNote({ noteType: 'forceTick' }),
        isFake: true,
        flickDirection: 'upLeft',
        isCritical: true,
    })
    renderer.beginFrame(1)
    renderer.prepare(context, entity, false)
    for (const position of [
        undefined,
        { left: 7, y: 3 },
        { left: -4, y: 9, size: 0 },
        { left: -4, y: 9, size: -2 },
    ]) {
        renderer.draw(context, entity, false, 0.5, position)
    }
    context.composed = undefined
    renderer.draw(context, entity, false)
    assert.equal(fixture.images(), 0)
    assert.equal(fixture.canvases.length, 0)
    assert.deepEqual(fixture.fillAlphas, [])
    assert.deepEqual(fixture.strokePaints, [])
    assert.deepEqual(fixture.layers, [])
    assert.deepEqual(context.names, { names: [] })
    assert.equal(context.ctx.globalAlpha, 1)
})

test('selected, hovered, ghost and active anchors retain outlines and names at all positions', (t) => {
    for (const mode of ['selected', 'hovered', 'ghost', 'active'] as const) {
        for (const position of ['basic', 'composed', 'explicit'] as const) {
            const { context, renderer, strokePaints, fillAlphas, imageDraws } = artworkFixture(t)
            const label = `${mode} ${position}`
            const names: NonNullable<EditorDrawContext['names']> = { names: [] }
            context.names = names
            context.showStageName = context.showGroupName = true
            context.defaultGroupId = 1 as never
            context.state = {
                ...context.state,
                isDynamicStages: true,
                stages: new Map([[2, { name: 'Stage' }]]),
                groups: new Map([[2, { name: 'Group' }]]),
            } as unknown as EditorDrawContext['state']
            context.recentlyActive = mode === 'active'
            let projections = 0
            if (position !== 'basic') {
                context.composed = {
                    notePosition() {
                        projections++
                        return { left: 7, size: 3 }
                    },
                } as unknown as NonNullable<EditorDrawContext['composed']>
            }
            const entity = artworkNote({
                noteType: 'anchor',
                stageId: 2 as never,
                groupId: 2 as never,
                ...(mode === 'ghost' ? { useInfoOf: artworkNote() } : {}),
            })
            const highlighted = mode !== 'active'
            const explicit = position === 'explicit' ? { left: -3, y: 4, size: 0 } : undefined
            context.ctx.globalAlpha = 0.75
            renderer.beginFrame(1)
            renderer.draw(context, entity, highlighted, 0.5, explicit)
            assert.deepEqual(strokePaints, [{ color: '#fff', width: 0.05, alpha: 1 }], label)
            assert.deepEqual(fillAlphas, [], label)
            assert.equal(imageDraws.length, 1, label)
            assert.equal(imageDraws[0]!.alpha, 0.375, label)
            assert.equal(context.ctx.globalAlpha, 0.75, label)
            assert.equal(projections, position === 'composed' ? 1 : 0, label)
            const center = position === 'basic' ? 1 : position === 'composed' ? 8.5 : -3
            const y = position === 'explicit' ? 4.3 : 0
            assert.deepEqual(
                names.names.map(({ owner, ...name }) => ({
                    ...name,
                    noteType: owner.type === 'note' && owner.noteType,
                })),
                [
                    {
                        text: 'Stage',
                        x: center - 0.1,
                        y,
                        color: '#a0a',
                        size: 0.4,
                        align: 'end',
                        alpha: 0.375,
                        highlighted,
                        noteType: 'anchor',
                    },
                    {
                        text: 'Group',
                        x: center + 0.1,
                        y,
                        color: '#0aa',
                        size: 0.4,
                        align: 'start',
                        alpha: 0.375,
                        highlighted,
                        noteType: 'anchor',
                    },
                ],
                label,
            )
            assert.equal(entity.size, 2, label)
        }
    }
})

test('preparation pins the visible working set and leaves overflow for direct drawing', (t) => {
    const { context, renderer, imageDraws, fillAlphas, canvases } = artworkFixture(t)
    const entities = Array.from({ length: 600 }, (_, i) => artworkNote({ size: 1 + i / 1000 }))
    let allocations = 0
    for (let frame = 1; frame <= 3; frame++) {
        renderer.beginFrame(frame)
        for (const entity of entities) renderer.prepare(context, entity, false)
        const preparedFills = fillAlphas.length
        const beforeImages = imageDraws.length
        for (const entity of [...entities].reverse()) renderer.draw(context, entity, false)
        assert.equal(imageDraws.length - beforeImages, 512)
        assert.ok(fillAlphas.length > preparedFills, 'uncached overflow paints only at draw time')
        if (frame === 1) allocations = canvases.length
        else assert.equal(canvases.length, allocations, 'warm preparation does not thrash slots')
    }
    const replaced = entities.map((entity) => ({ ...entity, size: entity.size + 1 }))
    renderer.beginFrame(4)
    for (const entity of replaced) renderer.prepare(context, entity, false)
    const beforeImages = imageDraws.length
    for (const entity of replaced) renderer.draw(context, entity, false)
    assert.equal(imageDraws.length - beforeImages, 512, 'older, unpinned slots can be replaced')
})

test('composed notes use projected artwork coordinates while explicit elevation positions stay local', (t) => {
    const { context, renderer } = artworkFixture(t)
    const calls: number[][] = []
    context.ctx.drawImage = ((_image: unknown, ...values: number[]) =>
        calls.push(values)) as typeof context.ctx.drawImage
    let projections = 0
    context.composed = {
        notePosition: () => {
            projections++
            return { left: 7, size: 2 }
        },
    } as unknown as NonNullable<EditorDrawContext['composed']>
    const entity = note(2, {
        size: 2,
        left: -1,
        noteStyle: 'default',
        flickDirection: 'none',
        isCritical: false,
        isFake: false,
    })
    renderer.draw(context, entity, false)
    renderer.draw(context, entity, false, 1, { left: -1, y: -2.3 })
    assert.equal(projections, 1)
    assert.equal(calls[0]![4]! - calls[1]![4]!, 8)
    assert.equal(calls[0]![5], calls[1]![5])
    assert.equal(entity.left, -1)
})

test('dense unique note widths reuse cached artwork instead of allocating every frame', (t) => {
    const { renderer, canvases, draw, images } = artworkFixture(t)
    let allocated = 0
    for (const timestamp of [1, 2, 3]) {
        renderer.beginFrame(timestamp)
        for (let i = 0; i < 600; i++) draw(1 + i / 1000)
        if (timestamp === 1) {
            allocated = canvases.length
            assert.ok(allocated > 0 && allocated <= 4)
        } else assert.equal(canvases.length, allocated)
        assert.equal(images(), timestamp * 512)
    }

    // New notes scrolling into view replace previously unused cached artwork.
    renderer.beginFrame(4)
    for (let i = 0; i < 600; i++) draw(2 + i / 1000)
    assert.equal(images(), 4 * 512)
    assert.ok(
        canvases.reduce((sum, { width, height }) => sum + width * height, 0) <= 4 * 1024 * 1024,
        'the atlas budget includes unused page space',
    )
    renderer.clear()
    assert.ok(canvases.every(({ width, height }) => width === 0 && height === 0))
})

test('artwork pixel budget remains bounded without repeated high-DPR cache misses', (t) => {
    const { renderer, canvases, draw } = artworkFixture(t, 160, 2)
    renderer.beginFrame(1)
    for (let i = 0; i < 100; i++) draw(3 + i / 1000)
    const initialCount = canvases.length
    assert.ok(initialCount > 0 && initialCount < 100)
    assert.ok(
        canvases.reduce((sum, { width, height }) => sum + width * height, 0) <= 4 * 1024 * 1024,
    )

    renderer.beginFrame(2)
    for (let i = 0; i < 100; i++) draw(3 + i / 1000)
    assert.equal(canvases.length, initialCount)

    // A creation layer in the same RAF must not displace chart-layer artwork.
    renderer.beginFrame(2)
    for (let i = 0; i < 100; i++) draw(4 + i / 1000)
    assert.equal(canvases.length, initialCount)
})

test('cached note artwork distinguishes color overrides within a shared atlas page', (t) => {
    const { context, renderer, canvases, draw } = artworkFixture(t)
    const sources: number[][] = []
    context.ctx.drawImage = ((_image: unknown, ...values: number[]) =>
        sources.push(values.slice(0, 4))) as typeof context.ctx.drawImage
    renderer.beginFrame(1)
    draw(2, 'red')
    draw(2, 'blue')
    draw(2, 'default')
    assert.equal(canvases.length, 1)
    assert.notDeepEqual(sources[0], sources[1])
    assert.notDeepEqual(sources[1], sources[2])
    draw(2, 'red')
    assert.equal(canvases.length, 1)
    assert.deepEqual(sources[3], sources[0])
})

test('chart and ghost contexts retain independent artwork without replacing each other', (t) => {
    const chart = artworkFixture(t)
    const ghost = artworkFixture(t)
    const entity = note(0, {
        size: 2,
        noteStyle: 'default',
        left: 0,
        flickDirection: 'none',
        isCritical: false,
        isFake: false,
    })
    for (const timestamp of [1, 2, 3]) {
        chart.renderer.beginFrame(timestamp)
        chart.renderer.draw(chart.context, entity, false)
        chart.renderer.draw(ghost.context, entity, false)
        assert.equal(chart.canvases.length, 1)
        assert.equal(ghost.canvases.length, 1)
        assert.ok([...chart.canvases, ...ghost.canvases].every(({ width }) => width > 0))
    }
    chart.renderer.clear()
    assert.ok(
        [...chart.canvases, ...ghost.canvases].every(({ width, height }) => !width && !height),
    )
})

test('faded cache overflow reuses an atomic scratch image and bounds oversized layers', (t) => {
    const { context, renderer, canvases, draw, imageDraws, fillAlphas, layers } = artworkFixture(t)
    renderer.beginFrame(1)
    for (let index = 0; index < 512; index++) draw(1 + index / 1000)
    const cachedPages = canvases.length
    const faded = (size: number) =>
        renderer.draw(
            context,
            note(0, {
                size,
                noteStyle: 'default',
                left: 0,
                flickDirection: 'none',
                isCritical: false,
                isFake: false,
            }),
            false,
            0.5,
        )
    faded(2)
    const scratch = imageDraws.at(-1)!.source
    assert.equal(imageDraws.at(-1)!.alpha, 0.5)
    assert.equal(canvases.length, cachedPages + 1)
    faded(3)
    assert.equal(imageDraws.at(-1)!.source, scratch)
    assert.equal(imageDraws.at(-1)!.alpha, 0.5)
    assert.equal(canvases.length, cachedPages + 1, 'overflow grows one scratch target')
    assert.ok(canvases.at(-1)!.width * canvases.at(-1)!.height <= 1024 * 1024)
    assert.ok(
        fillAlphas.every((alpha) => alpha === 1),
        'artwork itself stays opaque',
    )
    const imageCount = imageDraws.length
    faded(5000)
    assert.equal(imageDraws.length, imageCount, 'very large notes do not allocate huge sprites')
    assert.equal(layers.length, 1)
    assert.equal(layers[0]![0], 0.5)
    assert.ok(layers[0]![3]! >= 5000, 'the backend intersects the artwork layer with its viewport')
    assert.equal(context.ctx.globalAlpha, 1)
    renderer.clear()
    assert.ok(canvases.every(({ width, height }) => width === 0 && height === 0))
})

test("a zero-width fake note's X spans its placeholder box", () => {
    // Each red stroke's points, in note units.
    const crosses: [number, number][][] = []
    const resourceOwner = {}
    const makeCanvasContext = () => {
        let path: [number, number][] = []
        const target: Record<string, unknown> = {
            globalAlpha: 1,
            resourceOwner,
            maxSurfaceSize: 4096,
            isContextLost: () => false,
            createSurface: (width: number, height: number) =>
                retainedSurface(makeCanvasContext, width, height),
        }
        return new Proxy(target, {
            get(target, property) {
                if (property in target) return Reflect.get(target, property)
                if (property === 'beginPath') return () => (path = [])
                if (property === 'moveTo' || property === 'lineTo')
                    return (x: number, y: number) => path.push([x, y])
                if (property === 'stroke')
                    return () => {
                        if (target.strokeStyle === '#f44') crosses.push(path)
                    }
                return () => {}
            },
        }) as unknown as WebGLDrawContext
    }
    const renderer = createNoteRenderer()
    const context = {
        ctx: makeCanvasContext(),
        scale: 40,
        pixelRatio: 1,
        ups: -2,
        recentlyActive: false,
        state: { bpms: [{ x: 0, y: 0, s: 0.5 }], store: { slides: { info: new Map() } } },
    } as unknown as EditorDrawContext
    const extents = (noteType: NoteEntity['noteType'], size: number) => {
        crosses.length = 0
        renderer.draw(
            context,
            note(0, {
                noteType,
                size,
                left: 0,
                noteStyle: 'default',
                flickDirection: 'none',
                isCritical: false,
                isFake: true,
            }),
            false,
        )
        const points = crosses.flat()
        const xs = points.map(([x]) => x)
        const ys = points.map(([, y]) => y)
        return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    }
    // Over the 0.2-wide placeholder, at the body's own height.
    assert.deepEqual(extents('default', 0), [-0.1, 0.1, 0, 0.6])
    assert.deepEqual(extents('trace', 0), [-0.1, 0.1, 0.15, 0.45])
    // Sized notes keep their X.
    assert.deepEqual(extents('default', 2), [0, 2, 0, 0.6])
})

test("a note's stage and group names keep a gap between them", () => {
    const labels: { text: string; x: number; align: string; color: string }[] = []
    const resourceOwner = {}
    const makeCanvasContext = () => {
        let x = 0
        const target: Record<string, unknown> = {
            globalAlpha: 1,
            resourceOwner,
            maxSurfaceSize: 4096,
            isContextLost: () => false,
            createSurface: (width: number, height: number) =>
                retainedSurface(makeCanvasContext, width, height),
        }
        return new Proxy(target, {
            get(target, property) {
                if (property in target) return Reflect.get(target, property)
                if (property === 'translate') return (dx: number) => (x = dx)
                if (property === 'drawEditorLabel') return recordEditorLabel
                if (property === 'fillText')
                    return (text: string) =>
                        labels.push({
                            text,
                            x,
                            align: target.textAlign as string,
                            color: target.fillStyle as string,
                        })
                if (property === 'measureText') return () => ({ width: 0 })
                return () => {}
            },
        }) as unknown as WebGLDrawContext
    }
    const context = {
        ctx: makeCanvasContext(),
        scale: 40,
        pixelRatio: 1,
        bounds: { l: -12, r: 12, t: -10, b: 10, w: 24, h: 20 },
        ups: -2,
        recentlyActive: false,
        showStageName: true,
        showGroupName: true,
        defaultGroupId: 1,
        state: {
            bpms: [{ x: 0, y: 0, s: 0.5 }],
            store: { slides: { info: new Map() } },
            isDynamicStages: true,
            stages: new Map([[2, { name: 'Side stage' }]]),
            groups: new Map([[2, { name: 'Other group' }]]),
        },
    } as unknown as EditorDrawContext
    const entity = note(0, {
        size: 2,
        left: 0,
        noteStyle: 'default',
        flickDirection: 'none',
        isCritical: false,
        isFake: false,
        stageId: 2 as never,
        groupId: 2 as never,
    })
    createNoteRenderer().draw(context, entity, true)
    // Centred on the note's middle (lane 1), 0.1 lane apart each; the stage's
    // magenta and the group's cyan both read on the chart background.
    assert.deepEqual(
        labels.map(({ text, x, align, color }) => [text, Math.round(x * 100) / 100, align, color]),
        [
            ['Side stage', 0.9, 'end', '#a0a'],
            ['Other group', 1.1, 'start', '#0aa'],
        ],
    )
})

test('a zero-width tick shows a flat placeholder in its colour, under any fake X', () => {
    // Filled boxes and red strokes, in drawing order.
    const marks: (
        { fill: [number, number, number, number]; color: string } | { cross: [number, number][] }
    )[] = []
    const resourceOwner = {}
    const makeCanvasContext = () => {
        let rect: [number, number, number, number] | undefined
        let path: [number, number][] = []
        const target: Record<string, unknown> = {
            globalAlpha: 1,
            resourceOwner,
            maxSurfaceSize: 4096,
            isContextLost: () => false,
            createSurface: (width: number, height: number) =>
                retainedSurface(makeCanvasContext, width, height),
        }
        return new Proxy(target, {
            get(target, property) {
                if (property in target) return Reflect.get(target, property)
                if (property === 'beginPath') return () => ((rect = undefined), (path = []))
                if (property === 'roundRect')
                    return (x: number, y: number, w: number, h: number) => (rect = [x, y, w, h])
                if (property === 'moveTo' || property === 'lineTo')
                    return (x: number, y: number) => path.push([x, y])
                if (property === 'fill')
                    return () => {
                        if (rect) marks.push({ fill: rect, color: target.fillStyle as string })
                    }
                if (property === 'stroke')
                    return () => {
                        if (target.strokeStyle === '#f44') marks.push({ cross: path })
                    }
                return () => {}
            },
        }) as unknown as WebGLDrawContext
    }
    const renderer = createNoteRenderer()
    const context = {
        ctx: makeCanvasContext(),
        scale: 40,
        pixelRatio: 1,
        ups: -2,
        recentlyActive: false,
        state: { bpms: [{ x: 0, y: 0, s: 0.5 }], store: { slides: { info: new Map() } } },
    } as unknown as EditorDrawContext
    const draw = (properties: Partial<NoteEntity>) => {
        marks.length = 0
        renderer.draw(
            context,
            note(0, {
                noteType: 'forceTick',
                size: 0,
                left: 0,
                noteStyle: 'default',
                flickDirection: 'none',
                isCritical: false,
                isFake: false,
                ...properties,
            }),
            false,
        )
        return marks.map((mark) =>
            'fill' in mark
                ? ['fill', ...mark.fill.map((v) => Math.round(v * 100) / 100), mark.color]
                : ['cross', ...mark.cross.flat()],
        )
    }
    // The 0.2-wide flat box of trace and damage, in the diamond's colour.
    assert.deepEqual(draw({}), [['fill', -0.1, 0.15, 0.2, 0.3, '#abfbe3']])
    assert.deepEqual(draw({ isCritical: true }), [['fill', -0.1, 0.15, 0.2, 0.3, '#fff2c3']])
    // A fake one's X lies over the box.
    assert.deepEqual(draw({ isFake: true }), [
        ['fill', -0.1, 0.15, 0.2, 0.3, '#abfbe3'],
        ['cross', -0.1, 0.15, 0.1, 0.45],
        ['cross', -0.1, 0.45, 0.1, 0.15],
    ])
    // Anchors stay invisible until outlined.
    assert.deepEqual(draw({ noteType: 'anchor' }), [])
})
