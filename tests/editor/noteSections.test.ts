import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createNoteRenderer } from '../../src/editor/canvas/notes'
import type { DrawStep } from '../../src/editor/canvas/ordering'
import type { DrawSection } from '../../src/editor/canvas/sections'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import type {
    NoteAtlasRegion,
    NoteBody,
    RenderSurface,
    RetainedNoteBodies,
    WebGLDrawContext,
} from '../../src/rendering/context'
import type { NoteEntity } from '../../src/state/entities/slides/note'

const note = (properties: Partial<NoteEntity> = {}) =>
    ({
        type: 'note',
        beat: 2,
        left: 0,
        size: 2,
        noteType: 'default',
        noteStyle: 'default',
        flickDirection: 'none',
        connectorType: 'active',
        isConnectorSeparator: false,
        isCritical: false,
        isFake: false,
        slideId: 1,
        ...properties,
    }) as NoteEntity

const step = (entity: NoteEntity, opacity = 1): DrawStep => ({
    entity,
    opacity,
    highlighted: false,
    raised: false,
})

const section = (key: string, steps: DrawStep[]): DrawSection => ({
    key,
    steps,
    pass: 'normal',
    minBeat: Math.min(...steps.map(({ entity }) => entity.beat)),
    maxBeat: Math.max(...steps.map(({ entity }) => entity.beat)),
})

// These tests observe the domain/context boundary. Real render groups, texture
// readers, and pixels are covered separately by browser tests.
const fixture = (t: TestContext) => {
    let owner = {}
    let frame = 0
    const captures: { range: RetainedNoteBodies; bodies: readonly NoteBody[]; origin: number }[] =
        []
    const draws: RetainedNoteBodies[] = []
    const updates: { range: RetainedNoteBodies; ys: number[]; origin: number }[] = []
    const regions: NoteAtlasRegion[] = []
    const lifecycle: { kind: 'body' | 'region' | 'surface'; value: unknown }[] = []
    const transform = { a: 40, b: 0, c: 0, d: 40, e: 0, f: 0 }
    const createSurface = (width: number, height: number) => {
        const ctx = makeContext()
        const source = { destroyed: false }
        const surface = {
            width,
            height,
            getContext: () => ctx,
            dispose() {
                source.destroyed = true
                surface.width = surface.height = 0
                lifecycle.push({ kind: 'surface', value: surface })
            },
        } as unknown as RenderSurface
        ctx.createNoteAtlasRegion = () => {
            const texture = { destroyed: false, source }
            const region: NoteAtlasRegion = {
                texture: texture as NoteAtlasRegion['texture'],
                surface,
                owner,
                release() {
                    if (texture.destroyed) return
                    texture.destroyed = true
                    lifecycle.push({ kind: 'region', value: region })
                },
            }
            regions.push(region)
            return region
        }
        return surface
    }
    const makeContext = () => {
        const alphas: number[] = []
        const state = {
            globalAlpha: 1,
            globalCompositeOperation: 'source-over',
            imageSmoothingEnabled: true,
            get resourceOwner() {
                return owner
            },
            getTransform: () => ({ ...transform }),
            maxSurfaceSize: 4096,
            isContextLost: () => false,
            createSurface,
        }
        return new Proxy(state, {
            get(target, property) {
                if (property in target) return Reflect.get(target, property)
                if (property === 'save') return () => alphas.push(state.globalAlpha)
                if (property === 'restore') return () => (state.globalAlpha = alphas.pop()!)
                return () => {}
            },
        }) as unknown as WebGLDrawContext
    }
    const context = {
        ctx: makeContext(),
        scale: 40,
        pixelRatio: 1,
        ups: -2,
        bounds: { l: -12, r: 12, t: -16, b: 0, w: 24, h: 16 },
        recentlyActive: false,
        names: { names: [] },
        state: {
            bpms: [{ x: 0, y: 0, s: 0.5 }],
            store: { slides: { info: new Map() } },
        },
    } as unknown as EditorDrawContext
    context.ctx.createNoteBodies = (bodies, origin) => {
        assert.ok(bodies.length > 0)
        const range = {
            owner,
            regions: bodies.map(({ region }) => region),
            count: bodies.length,
            released: false,
        } as unknown as RetainedNoteBodies
        captures.push({ range, bodies, origin })
        return range
    }
    context.ctx.drawNoteBodies = (range) => {
        assert.equal(range.released, false)
        assert.equal(range.owner, owner)
        assert.ok(
            range.regions.every(({ texture }) => !texture.destroyed && !texture.source.destroyed),
        )
        draws.push(range)
        return true
    }
    context.ctx.updateNoteBodyPositions = (range, ys, origin) => {
        updates.push({ range, ys: Array.from(ys), origin })
        return true
    }
    context.ctx.releaseNoteBodies = (range) => {
        assert.equal(range.released, false, 'each body group is released once')
        range.released = true
        lifecycle.push({ kind: 'body', value: range })
    }
    const renderer = createNoteRenderer()
    t.after(() => renderer.clear())
    const render = (
        sections: readonly DrawSection[],
        visible: readonly DrawStep[] = sections.flatMap(({ steps }) => steps),
        hovered?: ReadonlySet<NoteEntity>,
        allSections: readonly DrawSection[] = sections,
    ) => {
        renderer.beginFrame(++frame)
        context.names!.names.length = 0
        // Production builds a fresh draw-context wrapper for each frame.
        const current = { ...context }
        renderer.prepareSections(current, allSections, sections, hovered)
        const handled = sections.map((section) => renderer.drawSection(current, section))
        assert.deepEqual(context.names!.names, [], 'section drawing retains only note bodies')
        renderer.drawVisibleNames(current, visible, hovered)
        renderer.endFrame()
        return handled
    }
    return {
        context,
        renderer,
        captures,
        draws,
        updates,
        regions,
        lifecycle,
        transform,
        render,
        restoreOwner() {
            owner = {}
        },
    }
}

test('stable note sections reuse full bodies through pans and an offscreen return', (t) => {
    const { context, captures, draws, render, transform } = fixture(t)
    let projections = 0
    const stages = new Map()
    const makeLayout = () =>
        ({
            stages,
            notePosition(entity: NoteEntity) {
                projections++
                return { left: entity.left + 4, size: entity.size }
            },
        }) as unknown as NonNullable<EditorDrawContext['composed']>
    context.composed = makeLayout()
    const first = step(note())
    const second = step(note({ beat: 14 }))
    const retained = section('notes:0', [first, second])
    const all = [retained]
    assert.deepEqual(render(all, [first]), [true])
    assert.equal(captures[0]!.bodies.length, 2, 'the section includes its offscreen member')
    assert.equal(projections, 2)
    context.bounds = { ...context.bounds, t: -24, b: -8 }
    transform.f = 320
    context.composed = makeLayout()
    render(all, [second])
    render([], [], undefined, all)
    assert.equal(
        captures[0]!.range.released,
        false,
        'an absent section stays available within budget',
    )
    render(all, [first])
    assert.equal(captures.length, 1)
    assert.equal(projections, 2, 'warm sections do not resolve composed note positions again')
    assert.ok(draws.every((range) => range === captures[0]!.range))
})

test('replacing a section under the same key updates member order and opacity', (t) => {
    const { captures, render } = fixture(t)
    const left = note({ left: -2 })
    const right = note({ left: 3 })
    render([section('same', [step(left), step(right)])])
    const first = captures[0]!
    render([section('same', [step(right, 0.25), step(left, 0.5)])])
    const replacement = captures[1]!
    assert.equal(first.range.released, true)
    assert.deepEqual(
        replacement.bodies.map(({ alpha }) => alpha),
        [0.25, 0.5],
    )
    assert.equal(replacement.bodies[0]!.x, first.bodies[1]!.x)
    assert.equal(replacement.bodies[1]!.x, first.bodies[0]!.x)
})

test('plan removal releases obsolete sections while a live preview preserves the committed body', (t) => {
    const { captures, render } = fixture(t)
    const retained = section('kept', [step(note())])
    const removed = section('removed', [step(note({ beat: 18 }))])
    render([retained, removed])
    const [keptBody, removedBody] = captures.map(({ range }) => range)
    const all = [retained]
    render(all)
    assert.equal(keptBody!.released, false)
    assert.equal(removedBody!.released, true)
    assert.deepEqual(render([{ ...retained, live: true }], [], undefined, all), [false])
    assert.equal(
        keptBody!.released,
        false,
        'temporary preview wrappers do not replace committed sections',
    )
    render(all)
    assert.equal(captures.length, 2)
})

test('layout and tempo rebuild a section while vertical scale repositions its bodies', (t) => {
    const { context, captures, render, updates } = fixture(t)
    const makeLayout = (left: number, size: number) =>
        ({
            stages: new Map(),
            notePosition: () => ({ left, size }),
        }) as unknown as NonNullable<EditorDrawContext['composed']>
    context.composed = makeLayout(4, 2)
    const retained = section('notes:0', [step(note({ beat: 8 }))])
    render([retained])
    context.composed = makeLayout(7, 3)
    render([retained])
    assert.equal(captures[0]!.range.released, true)
    assert.equal(captures[1]!.bodies[0]!.x - captures[0]!.bodies[0]!.x, 3)
    assert.ok(captures[1]!.bodies[0]!.width > captures[0]!.bodies[0]!.width)
    context.state = { ...context.state, bpms: [{ ...context.state.bpms[0]!, s: 1 }] }
    render([retained])
    assert.ok(Math.abs(captures[2]!.bodies[0]!.y - captures[1]!.bodies[0]!.y + 8) < 1e-12)
    context.ups = -1
    render([retained])
    assert.equal(captures.length, 3)
    assert.equal(updates[0]!.ys[0], captures[1]!.bodies[0]!.y)
    assert.equal(updates[0]!.range, captures[2]!.range)
    assert.ok(captures.slice(0, -1).every(({ range }) => range.released))
})

for (const composed of [false, true]) {
    test(`first-use fractional PPS matches fresh ${composed ? 'composed' : 'basic'} note placement without rebuilding artwork`, (t) => {
        const reused = fixture(t)
        const fresh = fixture(t)
        let projections = 0
        if (composed) {
            const stages = new Map()
            for (const subject of [reused, fresh])
                subject.context.composed = {
                    stages,
                    notePosition(entity: NoteEntity) {
                        if (subject === reused) projections++
                        return { left: entity.left + 1.25, size: entity.size * 0.75 }
                    },
                } as unknown as NonNullable<EditorDrawContext['composed']>
        }
        const retained = section('zoom', [
            step(note({ beat: 2 ** 20 + 0.125, left: -2, flickDirection: 'upLeft' })),
            step(note({ beat: 2 ** 20 + 1.75, left: 1, size: 1, noteType: 'damage' }), 0.4),
            step(note({ beat: 2 ** 20 + 3.375, left: 4, noteStyle: 'blue' })),
        ])
        reused.render([retained])
        const original = reused.captures[0]!
        const regionCount = reused.regions.length
        const projectionCount = projections
        for (const ups of [-2.0037, -2.13731, -2.1987654321, -1.91357, -3.00743]) {
            reused.context.ups = fresh.context.ups = ups
            // The independent reference deliberately takes the original cold
            // placement path; values stay identical, only its dependency changes.
            fresh.context.state = {
                ...fresh.context.state,
                bpms: fresh.context.state.bpms.map((entry) => ({ ...entry })),
            }
            reused.render([retained])
            fresh.render([retained])
            const update = reused.updates.at(-1)!
            const reference = fresh.captures.at(-1)!
            assert.deepEqual(
                update.ys,
                reference.bodies.map(({ y }) => y),
            )
            assert.equal(update.origin, reference.origin)
            assert.equal(update.range, original.range)
            assert.deepEqual(
                original.bodies.map(({ x, width, height, alpha }) => [x, width, height, alpha]),
                reference.bodies.map(({ x, width, height, alpha }) => [x, width, height, alpha]),
            )
        }
        assert.equal(reused.captures.length, 1)
        assert.equal(reused.regions.length, regionCount)
        assert.equal(projections, projectionCount)
        assert.equal(original.range.released, false)
    })
}

test('an offscreen section updates directly to the current PPS on return', (t) => {
    const { context, captures, updates, render } = fixture(t)
    const all = [section('return', [step(note({ beat: 3.25 }))])]
    render(all)
    context.ups = -2.13731
    render([], [], undefined, all)
    context.ups = -3.00743
    render([], [], undefined, all)
    assert.equal(updates.length, 0)
    render(all)
    assert.equal(captures.length, 1)
    assert.equal(updates.length, 1)
    assert.equal(updates[0]!.origin, 3.25 * 0.5 * context.ups)
    assert.equal(updates[0]!.range, captures[0]!.range)
})

test('a declined position update rebuilds the affected section without replaying it', (t) => {
    const { context, captures, draws, render } = fixture(t)
    const all = [section('decline', [step(note())])]
    render(all)
    context.ctx.updateNoteBodyPositions = () => false
    context.ups = -2.12345
    render(all)
    assert.equal(captures.length, 2)
    assert.equal(captures[0]!.range.released, true)
    assert.deepEqual(
        draws,
        captures.map(({ range }) => range),
    )
})

test('PPS reuse does not bypass width, density, or linear-transform invalidation', (t) => {
    const { context, captures, render, transform } = fixture(t)
    const all = [section('dimensions', [step(note())])]
    render(all)
    context.ups = -2.12345
    context.scale = 50
    render(all)
    context.ups = -2.23456
    context.pixelRatio = 2
    render(all)
    context.ups = -2.34567
    transform.d = -40
    render(all)
    assert.equal(captures.length, 4)
    assert.ok(captures.slice(0, -1).every(({ range }) => range.released))
})

test('replacing slide information invalidates roles even when the section and map survive', (t) => {
    const { context, captures, render } = fixture(t)
    const middle = note()
    const head = note({ beat: 0 })
    const tail = note({ beat: 4 })
    const retained = section('notes:0', [step(middle)])
    const infos = context.state.store.slides.info
    render([retained])
    infos.set(middle.slideId, [{ note: middle, activeHead: head, activeTail: tail }] as never)
    render([retained])
    assert.equal(captures[0]!.range.released, true)
    assert.notEqual(captures[1]!.bodies[0]!.region, captures[0]!.bodies[0]!.region)
    infos.delete(middle.slideId)
    render([retained])
    assert.equal(captures[2]!.bodies[0]!.region, captures[0]!.bodies[0]!.region)
})

test('hidden anchors do not disable sections and names only follow visible notes', (t) => {
    const { context, captures, render } = fixture(t)
    context.showGroupName = true
    context.defaultGroupId = 1 as never
    context.state = { ...context.state, groups: new Map([[2, { name: 'Group' }]]) } as never
    context.ctx.globalAlpha = 0.75
    const anchor = step(note({ noteType: 'anchor', groupId: 2 as never }), 0.5)
    const normal = step(note({ beat: 6, groupId: 2 as never }), 0.5)
    const retained = section('notes:0', [anchor, normal])
    assert.deepEqual(render([retained]), [true])
    assert.equal(captures[0]!.bodies.length, 1)
    assert.equal(context.names!.names.length, 0)
    render([retained], [normal], new Set([anchor.entity as NoteEntity]))
    assert.equal(captures[1]!.bodies.length, 2)
    assert.equal(context.names!.names.length, 0, 'offscreen hovered anchors cannot enqueue names')
    context.recentlyActive = true
    render([retained], [normal])
    assert.deepEqual(
        context.names!.names.map(({ text, owner, alpha, highlighted }) => [
            text,
            owner,
            alpha,
            highlighted,
        ]),
        [['Group', normal.entity, 0.375, false]],
    )
    assert.equal(context.ctx.globalAlpha, 0.75)
    context.recentlyActive = false
    render([retained], [anchor], new Set([anchor.entity as NoteEntity]))
    assert.equal(context.names!.names.length, 1)
    assert.equal(context.names!.names[0]!.owner, anchor.entity)
    assert.equal(context.names!.names[0]!.highlighted, true)
    render([retained])
    assert.equal(captures.at(-1)!.bodies.length, 1)
    assert.equal(context.names!.names.length, 0)
})

test('borrowed crops and restored resource owners are revalidated before replay', (t) => {
    const { captures, render, restoreOwner } = fixture(t)
    const retained = section('notes:0', [step(note()), step(note({ noteStyle: 'red' }))])
    render([retained])
    const original = captures[0]!
    original.bodies[0]!.region.release()
    render([retained])
    const replacement = captures[1]!
    assert.equal(original.range.released, true)
    assert.notEqual(replacement.bodies[0]!.region, original.bodies[0]!.region)
    assert.equal(replacement.bodies[1]!.region, original.bodies[1]!.region)
    restoreOwner()
    render([retained])
    assert.equal(replacement.range.released, true)
    assert.notEqual(captures[2]!.range.owner, replacement.range.owner)
    assert.ok(replacement.bodies.every(({ region }) => region.texture.destroyed))
})

test('section retention bounds groups and evicts absent sections before active ones', (t) => {
    const { captures, render } = fixture(t)
    const sections = Array.from({ length: 513 }, (_, i) =>
        section(`notes:${i}`, [step(note({ beat: i * 16 }))]),
    )
    const handled = render(sections)
    assert.equal(handled.filter(Boolean).length, 512)
    assert.equal(captures.length, 512)
    const pinned = captures[0]!.range
    const absent = captures[1]!.range
    assert.deepEqual(render([sections[512]!, sections[0]!], undefined, undefined, sections), [
        true,
        true,
    ])
    assert.equal(
        pinned.released,
        false,
        'preparation protects every active section before allocation',
    )
    assert.equal(absent.released, true)
    assert.equal(captures.filter(({ range }) => !range.released).length, 512)
    render([sections[1]!], undefined, undefined, sections)
    assert.equal(captures.length, 514, 'returning to an evicted section rebuilds its body')
})

test('sprite capacity declines an oversized section and clearing releases bodies before artwork', (t) => {
    const { captures, lifecycle, render, renderer } = fixture(t)
    const retained = section(
        'dense',
        Array.from({ length: 16_384 }, (_, i) => step(note({ beat: i / 1024 }))),
    )
    assert.deepEqual(render([retained]), [true])
    assert.equal(captures[0]!.range.count, 16_384)
    const oversized = section('oversized', [...retained.steps, step(note({ beat: 16 }))])
    assert.deepEqual(render([retained, oversized]), [true, false])
    assert.equal(captures.length, 1)
    const beforeClear = lifecycle.length
    renderer.clear()
    const cleanup = lifecycle.slice(beforeClear)
    assert.equal(cleanup[0]!.kind, 'body')
    assert.ok(cleanup.some(({ kind }) => kind === 'region'))
    assert.equal(cleanup.at(-1)!.kind, 'surface')
    assert.ok(captures.every(({ range }) => range.released))
    render([section('after-clear', [step(note())])])
    assert.equal(captures.length, 2, 'the renderer remains reusable after explicit clearing')
})

test('a section with outlines keeps an idle and an active variant through activity flips', (t) => {
    const { context, captures, draws, render } = fixture(t)
    const anchor = step(note({ noteType: 'anchor' }))
    const normal = step(note({ beat: 6 }))
    const outlined = section('outlined', [anchor, normal])
    const plain = section('plain', [step(note({ beat: 10 }))])
    const all = [outlined, plain]
    render(all)
    assert.equal(captures.length, 2)
    context.recentlyActive = true
    render(all)
    // Only the section with an anchor has an active variant, which draws the anchor's outline.
    assert.equal(captures.length, 3)
    assert.equal(captures[2]!.bodies.length, 2)
    for (const active of [false, true, false, true]) {
        context.recentlyActive = active
        draws.length = 0
        render(all)
        assert.equal(captures.length, 3, 'a flip replays the variant it needs')
        assert.equal(draws[0], captures[active ? 2 : 0]!.range)
        assert.equal(draws[1], captures[1]!.range)
    }
    assert.ok(captures.every(({ range }) => !range.released))
    render([plain])
    assert.ok(captures[0]!.range.released && captures[2]!.range.released)
    assert.equal(captures[1]!.range.released, false)
})
