import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

declare global {
    interface Window {
        stageSurfaceTest: {
            // Retained stage meshes built, drawn on the chart and released.
            built: number
            drawn: number
            released: number
        }
    }
}

const settle = async (page: Page) =>
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
        window.stageSurfaceTest = { built: 0, drawn: 0, released: 0 }
        const { WebGLDrawContext } = await window.editorTest.appImport<
            typeof import('../../src/rendering/context')
        >('/src/rendering/context.ts')
        const chart = (ctx: InstanceType<typeof WebGLDrawContext>) =>
            ctx.canvas instanceof HTMLCanvasElement && ctx.canvas.classList.contains('editor-chart')
        const { createStageMesh, drawStageMesh, releaseStageMesh } = WebGLDrawContext.prototype
        WebGLDrawContext.prototype.createStageMesh = function (...args) {
            if (chart(this)) window.stageSurfaceTest.built++
            return createStageMesh.apply(this, args)
        }
        WebGLDrawContext.prototype.drawStageMesh = function (...args) {
            if (chart(this)) window.stageSurfaceTest.drawn++
            return drawStageMesh.apply(this, args)
        }
        WebGLDrawContext.prototype.releaseStageMesh = function (...args) {
            if (chart(this)) window.stageSurfaceTest.released++
            return releaseStageMesh.apply(this, args)
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

const counters = (page: Page) =>
    page.evaluate(() => ({ ...window.stageSurfaceTest, frames: window.editorFrames.chart }))

test('chart redraws reuse stage tiles; preview edits, scopes and zoom build them again', async ({
    page,
}) => {
    const baseline = await counters(page)
    expect(baseline.built).toBeGreaterThan(0)
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
        // Interior of the old/new masks, deliberately away from antialiased borders.
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
    const selected = await counters(page)
    expect(selected.frames).toBeGreaterThan(baseline.frames)
    expect(selected.drawn).toBeGreaterThan(baseline.drawn)
    expect(selected.built).toBe(baseline.built)
    await page.evaluate(() => {
        const { history, view } = window.editorTest
        history.replaceState({ ...history.state.value, selectedEntities: [] })
        view.cursorTime = 4
    })
    await settle(page)
    expect((await counters(page)).built).toBe(baseline.built)
    await page.evaluate(() => {
        window.editorTest.view.cursorTime = 100
    })
    await settle(page)
    expect((await canvas.screenshot()).equals(original)).toBe(true)

    // A note transaction replaces the store, but retains the independent stage
    // event grids. Moving the note and restoring it must also reuse the tiles.
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
        expect((await counters(page)).built).toBe(baseline.built)
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
    const preview = await counters(page)
    expect(preview.built).toBeGreaterThan(selected.built)
    expect(preview.released).toBeGreaterThanOrEqual(baseline.built)
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

    for (const change of ['pan', 'scroll', 'subdivision', 'zoom', 'dim', 'hidden'] as const) {
        const before = await counters(page)
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
        const after = await counters(page)
        // A short pan only moves the tiles.
        if (change === 'pan') expect(after.built, change).toBe(before.built)
        else if (change !== 'scroll' && change !== 'hidden')
            expect(after.built, change).toBeGreaterThan(before.built)
        if (change !== 'scroll' && change !== 'pan')
            expect(after.released, change).toBeGreaterThan(before.released)
        // The one stage left in scope is out of view.
        if (change !== 'hidden') expect(after.drawn, change).toBeGreaterThan(before.drawn)
        expect((await canvas.screenshot()).equals(pixels), change).toBe(false)
    }
    const beforeResize = await counters(page)
    await page.setViewportSize({ width: 1493, height: 917 })
    await settle(page)
    expect((await counters(page)).frames).toBeGreaterThan(beforeResize.frames)

    await page.evaluate(async () => {
        window.editorTest.view.layout = 'basic'
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })
    const basic = await counters(page)
    expect(basic.released).toBe(basic.built)
})

test('a lost and restored renderer builds its stage tiles again', async ({ page }) => {
    const canvas = page.locator('canvas.editor-chart')
    const original = await canvas.screenshot()
    const before = await counters(page)
    await page.evaluate(async () => {
        const chart = document.querySelector<HTMLCanvasElement>('canvas.editor-chart')!
        const extension = chart.getContext('webgl2')!.getExtension('WEBGL_lose_context')!
        const lost = new Promise<void>((resolve) =>
            chart.addEventListener('webglcontextlost', () => resolve(), { once: true }),
        )
        extension.loseContext()
        await lost
        // Restoring within the loss event's task is ignored.
        await new Promise((resolve) => setTimeout(resolve, 50))
        const restored = new Promise<void>((resolve) =>
            chart.addEventListener('renderingready', () => resolve(), { once: true }),
        )
        extension.restoreContext()
        await restored
    })
    await settle(page)
    const after = await counters(page)
    expect(after.released).toBeGreaterThanOrEqual(before.built)
    expect(after.built).toBeGreaterThan(before.built)
    // Restored uploads can round a few edge pixels by one level.
    const difference = await page.evaluate(
        async ([a, b]) => {
            const read = async (png: string) => {
                const bitmap = await createImageBitmap(
                    await (await fetch(`data:image/png;base64,${png}`)).blob(),
                )
                const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
                context.drawImage(bitmap, 0, 0)
                return context.getImageData(0, 0, bitmap.width, bitmap.height).data
            }
            const [x, y] = await Promise.all([read(a), read(b)])
            let max = 0
            x.forEach((value, index) => (max = Math.max(max, Math.abs(value - y[index]!))))
            return max
        },
        [original.toString('base64'), (await canvas.screenshot()).toString('base64')] as const,
    )
    expect(difference).toBeLessThanOrEqual(2)
})

test('other stages draw new tiles and release the old ones', async ({ page }) => {
    const before = await counters(page)
    await page.evaluate(async () => {
        const { fixtures, show, view, nextTick } = window.editorTest
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
    })
    await settle(page)
    const after = await counters(page)
    expect(after.released).toBeGreaterThanOrEqual(before.built)
    expect(after.built).toBeGreaterThan(before.built)
})

// Draws the fixture's stages through a retained tile surface, a newly made one and
// the direct draw, for each change in turn, and compares their pixels.
test('retained stage tiles match newly built ones and the direct draw across edits and view changes', async ({
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
        const { timeToBeat } = await appImport<typeof import('../../src/state/integrals/bpms')>(
            '/src/state/integrals/bpms.ts',
        )
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
        const builds: Record<string, number> = {}
        const fresh: { variant: string; count: number; max: number }[] = []
        const direct: { variant: string; pixels: number; over: number }[] = []
        const canvases = [0, 1, 2].map(() => document.createElement('canvas'))
        await Promise.all(
            canvases.map((canvas) => window.editorRendering.getDrawContext(canvas).ready),
        )
        const { WebGLDrawContext } = await appImport<typeof import('../../src/rendering/context')>(
            '/src/rendering/context.ts',
        )
        const create = WebGLDrawContext.prototype.createStageMesh
        let built = 0
        WebGLDrawContext.prototype.createStageMesh = function (...args) {
            if (this.canvas === canvases[0]) built++
            return create.apply(this, args)
        }
        const read = (canvas: HTMLCanvasElement) =>
            window.editorRendering
                .getDrawContext(canvas)
                .getImageData(0, 0, canvas.width, canvas.height).data
        for (const variant of [
            'initial',
            'repeat',
            'scroll',
            'pan',
            'DPR',
            'resize',
            'subdivision',
            'dim',
            'hidden',
            'restore',
            'stage event',
            'tempo',
            'far scroll',
            'clear',
        ]) {
            if (variant === 'scroll') bounds = { ...bounds, t: bounds.t - 0.37, b: bounds.b - 0.37 }
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
            if (variant === 'restore') scope = fullScope
            if (variant === 'stage event') {
                state = createState(
                    {
                        ...fixtures.events,
                        stageMaskEvents: fixtures.events.stageMaskEvents.map((event) => ({
                            ...event,
                            maskLeft: event.maskLeft + 0.5,
                        })),
                    },
                    0,
                )
                composed = createComposedLayout(state)
            }
            if (variant === 'tempo') {
                state = createState({ ...fixtures.events, bpms: [{ beat: 0, bpm: 90 }] }, 0)
                composed = createComposedLayout(state)
            }
            if (variant === 'far scroll') bounds = { ...bounds, t: bounds.t - 4, b: bounds.b - 4 }
            if (variant === 'clear') surface.clear()
            const ups = -2
            // The view reaches the canvas bottom, as the editor's does.
            const h = (height * bounds.w) / width
            const view = { ...bounds, b: bounds.t + h, h }
            const beats = {
                min: timeToBeat(state.bpms, Math.max(0, view.b / ups)),
                max: timeToBeat(state.bpms, view.t / ups),
            }
            const context = (canvas: HTMLCanvasElement) =>
                ({
                    state,
                    composed,
                    bounds: view,
                    pixelRatio,
                    scale: width / bounds.w,
                    ups,
                    ctx: prepareSurface(canvas, width, height, pixelRatio, view)!,
                }) as import('../../src/editor/canvas/types').EditorDrawContext
            const [retained, made, drawn] = canvases as [
                HTMLCanvasElement,
                HTMLCanvasElement,
                HTMLCanvasElement,
            ]
            built = 0
            surface.draw(context(retained), width, height, beats, scope, laneDivision)
            builds[variant] = built
            const newSurface = createStageSurface()
            newSurface.draw(context(made), width, height, beats, scope, laneDivision)
            drawComposedStages(context(drawn), beats, scope, laneDivision)
            const a = read(retained)
            const b = read(made)
            const c = read(drawn)
            newSurface.clear()
            let count = 0,
                max = 0
            a.forEach((value, index) => {
                const difference = Math.abs(value - b[index]!)
                if (difference) count++
                max = Math.max(max, difference)
            })
            if (count) fresh.push({ variant, count, max })
            let over = 0
            for (let i = 0; i < a.length; i += 4)
                for (let k = 0; k < 4; k++)
                    if (Math.abs(a[i + k]! - c[i + k]!) > 24) {
                        over++
                        break
                    }
            direct.push({ variant, pixels: a.length / 4, over })
        }
        surface.clear()
        WebGLDrawContext.prototype.createStageMesh = create
        for (const canvas of canvases) window.editorRendering.disposeDrawContext(canvas)
        return { builds, fresh, direct }
    })
    // Retained tiles are offset, never redrawn differently.
    expect(result.fresh).toEqual([])
    // A redraw or a short pan builds no tiles; a short scroll at most the next one ahead.
    expect(result.builds.initial).toBeGreaterThan(1)
    expect(result.builds.repeat).toBe(0)
    expect(result.builds.pan).toBe(0)
    expect(result.builds.scroll).toBeLessThanOrEqual(1)
    for (const variant of ['DPR', 'subdivision', 'dim', 'stage event', 'tempo', 'clear'])
        expect(result.builds[variant], variant).toBeGreaterThan(1)
    // Tiles sample curves from their own edges, so slanted dividers and curved edges can
    // land up to the 0.01-lane sampling tolerance away from a draw of the whole view: at
    // most 0.2% of pixels here. A missing tile or a stale stage changes far more; the
    // seam test below covers tile edges.
    for (const { variant, pixels, over } of result.direct)
        expect(over, variant).toBeLessThan(pixels / 200)
})

test('a stationary stage has no seams at tile edges at any scroll offset or fractional DPR', async ({
    page,
}) => {
    const rows = await page.evaluate(async () => {
        const { appImport, fixtures } = window.editorTest
        const { createState } =
            await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const { createStageSurface } = await appImport<
            typeof import('../../src/editor/canvas/stageSurface')
        >('/src/editor/canvas/stageSurface.ts')
        const { prepareSurface } = await appImport<
            typeof import('../../src/editor/canvas/surface')
        >('/src/editor/canvas/surface.ts')
        const { fullScope } = await appImport<typeof import('../../src/editor/scopeRules')>(
            '/src/editor/scopeRules.ts',
        )
        const source = fixtures.events
        const mask = source.stageMaskEvents[0]!
        const state = createState(
            {
                ...source,
                isDynamicStages: true,
                bpms: [{ beat: 0, bpm: 120 }],
                stages: new Map([
                    [
                        mask.stageId,
                        {
                            ...source.stages.get(mask.stageId)!,
                            isFromStart: false,
                            isUntilEnd: false,
                        },
                    ],
                ]),
                stageMaskEvents: [0.25, 63.37].map((beat) => ({
                    ...mask,
                    beat,
                    maskLeft: -2,
                    maskSize: 4,
                })),
                stagePivotEvents: [
                    { ...source.stagePivotEvents[0]!, beat: 0.25, pivotLane: 0, divisionSize: 2 },
                ],
                stageStyleEvents: [{ ...source.stageStyleEvents[0]!, beat: 0.25, laneAlpha: 1 }],
                stageTransformEvents: [],
            },
            0,
        )
        const composed = createComposedLayout(state)
        const rows: { ratio: number; offset: number; alphas: number[] }[] = []
        const width = 280
        const height = 480
        for (const ratio of [1, 1.25, 1.5, 2]) {
            const canvas = document.createElement('canvas')
            const ctx = window.editorRendering.getDrawContext(canvas)
            await ctx.ready
            const surface = createStageSurface()
            // Fractional scrolls offset the same tiles; tile edges cross the column.
            for (const offset of [0, 0.137, 1.5, 7.71]) {
                const bounds = { l: -7, r: 7, t: -36 - offset, b: -12 - offset, w: 14, h: 24 }
                surface.draw(
                    {
                        ctx: prepareSurface(canvas, width, height, ratio, bounds)!,
                        state,
                        composed,
                        scale: 20,
                        ups: -3,
                        pixelRatio: ratio,
                        bounds,
                    } as import('../../src/editor/canvas/types').EditorDrawContext,
                    width,
                    height,
                    { min: 0, max: 64 },
                    fullScope,
                    4,
                )
                // Halfway between dividers.
                const pixels = ctx.getImageData(
                    Math.floor(142.5 * ratio),
                    0,
                    1,
                    Math.floor(height * ratio),
                ).data
                const alphas = new Set<number>()
                for (let i = 3; i < pixels.length; i += 4) alphas.add(pixels[i]!)
                rows.push({ ratio, offset, alphas: [...alphas] })
            }
            surface.clear()
            window.editorRendering.disposeDrawContext(canvas)
        }
        return rows
    })
    for (const { ratio, offset, alphas } of rows)
        expect(alphas, `DPR ${ratio}, offset ${offset}`).toEqual([41])
})
