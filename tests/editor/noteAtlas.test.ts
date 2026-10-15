import assert from 'node:assert/strict'
import test from 'node:test'
import { createNoteAtlas } from '../../src/editor/canvas/noteAtlas'
import type { WebGLDrawContext } from '../../src/rendering/context'

type FakeRegion = {
    surface: object
    owner: object
    texture: {
        frame: { x: number; y: number; width: number; height: number }
        source: { destroyed: boolean }
        destroyed: boolean
    }
    releases: number
    release: () => void
}

const fixture = () => {
    let owner = {}
    let lost = false
    const surfaces: {
        width: number
        height: number
        disposed: boolean
        source: { destroyed: boolean }
        regions: FakeRegion[]
    }[] = []
    const ctx = {
        maxSurfaceSize: 4096,
        get resourceOwner() {
            return owner
        },
        isContextLost: () => lost,
        createSurface(width: number, height: number) {
            const source = { destroyed: false }
            const regions: FakeRegion[] = []
            const surface = {
                width,
                height,
                disposed: false,
                source,
                regions,
                getContext: () => ({
                    get resourceOwner() {
                        return owner
                    },
                    isContextLost: () => lost,
                    createNoteAtlasRegion(x: number, y: number, width: number, height: number) {
                        const region: FakeRegion = {
                            surface,
                            owner,
                            texture: {
                                frame: Object.freeze({ x, y, width, height }),
                                source,
                                destroyed: false,
                            },
                            releases: 0,
                            release() {
                                if (region.texture.destroyed) return
                                region.texture.destroyed = true
                                region.releases++
                            },
                        }
                        regions.push(region)
                        return region
                    },
                }),
                dispose() {
                    assert.ok(regions.every((region) => region.texture.destroyed))
                    surface.disposed = true
                    source.destroyed = true
                },
            }
            surfaces.push(surface)
            return surface
        },
    }
    return {
        ctx: ctx as unknown as WebGLDrawContext,
        surfaces,
        lose() {
            lost = true
        },
        restore() {
            lost = false
            owner = {}
        },
        pixels: () =>
            surfaces.reduce(
                (sum, surface) => sum + (surface.disposed ? 0 : surface.width * surface.height),
                0,
            ),
    }
}

test('atlas slots share a page, keep a filtering gutter and reuse adjacent released space', () => {
    const { ctx, surfaces } = fixture()
    const atlas = createNoteAtlas()
    const slots = Array.from({ length: 4 }, () => atlas.allocate(ctx, 200, 20)!)
    assert.equal(surfaces.length, 1)
    assert.deepEqual(
        slots.map(({ x, y }) => [x, y]),
        [
            [1, 1],
            [203, 1],
            [405, 1],
            [607, 1],
        ],
    )
    slots[1]!.release()
    slots[2]!.release()
    assert.equal(slots[1]!.valid(), false)
    assert.equal(surfaces[0]!.regions[1]!.texture.destroyed, true)
    assert.equal(surfaces[0]!.regions[0]!.texture.destroyed, false)
    assert.equal(surfaces[0]!.source.destroyed, false, 'a region borrows its page source')
    assert.deepEqual(surfaces[0]!.regions[1]!.texture.frame, {
        x: 203,
        y: 1,
        width: 200,
        height: 20,
    })
    const wider = atlas.allocate(ctx, 390, 20)!
    assert.equal(wider.surface, slots[0]!.surface)
    assert.deepEqual([wider.x, wider.y], [203, 1])
    slots[1]!.release() // Repeated release cannot free a newly reused slot.
    assert.equal(wider.valid(), true)
    assert.equal(surfaces[0]!.regions[1]!.releases, 1)
    assert.equal(surfaces[0]!.regions.at(-1)!.texture.destroyed, false)
    for (const slot of slots) slot.release()
    assert.equal(surfaces[0]!.disposed, false)
    wider.release()
    assert.equal(surfaces[0]!.disposed, true)
    assert.ok(surfaces[0]!.regions.every((region) => region.releases === 1))
    assert.equal(surfaces[0]!.source.destroyed, true)
})

test('atlas capacity counts whole GPU pages, and freeing one slot does not evict its neighbors', () => {
    const { ctx, surfaces, pixels } = fixture()
    const atlas = createNoteAtlas()
    const slots = Array.from({ length: 16 }, () => atlas.allocate(ctx, 500, 500)!)
    assert.ok(slots.every(Boolean))
    assert.equal(surfaces.length, 4)
    assert.equal(pixels(), 4 * 1024 * 1024)
    assert.equal(atlas.allocate(ctx, 500, 500), undefined)
    slots[0]!.release()
    const replacement = atlas.allocate(ctx, 500, 500)!
    assert.equal(replacement.surface, slots[1]!.surface)
    assert.equal(slots[1]!.valid(), true)
    assert.equal(surfaces.length, 4)
    atlas.clear()
    assert.equal(pixels(), 0)
    assert.equal(replacement.valid(), false)
    assert.ok(surfaces.every((surface) => surface.source.destroyed))
    assert.ok(surfaces.every((surface) => surface.regions.every((region) => region.releases === 1)))
})

test('atlas ownership survives multiple panes and invalidates old pages after context restoration', () => {
    const first = fixture()
    const second = fixture()
    const atlas = createNoteAtlas()
    const a = atlas.allocate(first.ctx, 50, 30)!
    const b = atlas.allocate(second.ctx, 50, 30)!
    assert.notEqual(a.surface, b.surface)
    assert.equal(atlas.allocate(first.ctx, 50, 30)!.surface, a.surface)
    first.lose()
    assert.equal(a.valid(), false)
    first.restore()
    assert.equal(a.valid(), false, 'a new owner cannot reuse old GPU storage')
    const restored = atlas.allocate(first.ctx, 50, 30)!
    assert.notEqual(restored.surface, a.surface)
    assert.equal(first.surfaces[0]!.disposed, true)
    assert.ok(first.surfaces[0]!.regions.every((region) => region.texture.destroyed))
    assert.equal(second.surfaces[0]!.source.destroyed, false)
    assert.equal(b.valid(), true)
    atlas.clear()
    assert.equal(first.pixels() + second.pixels(), 0)
})

test('artwork wider than an atlas page uses bounded standalone storage', () => {
    const { ctx, surfaces, pixels } = fixture()
    const atlas = createNoteAtlas()
    const wide = atlas.allocate(ctx, 2000, 300)!
    assert.deepEqual([wide.x, wide.y, wide.width, wide.height], [0, 0, 2000, 300])
    assert.deepEqual([surfaces[0]!.width, surfaces[0]!.height], [2000, 300])
    const ordinary = atlas.allocate(ctx, 50, 30)!
    assert.notEqual(ordinary.surface, wide.surface)
    assert.equal(pixels(), 600_000 + 1024 * 1024)
    wide.release()
    assert.equal(pixels(), 1024 * 1024)
    atlas.clear()
})
