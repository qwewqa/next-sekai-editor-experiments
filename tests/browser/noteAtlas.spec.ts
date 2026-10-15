import { expect, test } from '@playwright/test'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import type { NoteEntity } from '../../src/state/entities/slides/note'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

for (const pixelRatio of [1, 1.25]) {
    test.describe(`note atlas at DPR ${pixelRatio}`, () => {
        test.use({ deviceScaleFactor: pixelRatio })

        test('cache overflow and eviction preserve complete faded artwork', async ({
            page,
        }, testInfo) => {
            await page.addInitScript(installCanvasCounters)
            await page.goto('/')
            await expect(page.locator('canvas.editor-chart')).toBeVisible()
            await page.evaluate(installEditorFixture)

            const result = await page.evaluate(async () => {
                const { appImport, fixtures, show, history } = window.editorTest
                const { createNoteRenderer } = await appImport<
                    typeof import('../../src/editor/canvas/notes')
                >('/src/editor/canvas/notes.ts')
                const { RenderSurface, getDrawContext } = await appImport<
                    typeof import('../../src/rendering/context')
                >('/src/rendering/context.ts')
                show(fixtures.interaction)
                const state = history.state.value
                const base = [...state.store.slides.note.values()].flat()[0]!
                const ratio = window.devicePixelRatio
                const width = Math.round(320 * ratio)
                const height = Math.round(180 * ratio)
                const scale = 40
                // Fractional placement exercises texture sampling as well as fractional DPR.
                const origin = { x: 85.35, y: 110.35 }
                const owner = getDrawContext(
                    document.querySelector<HTMLCanvasElement>('canvas.editor-chart')!,
                )
                const surface = owner.createSurface(width, height)
                const ctx = surface.getContext()
                const compositeSurface = owner.createSurface(width, height)
                const composite = compositeSurface.getContext()
                const context: EditorDrawContext = {
                    ctx,
                    scale,
                    pixelRatio: ratio,
                    bounds: {
                        l: -origin.x / scale,
                        r: (320 - origin.x) / scale,
                        t: -origin.y / scale,
                        b: (180 - origin.y) / scale,
                        w: 320 / scale,
                        h: 180 / scale,
                    },
                    ups: 1,
                    state,
                    defaultGroupId: base.groupId,
                    showStageName: false,
                    showGroupName: false,
                    nameContrast: false,
                    recentlyActive: true,
                    fontFamily: 'Arial',
                    fontMiddle: 0,
                    figureMiddle: 0,
                }
                type Clip = { x: number; y: number; w: number; h: number }
                type Scenario = {
                    name: string
                    note: Partial<NoteEntity>
                    clip?: Clip
                    tipY?: number
                }
                const scenarios: Scenario[] = [
                    { name: 'layered tap body', note: {} },
                    { name: 'fake tap crossing its body', note: { isFake: true } },
                    {
                        name: 'upper-left flick miter',
                        note: { flickDirection: 'upLeft' },
                        tipY: origin.y + (0.3 - 1.1) * scale,
                    },
                    {
                        name: 'lower-right critical flick',
                        note: { flickDirection: 'downRight', isCritical: true },
                    },
                    {
                        name: 'trace diamond and fake cross',
                        note: { noteType: 'trace', flickDirection: 'upRight', isFake: true },
                    },
                    {
                        name: 'zero-width tick placeholder',
                        note: { noteType: 'forceTick', size: 0, isFake: true },
                    },
                    { name: 'highlighted anchor outline', note: { noteType: 'anchor' } },
                    {
                        name: 'flick clipped at all four borders',
                        note: { flickDirection: 'upLeft', isFake: true },
                        clip: { x: 115.4, y: 80.3, w: 93.3, h: 48.8 },
                    },
                ]
                const note = (overrides: Partial<NoteEntity> = {}): NoteEntity => ({
                    ...base,
                    // Like a new creation ghost, these isolated notes have no slide metadata.
                    slideId: -1 as NoteEntity['slideId'],
                    noteType: 'forceNonTick',
                    size: 3.25,
                    flickDirection: 'none',
                    isCritical: false,
                    isFake: false,
                    ...overrides,
                })
                type ImageCall = { x: number; y: number; alpha: number }
                const calls: ImageCall[] = []
                const artworkSurfaces = new Set<ReturnType<typeof owner.createSurface>>()
                const drawImage = ctx.drawImage
                const drawNoteAtlasRegion = ctx.drawNoteAtlasRegion
                type Region = Parameters<typeof drawNoteAtlasRegion>[0]
                const artworkRegions = new Set<Region>()
                ctx.drawNoteAtlasRegion = function (region, x, y, width, height) {
                    artworkSurfaces.add(region.surface)
                    artworkRegions.add(region)
                    calls.push({
                        x: region.texture.frame.x,
                        y: region.texture.frame.y,
                        alpha: this.globalAlpha,
                    })
                    return drawNoteAtlasRegion.call(this, region, x, y, width, height)
                }
                type ImageSource = Parameters<typeof drawImage>[0]
                ctx.drawImage = function (source: ImageSource, ...args: number[]) {
                    if (source instanceof RenderSurface && args.length === 8) {
                        artworkSurfaces.add(source)
                        calls.push({ x: args[0]!, y: args[1]!, alpha: this.globalAlpha })
                    }
                    return (drawImage as (source: ImageSource, ...args: number[]) => void).call(
                        this,
                        source,
                        ...args,
                    )
                }
                const cached = createNoteRenderer()
                const crowded = createNoteRenderer()
                type Renderer = ReturnType<typeof createNoteRenderer>
                const render = (renderer: Renderer, scenario: Scenario) => {
                    ctx.clear()
                    calls.length = 0
                    ctx.save()
                    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
                    if (scenario.clip) {
                        const { x, y, w, h } = scenario.clip
                        ctx.beginPath()
                        ctx.rect(x, y, w, h)
                        ctx.clip()
                    }
                    ctx.setTransform(
                        scale * ratio,
                        0,
                        0,
                        scale * ratio,
                        origin.x * ratio,
                        origin.y * ratio,
                    )
                    ctx.globalAlpha = 0.75
                    renderer.draw(context, note(scenario.note), true, 0.5, { left: 0, y: 0 })
                    ctx.restore()
                    const pixels = ctx.getImageData(0, 0, width, height).data
                    const over = (color: string) => {
                        composite.clear()
                        composite.fillStyle = color
                        composite.fillRect(0, 0, width, height)
                        composite.drawImage(surface, 0, 0)
                        return composite.getImageData(0, 0, width, height).data
                    }
                    let maxAlpha = 0
                    let top = height
                    let outsideClip = 0
                    const clipEdges = { left: 0, top: 0, right: 0, bottom: 0 }
                    for (let y = 0; y < height; y++) {
                        for (let x = 0; x < width; x++) {
                            const alpha = pixels[(y * width + x) * 4 + 3]!
                            if (!alpha) continue
                            maxAlpha = Math.max(maxAlpha, alpha)
                            top = Math.min(top, y)
                            if (!scenario.clip) continue
                            const clip = scenario.clip
                            const l = Math.floor(clip.x * ratio)
                            const t = Math.floor(clip.y * ratio)
                            const r = Math.ceil((clip.x + clip.w) * ratio)
                            const b = Math.ceil((clip.y + clip.h) * ratio)
                            if (x < l || y < t || x >= r || y >= b) outsideClip++
                            if (x >= l && x < l + 2) clipEdges.left++
                            if (y >= t && y < t + 2) clipEdges.top++
                            if (x >= r - 2 && x < r) clipEdges.right++
                            if (y >= b - 2 && y < b) clipEdges.bottom++
                        }
                    }
                    return {
                        pixels,
                        onBlack: over('#000'),
                        onWhite: over('#fff'),
                        calls: [...calls],
                        maxAlpha,
                        top,
                        outsideClip,
                        clipEdges,
                    }
                }
                const compare = (expected: Uint8ClampedArray, actual: Uint8ClampedArray) => {
                    let maxDelta = 0
                    let different = 0
                    let maxAlphaDelta = 0
                    let maxPremultipliedDelta = 0
                    const samples: {
                        x: number
                        y: number
                        expected: number[]
                        actual: number[]
                        premultipliedDelta: number[]
                    }[] = []
                    for (let i = 0; i < expected.length; i += 4) {
                        let differs = false
                        const premultipliedDelta: number[] = []
                        for (let channel = 0; channel < 4; channel++) {
                            const delta = Math.abs(expected[i + channel]! - actual[i + channel]!)
                            maxDelta = Math.max(maxDelta, delta)
                            if (delta > 1) {
                                different++
                                differs = true
                            }
                            if (channel === 3) maxAlphaDelta = Math.max(maxAlphaDelta, delta)
                            else {
                                const premultiplied = Math.abs(
                                    (expected[i + channel]! * expected[i + 3]! -
                                        actual[i + channel]! * actual[i + 3]!) /
                                        255,
                                )
                                maxPremultipliedDelta = Math.max(
                                    maxPremultipliedDelta,
                                    premultiplied,
                                )
                                premultipliedDelta.push(premultiplied)
                            }
                        }
                        if (differs && samples.length < 64)
                            samples.push({
                                x: (i / 4) % width,
                                y: Math.floor(i / 4 / width),
                                expected: [...expected.slice(i, i + 4)],
                                actual: [...actual.slice(i, i + 4)],
                                premultipliedDelta,
                            })
                    }
                    return { maxDelta, different, maxAlphaDelta, maxPremultipliedDelta, samples }
                }
                const lifecycle = {
                    artworkSurfaceCount: 0,
                    artworkRegionCount: 0,
                    artworkRegionsReleased: false,
                    artworkReleased: false,
                    targetAliveAfterArtworkClear: false,
                    targetReleased: false,
                    compositeReleased: false,
                    ownerAlive: false,
                }
                try {
                    cached.beginFrame(1)
                    crowded.beginFrame(1)
                    const reference = scenarios.map((scenario) => render(cached, scenario))
                    // Each distinct width gets a sprite key. All 513 are used in one
                    // frame, so the 512-entry cache cannot evict its current working set.
                    ctx.setTransform(scale * ratio, 0, 0, scale * ratio, 0, 0)
                    for (let index = 0; index < 513; index++)
                        crowded.draw(context, note({ size: 1 + index / 1024 }), true, 0.5, {
                            left: -1000,
                            y: -1000,
                        })
                    const overflow = scenarios.map((scenario) => render(crowded, scenario))
                    // Once that frame ends, old variants may be evicted and their atlas
                    // slots reused. The same artwork must still retain all edge pixels.
                    crowded.beginFrame(2)
                    const evicted = scenarios.map((scenario) => render(crowded, scenario))
                    return {
                        ratio,
                        lifecycle,
                        cases: scenarios.map((scenario, index) => {
                            const baseline = reference[index]!
                            const fallback = overflow[index]!
                            const recached = evicted[index]!
                            return {
                                name: scenario.name,
                                tipRow:
                                    scenario.tipY === undefined
                                        ? undefined
                                        : Math.floor(scenario.tipY * ratio),
                                clipped: !!scenario.clip,
                                reference: {
                                    ...baseline,
                                    pixels: undefined,
                                    onBlack: undefined,
                                    onWhite: undefined,
                                },
                                overflow: {
                                    ...fallback,
                                    pixels: undefined,
                                    onBlack: undefined,
                                    onWhite: undefined,
                                },
                                recached: {
                                    ...recached,
                                    pixels: undefined,
                                    onBlack: undefined,
                                    onWhite: undefined,
                                },
                                overflowDifference: compare(baseline.pixels, fallback.pixels),
                                evictionDifference: compare(baseline.pixels, recached.pixels),
                                overflowOnBlack: compare(baseline.onBlack, fallback.onBlack),
                                overflowOnWhite: compare(baseline.onWhite, fallback.onWhite),
                                evictionOnBlack: compare(baseline.onBlack, recached.onBlack),
                                evictionOnWhite: compare(baseline.onWhite, recached.onWhite),
                            }
                        }),
                    }
                } finally {
                    cached.clear()
                    crowded.clear()
                    // The returned report is serialized after this cleanup completes.
                    lifecycle.artworkSurfaceCount = artworkSurfaces.size
                    lifecycle.artworkRegionCount = artworkRegions.size
                    lifecycle.artworkRegionsReleased = [...artworkRegions].every(
                        (region) => region.texture.destroyed,
                    )
                    lifecycle.artworkReleased = [...artworkSurfaces].every((artwork) =>
                        artwork.getContext().isContextLost(),
                    )
                    lifecycle.targetAliveAfterArtworkClear = !ctx.isContextLost()
                    ctx.drawImage = drawImage
                    ctx.drawNoteAtlasRegion = drawNoteAtlasRegion
                    surface.dispose()
                    compositeSurface.dispose()
                    lifecycle.targetReleased = ctx.isContextLost()
                    lifecycle.compositeReleased = composite.isContextLost()
                    lifecycle.ownerAlive = !owner.isContextLost()
                }
            })

            await testInfo.attach('note-atlas-comparison', {
                body: JSON.stringify(result, null, 2),
                contentType: 'application/json',
            })
            expect(result.ratio).toBe(pixelRatio)
            expect(result.lifecycle.artworkSurfaceCount).toBeGreaterThan(1)
            expect(result.lifecycle.artworkRegionCount).toBeGreaterThan(1)
            expect(result.lifecycle).toMatchObject({
                artworkRegionsReleased: true,
                artworkReleased: true,
                targetAliveAfterArtworkClear: true,
                targetReleased: true,
                compositeReleased: true,
                ownerAlive: true,
            })
            for (const scenario of result.cases) {
                expect(scenario.reference.calls, scenario.name).toHaveLength(1)
                expect(scenario.reference.calls[0]!.x, scenario.name).toBeGreaterThan(0)
                expect(scenario.reference.calls[0]!.y, scenario.name).toBeGreaterThan(0)
                expect(scenario.overflow.calls, scenario.name).toEqual([
                    { x: 0, y: 0, alpha: 0.375 },
                ])
                expect(scenario.recached.calls, scenario.name).toHaveLength(1)
                expect(scenario.recached.calls[0]!.x, scenario.name).toBeGreaterThan(0)
                expect(scenario.recached.calls[0]!.y, scenario.name).toBeGreaterThan(0)
                for (const image of [scenario.reference, scenario.overflow, scenario.recached]) {
                    // Pixi 8.22 packs Sprite alpha as (groupAlpha * 255 | 0)
                    // in updateRenderGroupTransforms: 0.75 * 0.5 becomes 95.
                    // Canvas rounds to 96; this one-byte opacity quantization
                    // is shared by the cached, overflow and recached artwork.
                    expect(image.maxAlpha, scenario.name).toBe(95)
                    expect(image.outsideClip, scenario.name).toBe(0)
                    if (scenario.clipped)
                        for (const [edge, count] of Object.entries(image.clipEdges))
                            expect(count, `${scenario.name}: ${edge}`).toBeGreaterThan(0)
                }
                if (scenario.tipRow !== undefined)
                    expect(scenario.reference.top, scenario.name).toBeLessThan(scenario.tipRow)
                // Readback unpremultiplies 8-bit RGB: one stored color step can become
                // six RGB levels at alpha 48. Compare actual GPU composites at both
                // background endpoints, plus alpha itself, with the same one-byte limit.
                for (const difference of [scenario.overflowDifference, scenario.evictionDifference])
                    expect(difference.maxAlphaDelta, scenario.name).toBeLessThanOrEqual(1)
                for (const difference of [
                    scenario.overflowOnBlack,
                    scenario.overflowOnWhite,
                    scenario.evictionOnBlack,
                    scenario.evictionOnWhite,
                ]) {
                    expect(difference.different, scenario.name).toBe(0)
                    expect(difference.maxDelta, scenario.name).toBeLessThanOrEqual(1)
                }
            }
        })
    })
}
