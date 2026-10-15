import assert from 'node:assert/strict'
import test from 'node:test'
import { Container, Sprite, Texture, TextureSource } from 'pixi.js'
import {
    WebGLDrawContext,
    type NoteAtlasRegion,
    type NoteBody,
    type RenderSurface,
    type RetainedNoteBodies,
} from '../../src/rendering/context'
import type { Matrix } from '../../src/rendering/matrix'

// Exercise the actual create/update/draw/release methods and real Pixi objects.
// Only readiness, atlas validity and GPU presentation are supplied by this CPU fixture.
function fixture(matrix: Matrix = [2.5, 0, 0, -3.75, 11.125, 47.375]) {
    const scene = new Container()
    const source = new TextureSource({ width: 16, height: 8, scaleMode: 'linear' })
    const textures = [new Texture({ source }), new Texture({ source })]
    const owner = {}
    const invalidRegions = new Set<NoteAtlasRegion>()
    const calls = { flushes: 0, producers: 0, readers: 0 }
    const page = {
        getContext: () => ({
            flush: () => {
                calls.producers++
            },
        }),
    } as unknown as RenderSurface
    const regions = textures.map((texture): NoteAtlasRegion => ({
        texture,
        surface: page,
        owner,
        release() {
            throw new Error('note groups must not own atlas regions')
        },
    }))
    const state = {
        matrix,
        clips: [] as unknown[],
        globalAlpha: 0.625,
        imageSmoothingEnabled: true,
        globalCompositeOperation: 'source-over',
    }
    const internals = {
        state,
        scene,
        layers: [] as unknown[],
        spritePool: [] as Sprite[],
        retained: new Map(),
        retainedNoteBodies: new Map<Container, RetainedNoteBodies>(),
        reads: new Set<TextureSource>(),
        resources: {
            resourceOwner: owner,
            lost: false,
            flushReaders: () => {
                calls.flushes++
            },
            addReader: () => {
                calls.readers++
            },
        },
        available: true,
        disposed: false,
        ensure: () => internals.available,
        mutate: () => internals.available,
        parent: () => scene,
        validNoteRegion: (region: NoteAtlasRegion) =>
            region.owner === internals.resources.resourceOwner &&
            !invalidRegions.has(region) &&
            !region.texture.destroyed &&
            !region.texture.source.destroyed,
        flushReader: () => {},
        flush: () => {
            calls.flushes++
            scene.removeChildren()
            internals.reads.clear()
        },
    }
    const context = Object.assign(
        Object.create(WebGLDrawContext.prototype) as object,
        internals,
    ) as unknown as WebGLDrawContext
    Object.defineProperty(context, 'resourceOwner', {
        get: () => internals.resources.resourceOwner,
    })
    const ranges: RetainedNoteBodies[] = []
    const create = (ys: ArrayLike<number>, origin: number) => {
        const bodies: NoteBody[] = Array.from(ys, (y, index) => ({
            region: regions[index % regions.length]!,
            x: index * 0.75 - 1.125,
            y,
            width: 1.125 + index,
            height: 0.625,
            alpha: 0.25 + index * 0.125,
        }))
        const range = context.createNoteBodies(bodies, origin)
        assert.ok(range)
        ranges.push(range)
        return range
    }
    const cleanup = () => {
        for (const range of ranges) {
            if (range.group.destroyed) continue
            range.group.removeFromParent()
            // A refusal case may deliberately replace the ownership map or released flag.
            range.released = false
            internals.retainedNoteBodies.set(range.group, range)
            context.releaseNoteBodies(range)
        }
        for (const sprite of internals.spritePool) sprite.destroy()
        for (const texture of textures) texture.destroy(false)
        source.destroy()
        scene.destroy({ children: true })
    }
    return { context, state, internals, scene, regions, invalidRegions, calls, create, cleanup }
}

const spriteValues = (range: RetainedNoteBodies) =>
    range.group.children.map((child) => {
        assert.ok(child instanceof Sprite)
        return {
            x: child.x,
            y: child.y,
            scaleX: child.scale.x,
            scaleY: child.scale.y,
            alpha: child.alpha,
            texture: child.texture,
            rotation: child.rotation,
            skew: [child.skew.x, child.skew.y],
        }
    })

const snapshot = (range: RetainedNoteBodies) => ({
    matrix: [...range.matrix],
    group: range.group,
    parent: range.group.parent,
    groupPosition: [range.group.x, range.group.y],
    children: [...range.group.children],
    sprites: spriteValues(range),
    regions: range.regions,
    pages: range.pages,
    sources: range.sources,
    count: range.count,
    alpha: range.alpha,
    smoothing: range.smoothing,
    released: range.released,
})

test('PPS position updates equal fresh groups at fractional and far origins with signed matrices', () => {
    for (const matrix of [
        [2.5, 0, 0, -3.75, 11.125, 47.375],
        [-17.25, 0, 0, 0.625, -31.75, 0.125],
        [-0.125, 0, 0, -63.5, 0, -103.375],
    ] satisfies Matrix[]) {
        const value = fixture(matrix)
        try {
            const reused = value.create([0.125, -0.375, 7.3125], 0.0625)
            const identities = [...reused.group.children]
            const original = spriteValues(reused)
            const regions = reused.regions
            for (const origin of [17.123456789, -98765.4321, 2 ** 40 + 0.125, -(2 ** 39) - 0.375]) {
                const ys = new Float64Array([origin - 0.15625, origin + 17.3125, origin - 301.125])
                const input = [...ys]
                assert.equal(value.context.updateNoteBodyPositions(reused, ys, origin), true)
                const fresh = value.create(ys, origin)
                assert.deepEqual(spriteValues(reused), spriteValues(fresh))
                assert.deepEqual(reused.matrix, fresh.matrix)
                assert.deepEqual([...ys], input, 'caller position data is not modified')
                assert.equal(reused.regions, regions)
                reused.group.children.forEach((child, index) =>
                    assert.equal(child, identities[index]),
                )
                spriteValues(reused).forEach((sprite, index) => {
                    assert.deepEqual(
                        { ...sprite, y: original[index]!.y },
                        original[index],
                        'only the local y position changes',
                    )
                })
            }
        } finally {
            value.cleanup()
        }
    }
})

test('invalid positions and origins refuse atomically, including overflow after a valid first item', () => {
    const value = fixture([1, 0, 0, 4, 0, 0])
    try {
        const range = value.create([1, 2, 3], 0.5)
        for (const [ys, origin] of [
            [[100, NaN, 300], 4],
            [[100, Infinity, 300], 4],
            [[100, Number.MAX_VALUE, 300], 4],
            [[100, 200, 300], NaN],
            [[100, 200, 300], Infinity],
            [[100, 200, 300], Number.MAX_VALUE],
            [[100, 200], 4],
            [[100, 200, 300, 400], 4],
            [{ length: 3, 0: 100, 2: 300 }, 4],
        ] as [ArrayLike<number>, number][]) {
            const before = snapshot(range)
            assert.equal(value.context.updateNoteBodyPositions(range, ys, origin), false)
            assert.deepEqual(snapshot(range), before)
        }
    } finally {
        value.cleanup()
    }
})

test('queued, stale, incompatible and invalid-region note updates leave the complete group untouched', () => {
    type Fixture = ReturnType<typeof fixture>
    const guards: [string, (value: Fixture, range: RetainedNoteBodies) => void][] = [
        [
            'not ready',
            (value) => {
                value.internals.available = false
            },
        ],
        [
            'released',
            (_value, range) => {
                range.released = true
            },
        ],
        [
            'owner replaced',
            (value) => {
                value.internals.resources.resourceOwner = {}
            },
        ],
        [
            'map removed',
            (value, range) => {
                value.internals.retainedNoteBodies.delete(range.group)
            },
        ],
        [
            'map identity replaced',
            (value, range) => {
                value.internals.retainedNoteBodies.set(range.group, { ...range })
            },
        ],
        [
            'queued parent',
            (value, range) => {
                value.scene.addChild(range.group)
            },
        ],
        [
            'layers',
            (value) => {
                value.internals.layers.push({})
            },
        ],
        [
            'clips',
            (value) => {
                value.state.clips.push({})
            },
        ],
        [
            'composite operation',
            (value) => {
                value.state.globalCompositeOperation = 'erase'
            },
        ],
        [
            'alpha',
            (value) => {
                value.state.globalAlpha = 0.5
            },
        ],
        [
            'smoothing',
            (value) => {
                value.state.imageSmoothingEnabled = false
            },
        ],
        [
            'linear x',
            (value) => {
                value.state.matrix[0] *= 2
            },
        ],
        [
            'linear y',
            (value) => {
                value.state.matrix[3] *= 2
            },
        ],
        [
            'skew',
            (value) => {
                value.state.matrix[1] = 0.125
            },
        ],
        [
            'nonfinite translation',
            (value) => {
                value.state.matrix[4] = NaN
            },
        ],
        [
            'invalid second region',
            (value) => {
                value.invalidRegions.add(value.regions[1]!)
            },
        ],
        [
            'extra child',
            (_value, range) => {
                range.group.addChild(new Sprite())
            },
        ],
    ]
    for (const [name, invalidate] of guards) {
        const value = fixture()
        try {
            const range = value.create([1, 2, 3], 0)
            invalidate(value, range)
            const before = snapshot(range)
            assert.equal(value.context.updateNoteBodyPositions(range, [10, 20, 30], 8), false, name)
            assert.deepEqual(snapshot(range), before, name)
            assert.equal(value.calls.flushes, 0, 'refusal does not present queued work')
        } finally {
            value.cleanup()
        }
    }
})

test('updated note groups draw at the new origin and retain atlas ownership through real release', () => {
    const value = fixture()
    try {
        const range = value.create([100.125, 101.5, 103.75], 100)
        const children = [...range.group.children]
        assert.ok(value.context.updateNoteBodyPositions(range, [110.1375, 111.65, 114.125], 110))
        assert.ok(value.context.drawNoteBodies(range))
        assert.equal(range.group.parent, value.scene)
        assert.deepEqual(
            [range.group.x, range.group.y],
            [value.state.matrix[4], value.state.matrix[5] - range.matrix[5]],
        )
        assert.equal(value.calls.producers, 1, 'shared atlas producer finishes once')
        assert.equal(value.calls.readers, 1, 'the shared atlas source is registered once')
        const queued = snapshot(range)
        assert.equal(value.context.updateNoteBodyPositions(range, [120, 122, 124], 120), false)
        assert.deepEqual(snapshot(range), queued)
        // The fixture presentation detaches the group, as an actual flush does.
        value.context.flush()
        value.state.matrix[4] += 0.375
        value.state.matrix[5] -= 17.125
        assert.ok(value.context.updateNoteBodyPositions(range, [120, 122, 124], 120))
        assert.ok(value.context.drawNoteBodies(range))
        assert.deepEqual(
            [range.group.x, range.group.y],
            [value.state.matrix[4], value.state.matrix[5] - range.matrix[5]],
        )
        range.group.children.forEach((child, index) => assert.equal(child, children[index]))
        value.context.releaseNoteBodies(range)
        assert.equal(value.calls.flushes, 2, 'queued work is flushed before its group is retired')
        assert.equal(range.released, true)
        assert.equal(range.group.destroyed, true)
        assert.equal(value.internals.retainedNoteBodies.size, 0)
        assert.equal(value.internals.spritePool.length, children.length)
        assert.ok(children.every((child) => value.internals.spritePool.includes(child as Sprite)))
        assert.ok(children.every((child) => (child as Sprite).texture === Texture.EMPTY))
        assert.ok(
            value.regions.every(
                (region) => !region.texture.destroyed && !region.texture.source.destroyed,
            ),
        )
        value.context.releaseNoteBodies(range)
        assert.equal(value.calls.flushes, 2)
        assert.equal(value.context.drawNoteBodies(range), false)
        assert.equal(value.context.updateNoteBodyPositions(range, [0, 1, 2], 0), false)
    } finally {
        value.cleanup()
    }
})
