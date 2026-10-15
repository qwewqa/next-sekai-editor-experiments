import { expect, test } from '@playwright/test'
import type { RenderSurface } from '../../src/rendering/context'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

declare global {
    interface Window {
        stageSurfaceTest: {
            draws: number
            blits: number
            surface?: RenderSurface
        }
    }
}

const settle = async (page: import('@playwright/test').Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(async () => {
        window.stageSurfaceTest = { draws: 0, blits: 0 }
        const surfaces = new WeakSet<RenderSurface>()
        const { RenderSurface, WebGLDrawContext } = await window.editorTest.appImport<
            typeof import('../../src/rendering/context')
        >('/src/rendering/context.ts')
        const clear = WebGLDrawContext.prototype.clear
        WebGLDrawContext.prototype.clear = function () {
            if (this.canvas instanceof RenderSurface && this.canvas.stageCache) {
                surfaces.add(this.canvas)
                window.stageSurfaceTest.draws++
            }
            return clear.call(this)
        }
        const drawImage = WebGLDrawContext.prototype.drawImage
        WebGLDrawContext.prototype.drawImage = function (
            source: Parameters<typeof drawImage>[0],
            ...args: number[]
        ) {
            if (
                this.canvas instanceof HTMLCanvasElement &&
                this.canvas.classList.contains('editor-chart') &&
                source instanceof RenderSurface &&
                surfaces.has(source)
            ) {
                window.stageSurfaceTest.blits++
                window.stageSurfaceTest.surface = source
            }
            return Reflect.apply(drawImage, this, [source, ...args])
        }
    })
    await page.evaluate(async () => {
        const { fixtures, show, view, settings, appImport } = window.editorTest
        const { clearNotification } = await appImport<
            typeof import('../../src/editor/notification')
        >('/src/editor/notification.ts')
        show(
            {
                ...fixtures.events,
                stageTransformEvents: fixtures.events.stageTransformEvents.map((event) => ({
                    ...event,
                    xTranslation: 0.75,
                })),
            },
            5,
        )
        settings.showOtherObjects = false
        settings.showStageName = false
        settings.showGroupName = false
        for (const type of Object.keys(view.visibilities)) {
            view.visibilities[type as keyof typeof view.visibilities] = type === 'note'
        }
        view.layout = 'composed'
        clearNotification()
        await document.fonts.ready
    })
    await settle(page)
})

test('stationary chart redraws reuse stage pixels; preview edits, scopes and view changes invalidate them', async ({
    page,
}) => {
    const counters = () =>
        page.evaluate(() => ({
            draws: window.stageSurfaceTest.draws,
            blits: window.stageSurfaceTest.blits,
            frames: window.editorFrames.chart,
        }))
    const baseline = await counters()
    expect(baseline.draws).toBeGreaterThan(0)
    const canvas = page.locator('canvas.editor-chart')
    const original = await canvas.screenshot()
    const probes = await page.evaluate(async () => {
        const { createComposedLayout } =
            await window.editorTest.appImport<typeof import('../../src/editor/composed')>(
                '/src/editor/composed.ts',
            )
        const { history, point, view } = window.editorTest
        const beat = 10.123
        const stage = createComposedLayout(history.state.value).stage(
            1 as import('../../src/chart/stages').StageId,
            beat,
        )!
        // Interior of the old/new masks, deliberately away from antialiased
        // borders. GPU canvas promotion can rasterize edge pixels differently.
        return [stage.left + 0.75, (stage.left + stage.right) / 2, stage.right + 0.75].map(
            (lane) => {
                const p = point(lane, beat)
                return { x: Math.floor(p.x - view.x), y: Math.floor(p.y - view.y) }
            },
        )
    })
    const sample = (png: Buffer) =>
        page.evaluate(
            async ({ png, probes }) => {
                const image = new Image()
                image.src = `data:image/png;base64,${png}`
                await image.decode()
                const decoded = document.createElement('canvas')
                decoded.width = image.width
                decoded.height = image.height
                const ctx = decoded.getContext('2d', { willReadFrequently: true })!
                ctx.drawImage(image, 0, 0)
                return probes.map(({ x, y }) => Array.from(ctx.getImageData(x, y, 1, 1).data))
            },
            { png: png.toString('base64'), probes },
        )
    const originalSamples = await sample(original)
    // Selection makes a fresh immutable state and redraws the chart, while the
    // stage geometry and viewport are unchanged.
    await page.evaluate(() => {
        const { history, store } = window.editorTest
        const note = [...store.getAllEntities()].find((entity) => entity.type === 'note')!
        history.replaceState({ ...history.state.value, selectedEntities: [note] })
    })
    await settle(page)
    const selected = await counters()
    expect(selected.frames).toBeGreaterThan(baseline.frames)
    expect(selected.blits).toBeGreaterThan(baseline.blits)
    expect(selected.draws).toBe(baseline.draws)
    await page.evaluate(() => {
        const { history, view } = window.editorTest
        history.replaceState({ ...history.state.value, selectedEntities: [] })
        view.cursorTime = 4
    })
    await settle(page)
    expect((await counters()).draws).toBe(baseline.draws)
    await page.evaluate(() => {
        window.editorTest.view.cursorTime = 100
    })
    await settle(page)
    expect((await canvas.screenshot()).equals(original)).toBe(true)

    // A note transaction replaces the store, but retains the independent stage
    // event grids. Moving the note and restoring it must also hit the cache.
    for (const delta of [1, -1]) {
        await page.evaluate(async (delta) => {
            const { history, store, appImport } = window.editorTest
            const { createTransaction } = await appImport<
                typeof import('../../src/state/transaction')
            >('/src/state/transaction.ts')
            const { replaceNote } = await appImport<
                typeof import('../../src/state/mutations/slides/note')
            >('/src/state/mutations/slides/note.ts')
            const note = [...store.getAllEntities()].find(
                (entity) => entity.type === 'note' && entity.beat === 4,
            )!
            if (note.type !== 'note') throw new Error('Expected fixture note')
            const tx = createTransaction(history.state.value)
            replaceNote(tx, note, { ...note, left: note.left + delta })
            history.replaceState(tx.commit([]))
        }, delta)
        await settle(page)
        expect((await counters()).draws).toBe(baseline.draws)
    }

    await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { createTransaction } = await appImport<typeof import('../../src/state/transaction')>(
            '/src/state/transaction.ts',
        )
        const { setPreviewEdit } =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        const { replaceStageMaskEventJoint } = await appImport<
            typeof import('../../src/state/mutations/events/stage/mask')
        >('/src/state/mutations/events/stage/mask.ts')
        const source = history.state.value
        setPreviewEdit(source, () => {
            const tx = createTransaction(source)
            for (const entity of window.editorTest.store.getAllEntities()) {
                if (entity.type === 'stageMaskEventJoint') {
                    replaceStageMaskEventJoint(tx, entity, {
                        ...entity,
                        maskLeft: entity.maskLeft + 1.75,
                    })
                }
            }
            return tx.commit([])
        })
    })
    await settle(page)
    const preview = await counters()
    expect(preview.draws).toBeGreaterThan(selected.draws)
    expect(await sample(await canvas.screenshot())).not.toEqual(originalSamples)
    await page.evaluate(async () => {
        const { clearPreviewEdit } =
            await window.editorTest.appImport<typeof import('../../src/preview/edit')>(
                '/src/preview/edit.ts',
            )
        clearPreviewEdit()
    })
    await settle(page)
    expect(await sample(await canvas.screenshot())).toEqual(originalSamples)

    for (const change of ['subdivision', 'pan', 'scroll', 'zoom', 'dim', 'hidden'] as const) {
        const before = await counters()
        const pixels = await canvas.screenshot()
        await page.evaluate((change) => {
            const { settings, view } = window.editorTest
            if (change === 'subdivision') view.laneDivision = 4
            if (change === 'pan') view.lane += 0.375
            if (change === 'scroll') view.time += 0.375
            if (change === 'zoom') settings.width += 4
            if (change === 'dim') view.stageId = 2 as import('../../src/chart/stages').StageId
            if (change === 'hidden') settings.showOtherStages = false
        }, change)
        await settle(page)
        if (change !== 'hidden')
            expect((await counters()).draws, change).toBeGreaterThan(before.draws)
        expect((await counters()).blits, change).toBeGreaterThan(before.blits)
        expect((await canvas.screenshot()).equals(pixels), change).toBe(false)
    }
    const beforeResize = await counters()
    await page.setViewportSize({ width: 1493, height: 917 })
    await settle(page)
    expect((await counters()).frames).toBeGreaterThan(beforeResize.frames)

    const released = await page.evaluate(async () => {
        const canvas = window.stageSurfaceTest.surface!
        window.editorTest.view.layout = 'basic'
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        return canvas.getContext().isContextLost()
    })
    expect(released).toBe(true)
})

test('other stages draw on a new store and release the old one', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { fixtures, show, view, nextTick } = window.editorTest
        const frame = () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            )
        const old = window.stageSurfaceTest.surface!
        // A 'copy' clear could leave the old chart's stages showing through.
        show(
            {
                ...fixtures.events,
                stageTransformEvents: fixtures.events.stageTransformEvents.map((event) => ({
                    ...event,
                    xTranslation: -1.5,
                })),
            },
            5,
        )
        view.layout = 'composed'
        await nextTick()
        await frame()
        const current = window.stageSurfaceTest.surface!
        return { released: old.getContext().isContextLost(), replaced: current !== old }
    })
    expect(result).toEqual({ released: true, replaced: true })
})

test('cached stage pixels match an uncached surface across fractional DPR, viewport and style changes', async ({
    page,
}) => {
    const result = await page.evaluate(async () => {
        const { appImport, history, fixtures } = window.editorTest
        const { createStageSurface } = await appImport<
            typeof import('../../src/editor/canvas/stageSurface')
        >('/src/editor/canvas/stageSurface.ts')
        const { prepareSurface } = await appImport<
            typeof import('../../src/editor/canvas/surface')
        >('/src/editor/canvas/surface.ts')
        const { drawComposedStages } = await appImport<
            typeof import('../../src/editor/canvas/stages')
        >('/src/editor/canvas/stages.ts')
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const { createState } =
            await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const { fullScope, createScopeLookup } = await appImport<
            typeof import('../../src/editor/scopeRules')
        >('/src/editor/scopeRules.ts')
        const surface = createStageSurface()
        let state = history.state.value
        let composed = createComposedLayout(state)
        let bounds = { l: -10, r: 10, t: -12, b: 0, w: 20, h: 12 }
        let width = 403.25
        let height = 257.75
        let pixelRatio = 1.25
        let scope = fullScope
        let laneDivision = 1
        const errors: {
            variant: string
            count: number
            max: number
            alpha: number
            first: number[]
        }[] = []
        const direct = document.createElement('canvas')
        const cached = document.createElement('canvas')
        await Promise.all(
            [direct, cached].map((canvas) => window.editorRendering.getDrawContext(canvas).ready),
        )
        // Compare caching with a newly drawn ordinary child target. The browser's
        // default framebuffer can use a different MSAA sample phase; including it
        // on only one side would measure that raster difference instead of reuse.
        const reference = window.editorRendering.getDrawContext(direct).createSurface(1, 1)
        for (const variant of [
            'initial',
            'repeat',
            'pan',
            'DPR',
            'resize',
            'subdivision',
            'dim',
            'hidden',
            'tempo',
            'restore',
            'clear',
        ]) {
            // Both targets retain their WebGL owner while their surfaces resize.
            // The stage bitmap stays attached to the cached target's GPU context.
            if (variant === 'pan') bounds = { ...bounds, l: -9.75, r: 10.25 }
            if (variant === 'DPR') pixelRatio = 1.75
            if (variant === 'resize') {
                width = 417.5
                height = 273.25
            }
            if (variant === 'subdivision') laneDivision = 4
            if (variant === 'dim')
                scope = createScopeLookup({
                    stageId: 2 as import('../../src/chart/stages').StageId,
                })
            if (variant === 'hidden')
                scope = createScopeLookup({
                    stageId: 2 as import('../../src/chart/stages').StageId,
                    showOtherStages: false,
                })
            if (variant === 'tempo') {
                state = createState({ ...fixtures.events, bpms: [{ beat: 0, bpm: 90 }] }, 0)
                composed = createComposedLayout(state)
            }
            if (variant === 'restore') scope = fullScope
            if (variant === 'clear') surface.clear()
            const directTarget = prepareSurface(direct, width, height, pixelRatio, bounds)!
            const context = {
                state,
                composed,
                bounds,
                pixelRatio,
                scale: width / bounds.w,
                ups: -2,
                ctx: prepareSurface(reference, width, height, pixelRatio, bounds)!,
            } as import('../../src/editor/canvas/types').EditorDrawContext
            drawComposedStages(context, { min: 0, max: 12 }, scope, laneDivision)
            directTarget.save()
            directTarget.setTransform(1, 0, 0, 1, 0, 0)
            directTarget.globalAlpha = 1
            directTarget.drawImage(reference, 0, 0)
            directTarget.restore()
            surface.draw(
                { ...context, ctx: prepareSurface(cached, width, height, pixelRatio, bounds)! },
                width,
                height,
                { min: 0, max: 12 },
                scope,
                laneDivision,
            )
            const a = window.editorRendering
                .getDrawContext(direct)
                .getImageData(0, 0, direct.width, direct.height).data
            const b = window.editorRendering
                .getDrawContext(cached)
                .getImageData(0, 0, cached.width, cached.height).data
            let count = 0,
                max = 0,
                alpha = 0
            const first: number[] = []
            a.forEach((value, index) => {
                const difference = Math.abs(value - b[index]!)
                if (difference) {
                    count++
                    max = Math.max(max, difference)
                    if (index % 4 === 3) alpha = Math.max(alpha, difference)
                    if (first.length < 15) first.push(index, value, b[index]!)
                }
            })
            if (count) errors.push({ variant, count, max, alpha, first })
        }
        surface.clear()
        reference.dispose()
        window.editorRendering.disposeDrawContext(direct)
        window.editorRendering.disposeDrawContext(cached)
        return errors
    })
    expect(result).toEqual([])
})
