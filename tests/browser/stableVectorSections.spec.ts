import { expect, test } from '@playwright/test'
import type { DrawStep } from '../../src/editor/canvas/ordering'
import type { DrawSection } from '../../src/editor/canvas/sections'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import type { State } from '../../src/state'
import type { Entity } from '../../src/state/entities'

test(`stable vector sections preserve pixels, names and restored ownership (WebGL2)`, async ({
    page,
}) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/__stable-vector-sections', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><canvas width="160" height="160"></canvas>',
        }),
    )
    await page.goto('/__stable-vector-sections')
    const report = await page.evaluate(async () => {
        const { getDrawContext } = await import('/src/rendering/context.ts')
        const { VectorRanges } = await import('/src/editor/canvas/vectorRanges.ts')
        const { createNameLayer } = await import('/src/editor/canvas/names.ts')
        const canvas = document.querySelector('canvas')!
        const ctx = getDrawContext(canvas)
        await ctx.ready
        const gl = canvas.getContext('webgl2')!
        const api = gl instanceof WebGL2RenderingContext ? 2 : 1
        const cache = new VectorRanges()
        const size = 160
        // Only these immutable state inputs are consumed by VectorRanges.
        // Rectangles below replace the editor's entity-specific artwork.
        const state = {
            // Cover the negative offscreen rectangle as well: this fixture
            // uses its Y coordinate as the synthetic entity beat.
            bpms: [{ x: -1024, y: -1024, s: 1, meter: 4, measure: 0, measureBeat: -1024 }],
            stages: new Map(),
            isDynamicStages: true,
        } as State
        type Art = {
            entity: Entity
            rect: readonly [number, number, number, number]
            color: string
            text: string
            selected: boolean
        }
        const art = (text: string, rect: Art['rect'], color: string, selected = false): Art => ({
            entity: { type: 'bpm', beat: rect[1], bpm: 60 } as Entity,
            rect,
            color,
            text,
            selected,
        })
        const offTop = art('off-top', [16, -96, 72, 32], '#00ff00')
        const first = art('first', [16, 16, 72, 64], '#ff0000')
        const edge = art('edge', [-12, 128, 40, 24], '#00ff00')
        const offBottom = art('off-bottom', [16, 320, 72, 32], '#ff00ff')
        const raised = art('raised', [48, 40, 72, 64], '#0000ff', true)
        const farFirst = art('far-first', [16, 1040, 72, 64], '#ff0000')
        const farLast = art('far-last', [48, 1064, 72, 64], '#0000ff')
        const artwork = [offTop, first, edge, offBottom, raised, farFirst, farLast]
        const byEntity = new Map(artwork.map((item) => [item.entity, item]))
        const section = (key: string, items: Art[], pass: DrawSection['pass']): DrawSection => ({
            key,
            steps: items.map(({ entity, selected }) => ({
                entity,
                highlighted: selected,
                raised: false,
                opacity: 0.5,
            })),
            pass,
            minBeat: Math.min(...items.map(({ rect }) => rect[1])),
            maxBeat: Math.max(...items.map(({ rect }) => rect[1] + rect[3])),
        })
        const sections = [
            section('near-normal', [offTop, first, edge, offBottom], 'normal'),
            section('far-normal', [farFirst, farLast], 'normal'),
            section('near-raised', [raised], 'raised'),
        ]
        let callbacks = 0
        const differs = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
            let changedPixels = 0
            let maxChannel = 0
            for (let i = 0; i < a.length; i += 4) {
                let changed = false
                for (let c = 0; c < 4; c++) {
                    const difference = Math.abs(a[i + c]! - b[i + c]!)
                    changed ||= difference !== 0
                    maxChannel = Math.max(maxChannel, difference)
                }
                changedPixels += +changed
            }
            return { changedPixels, maxChannel }
        }
        const readPixels = () => ctx.getImageData(0, 0, size, size).data
        const nameData = (context: EditorDrawContext) =>
            context.names!.names.map(({ text, highlighted }) => ({ text, highlighted }))
        const visible = (item: Art, pan: number, scale: number) => {
            const [x, y, width, height] = item.rect
            return (
                x * scale < size &&
                (x + width) * scale > 0 &&
                (y - pan) * scale < size &&
                (y + height - pan) * scale > 0
            )
        }
        const frame = (
            label: string,
            target: InstanceType<typeof VectorRanges>,
            pan: number,
            scale: number,
            recentlyActive: boolean,
            hovered = new Set<Entity>(),
        ) => {
            const context: EditorDrawContext = {
                ctx,
                state,
                scale,
                pixelRatio: 1,
                bounds: {
                    l: 0,
                    r: size / scale,
                    t: pan,
                    b: pan + size / scale,
                    w: size / scale,
                    h: size / scale,
                },
                ups: 1,
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
            const draw = (destination: EditorDrawContext, step: DrawStep) => {
                callbacks++
                const item = byEntity.get(step.entity)!
                destination.ctx.save()
                destination.ctx.globalAlpha = step.opacity
                destination.ctx.fillStyle = item.color
                destination.ctx.fillRect(...item.rect)
                destination.ctx.restore()
                const highlighted = step.highlighted || hovered.has(step.entity)
                if (highlighted || destination.recentlyActive)
                    destination.names!.names.push({
                        owner: step.entity,
                        highlighted,
                        text: item.text,
                        x: item.rect[0],
                        y: item.rect[1],
                        color: '#ffffff',
                        size: 1,
                        align: 'left',
                        alpha: step.opacity,
                    })
            }
            const visibleOwners = new Set(
                artwork.filter((item) => visible(item, pan, scale)).map(({ entity }) => entity),
            )
            const current = sections.filter(({ steps }) =>
                steps.some(({ entity }) => visibleOwners.has(entity)),
            )
            const reset = () => {
                ctx.clear()
                ctx.setTransform(scale, 0, 0, scale, 0, -pan * scale)
            }
            const before = { ...target.stats }
            const callbacksBefore = callbacks
            reset()
            target.beginFrame(context, [])
            target.prepareSections(sections, current)
            for (const entry of current)
                target.drawSection(context, entry, hovered, draw, visibleOwners)
            ctx.flush()
            target.endFrame()
            const pixels = readPixels()
            const captureCallbacks = callbacks - callbacksBefore
            const names = nameData(context)
            const reference = { ...context, names: createNameLayer() }
            reset()
            for (const entry of current)
                for (const step of entry.steps)
                    if (visibleOwners.has(step.entity)) draw(reference, step)
            ctx.flush()
            const direct = readPixels()
            const overlap = (56 * size + 64) * 4
            return {
                label,
                pixels,
                comparison: differs(direct, pixels),
                names,
                expectedNames: nameData(reference),
                captures: target.stats.captures - before.captures,
                replays: target.stats.replays - before.replays,
                declined: target.stats.declined - before.declined,
                retained: target.stats.ranges,
                captureCallbacks,
                overlap: [...pixels.subarray(overlap, overlap + 4)],
                glError: gl.getError(),
            }
        }
        const frames: ReturnType<typeof frame>[] = []
        const record = (...args: Parameters<typeof frame>) => {
            const result = frame(...args)
            frames.push(result)
            return result
        }
        try {
            const initial = record('initial', cache, 0, 1, true, new Set([offTop.entity]))
            record('far', cache, 1024, 1, true)
            const returned = record('returned', cache, 0, 1, true)
            record('hover-idle', cache, 0, 1, false, new Set([first.entity, offTop.entity]))
            record('leave-idle', cache, 0, 1, false)
            record('active-again', cache, 0, 1, true)
            const fresh = new VectorRanges()
            let freshDifference
            try {
                const current = record('fresh', fresh, 0, 1, true)
                freshDifference = differs(returned.pixels, current.pixels)
            } finally {
                fresh.clear()
            }
            const zoomed = record('zoomed', cache, 0, 2, true)
            const owner = ctx.resourceOwner
            const extension = gl.getExtension('WEBGL_lose_context')
            if (!extension)
                throw new Error('WEBGL_lose_context is required for this lifecycle test')
            await new Promise<void>((resolve) => {
                canvas.addEventListener('webglcontextlost', () => setTimeout(resolve, 0), {
                    once: true,
                })
                extension.loseContext()
            })
            const lost = ctx.isContextLost()
            const restored = new Promise<void>((resolve) => {
                canvas.addEventListener('webglcontextrestored', () => resolve(), { once: true })
            })
            const renderingReady = new Promise<void>((resolve) => {
                canvas.addEventListener('renderingready', () => resolve(), { once: true })
            })
            // renderingready follows Pixi's native restoration and owner reset.
            extension.restoreContext()
            await Promise.all([restored, renderingReady])
            await ctx.ready
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            )
            const ownerChanged = ctx.resourceOwner !== owner
            const afterRestore = record('restored', cache, 0, 2, true)
            record('restored-warm', cache, 0, 2, true)
            return {
                api,
                lost,
                recovered: !ctx.isContextLost(),
                ownerChanged,
                backDifference: differs(initial.pixels, returned.pixels),
                freshDifference,
                restoreDifference: differs(zoomed.pixels, afterRestore.pixels),
                frames: frames.map(({ pixels: _pixels, ...result }) => result),
            }
        } finally {
            cache.clear()
            ctx.dispose()
        }
    })
    expect(report.api).toBe(2)
    expect(report.lost).toBe(true)
    expect(report.recovered).toBe(true)
    expect(report.ownerChanged).toBe(true)
    expect(report.backDifference).toEqual({ changedPixels: 0, maxChannel: 0 })
    expect(report.freshDifference).toEqual({ changedPixels: 0, maxChannel: 0 })
    expect(report.restoreDifference).toEqual({ changedPixels: 0, maxChannel: 0 })
    for (const frame of report.frames) {
        expect(frame.comparison, frame.label).toEqual({ changedPixels: 0, maxChannel: 0 })
        expect(frame.names, frame.label).toEqual(frame.expectedNames)
        expect(frame.declined, frame.label).toBe(0)
        expect(frame.glError, frame.label).toBe(0)
    }
    const byLabel = new Map(report.frames.map((frame) => [frame.label, frame]))
    const initial = byLabel.get('initial')!
    expect(initial.captures).toBe(2)
    expect(initial.captureCallbacks).toBe(5)
    expect(initial.names).toEqual([
        { text: 'first', highlighted: false },
        { text: 'edge', highlighted: false },
        { text: 'raised', highlighted: true },
    ])
    expect(initial.overlap[2]).toBeGreaterThan(initial.overlap[0]!)
    expect(initial.overlap[3]).toBeGreaterThan(128)
    expect(initial.overlap[3]).toBeLessThan(255)
    expect(byLabel.get('far')!.captures).toBe(1)
    expect(byLabel.get('far')!.retained).toBe(3)
    expect(byLabel.get('far')!.names).toEqual([
        { text: 'far-first', highlighted: false },
        { text: 'far-last', highlighted: false },
    ])
    for (const label of ['returned', 'hover-idle', 'leave-idle', 'active-again', 'restored-warm']) {
        expect(byLabel.get(label)!.captures, label).toBe(0)
        expect(byLabel.get(label)!.captureCallbacks, label).toBe(0)
        expect(byLabel.get(label)!.replays, label).toBe(2)
    }
    expect(byLabel.get('hover-idle')!.names).toEqual([
        { text: 'first', highlighted: true },
        { text: 'raised', highlighted: true },
    ])
    expect(byLabel.get('leave-idle')!.names).toEqual([{ text: 'raised', highlighted: true }])
    for (const label of ['fresh', 'zoomed', 'restored'])
        expect(byLabel.get(label)!.captures, label).toBe(2)
    expect(byLabel.get('zoomed')!.names).toEqual([
        { text: 'first', highlighted: false },
        { text: 'raised', highlighted: true },
    ])
    expect(errors).toEqual([])
})
