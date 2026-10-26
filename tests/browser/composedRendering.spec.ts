import { expect, test } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

const settle = async (page: import('@playwright/test').Page) =>
    page.evaluate(async () => {
        const { clearNotification } = await window.editorTest.appImport<
            typeof import('../../src/editor/notification')
        >('/src/editor/notification.ts')
        clearNotification()
        await document.fonts.ready
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
    await settle(page)
})

test('composed canvas shows moving stage shapes and keeps projected notes selectable', async ({
    page,
}, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.evaluate(() => {
        const { fixtures, show, settings, view } = window.editorTest
        settings.width = 24
        settings.pps = 80
        settings.showOtherObjects = false
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.events,
                bpms: [{ beat: 0, bpm: 120 }],
                cameraEvents: [],
                timeScales: [],
                stageTransformEvents: fixtures.events.stageTransformEvents.map((event) => ({
                    ...event,
                    xTranslation: 0.75,
                })),
                slides: [
                    [{ ...base, beat: 5, left: 0 }],
                    [
                        { ...base, beat: 2, left: -3 },
                        { ...base, beat: 18, left: 3, flickDirection: 'upRight' },
                    ],
                ],
            },
            5,
        )
        for (const type of Object.keys(view.visibilities)) {
            view.visibilities[type as keyof typeof view.visibilities] =
                type === 'note' || type === 'connector'
        }
        view.layout = 'basic'
        view.laneDivision = 4
    })
    const canvas = page.locator('canvas.editor-chart')
    await settle(page)
    const basic = await canvas.screenshot()
    await page.evaluate(() => {
        window.editorTest.view.layout = 'composed'
    })
    await settle(page)
    await expect.poll(() => page.evaluate(() => window.editorFrames.chart)).toBeGreaterThan(1)
    const composed = await canvas.screenshot({ path: testInfo.outputPath('composed-stages.png') })
    expect(composed.equals(basic)).toBe(false)
    // Reusing the canvas and connector cache must not leave any projected art
    // behind when returning to Basic, even on a dynamic chart.
    await page.evaluate(() => {
        window.editorTest.view.layout = 'basic'
    })
    await settle(page)
    const returnedBasic = await canvas.screenshot()
    if (!returnedBasic.equals(basic)) {
        writeFileSync(testInfo.outputPath('basic-before-layout.png'), basic)
        writeFileSync(testInfo.outputPath('basic-after-layout.png'), returnedBasic)
        await testInfo.attach('basic-before-layout.png', { body: basic, contentType: 'image/png' })
        await testInfo.attach('basic-after-layout.png', {
            body: returnedBasic,
            contentType: 'image/png',
        })
    }
    // Rebuilding Pixi batches can round a few intersections differently: the
    // measured fixture changes 26 pixels by at most 5 RGB levels. Keep every
    // interior pixel and dimension exact, and bound differences at existing edges.
    const restored = await page.evaluate(
        async ({ before, after }) => {
            const read = async (png: string) => {
                const image = await createImageBitmap(
                    await (await fetch(`data:image/png;base64,${png}`)).blob(),
                )
                const canvas = new OffscreenCanvas(image.width, image.height)
                const ctx = canvas.getContext('2d')!
                ctx.drawImage(image, 0, 0)
                image.close()
                return ctx.getImageData(0, 0, canvas.width, canvas.height)
            }
            const [a, b] = await Promise.all([read(before), read(after)])
            if (a.width !== b.width || a.height !== b.height)
                return {
                    sameDimensions: false,
                    max: Infinity,
                    interior: Infinity,
                    changed: Infinity,
                }
            let max = 0,
                interior = 0,
                changedPixels = 0
            for (let y = 0; y < a.height; y++)
                for (let x = 0; x < a.width; x++) {
                    const offset = (y * a.width + x) * 4
                    let changed = false
                    for (let c = 0; c < 4; c++) {
                        const delta = Math.abs(a.data[offset + c]! - b.data[offset + c]!)
                        changed ||= delta !== 0
                        max = Math.max(max, delta)
                    }
                    if (!changed) continue
                    changedPixels++
                    let edge = false
                    for (let dy = -1; dy <= 1 && !edge; dy++)
                        for (let dx = -1; dx <= 1 && !edge; dx++) {
                            if (x + dx < 0 || x + dx >= a.width || y + dy < 0 || y + dy >= a.height)
                                continue
                            const neighbor = ((y + dy) * a.width + x + dx) * 4
                            edge = [0, 1, 2, 3].some(
                                // Subdivision guides include one-level AA samples, so
                                // even a low-contrast existing boundary counts as an edge.
                                (c) => Math.abs(a.data[neighbor + c]! - a.data[offset + c]!) > 0,
                            )
                        }
                    if (!edge) interior++
                }
            return { sameDimensions: true, max, interior, changed: changedPixels }
        },
        { before: basic.toString('base64'), after: returnedBasic.toString('base64') },
    )
    expect(restored.sameDimensions).toBe(true)
    expect(restored.max).toBeLessThanOrEqual(5)
    expect(restored.interior).toBe(0)
    expect(restored.changed).toBeLessThanOrEqual(64)
    await page.evaluate(() => {
        window.editorTest.view.layout = 'composed'
    })
    await settle(page)
    const position = await page.evaluate(async () => {
        const { createComposedLayout } =
            await window.editorTest.appImport<typeof import('../../src/editor/composed')>(
                '/src/editor/composed.ts',
            )
        const note = [...window.editorTest.store.getAllEntities()].find(
            (entity) => entity.type === 'note' && entity.beat === 5,
        )!
        if (note.type !== 'note') throw new Error('Expected note')
        const { left, size } = createComposedLayout(
            window.editorTest.history.state.value,
        ).notePosition(note)
        return window.editorTest.point(left + size / 2, note.beat)
    })
    await page.mouse.click(position.x, position.y)
    await expect
        .poll(() => page.evaluate(() => window.editorTest.snapshot().selected))
        .toEqual([{ type: 'note', beat: 5, left: 0, size: 2 }])
    await settle(page)
    await page.screenshot({ path: testInfo.outputPath('composed-selected.png') })
    expect(errors).toEqual([])
})

test('the composed preference leaves non-dynamic chart pixels unchanged', async ({ page }) => {
    await page.evaluate(() => {
        window.editorTest.view.layout = 'basic'
    })
    await settle(page)
    const canvas = page.locator('canvas.editor-chart')
    const basic = await canvas.screenshot()
    await page.evaluate(() => {
        window.editorTest.view.layout = 'composed'
    })
    await settle(page)
    expect((await canvas.screenshot()).equals(basic)).toBe(true)
})

test('a stationary composed stage has no horizontal slice seams at fractional DPR', async ({
    page,
}) => {
    const rows = await page.evaluate(async () => {
        const { appImport, fixtures } = window.editorTest
        const { createState } =
            await appImport<typeof import('../../src/state')>('/src/state/index.ts')
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const { drawComposedStages } = await appImport<
            typeof import('../../src/editor/canvas/stages')
        >('/src/editor/canvas/stages.ts')
        const { fullScope, createScopeLookup } = await appImport<
            typeof import('../../src/editor/scopeRules')
        >('/src/editor/scopeRules.ts')
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
                stageMaskEvents: [0.25, 15.37].map((beat) => ({
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
        const rows: { ratio: number; dimmed: boolean; alphas: number[] }[] = []
        for (const ratio of [0.5, 1, 1.25, 2]) {
            for (const dimmed of [false, true]) {
                const canvas = document.createElement('canvas')
                canvas.width = 560 * ratio
                canvas.height = 960 * ratio
                const ctx = window.editorRendering.getDrawContext(canvas)
                await ctx.ready
                ctx.setTransform(40 * ratio, 0, 0, 40 * ratio, 280 * ratio, 960 * ratio)
                const context = {
                    ctx,
                    state,
                    composed,
                    scale: 40,
                    ups: -3,
                    pixelRatio: ratio,
                    bounds: { l: -7, r: 7, t: -24, b: 0, w: 14, h: 24 },
                } as import('../../src/editor/canvas/types').EditorDrawContext
                drawComposedStages(
                    context,
                    { min: 0, max: 16 },
                    dimmed
                        ? createScopeLookup({
                              stageId: (mask.stageId + 1) as typeof mask.stageId,
                              showOtherStages: true,
                          })
                        : fullScope,
                    4,
                )
                // Halfway between dividers, clear of the stage's lifetime endpoints.
                const pixels = ctx.getImageData(
                    Math.floor(285 * ratio),
                    Math.ceil(50 * ratio),
                    1,
                    Math.floor(880 * ratio),
                ).data
                const alphas = new Set<number>()
                for (let offset = 3; offset < pixels.length; offset += 4)
                    alphas.add(pixels[offset]!)
                rows.push({ ratio, dimmed, alphas: [...alphas] })
                window.editorRendering.disposeDrawContext(canvas)
            }
        }
        return rows
    })
    for (const { ratio, dimmed, alphas } of rows)
        expect(alphas, `DPR ${ratio}, dimmed ${dimmed}`).toEqual([dimmed ? 10 : 41])
})

test('odd division parity aligns one-lane guides with odd and even note edges', async ({
    page,
}, testInfo) => {
    await page.evaluate(() => {
        const { fixtures, show, settings, view } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        settings.width = 18
        settings.pps = 120
        settings.showOtherObjects = false
        show(
            {
                ...fixtures.events,
                bpms: [{ beat: 0, bpm: 120 }],
                cameraEvents: [],
                timeScales: [],
                stageTransformEvents: [],
                stageMaskEvents: [
                    {
                        ...fixtures.events.stageMaskEvents[0]!,
                        beat: 0,
                        maskLeft: -4.5,
                        maskSize: 9,
                    },
                ],
                stagePivotEvents: [
                    {
                        ...fixtures.events.stagePivotEvents[0]!,
                        beat: 0,
                        pivotLane: 0,
                        divisionSize: 3,
                        divisionParity: 'odd',
                    },
                ],
                stageStyleEvents: [
                    { ...fixtures.events.stageStyleEvents[0]!, beat: 0, laneAlpha: 1 },
                ],
                slides: [
                    [{ ...base, beat: 2, left: -0.5, size: 1 }],
                    [{ ...base, beat: 4, left: -1.5, size: 2 }],
                    [{ ...base, beat: 6, left: -1.5, size: 3 }],
                ],
            },
            2.5,
        )
        view.layout = 'composed'
        view.laneDivision = 1
        view.cursorTime = 2.3
        for (const type of Object.keys(view.visibilities)) {
            view.visibilities[type as keyof typeof view.visibilities] =
                type === 'note' || type === 'connector'
        }
    })
    await settle(page)
    await page.screenshot({ path: testInfo.outputPath('odd-parity-guides.png') })
    const parity = await page.evaluate(async () => {
        const { createComposedLayout } =
            await window.editorTest.appImport<typeof import('../../src/editor/composed')>(
                '/src/editor/composed.ts',
            )
        const state = window.editorTest.history.state.value
        const layout = createComposedLayout(state)
        const origin = (note: import('../../src/state/entities/slides/note').NoteEntity) =>
            layout.offset(note.stageId, note.beat) + layout.gridOffset(note.stageId, note.beat)
        return [...window.editorTest.store.getAllEntities()]
            .filter((entity) => entity.type === 'note')
            .map((note) => ({
                size: note.size,
                left: layout.notePosition(note).left - origin(note),
                right: layout.notePosition(note).left + note.size - origin(note),
            }))
    })
    expect(parity.map(({ size }) => size).sort()).toEqual([1, 2, 3])
    expect(
        parity.every(({ left, right }) => Number.isInteger(left) && Number.isInteger(right)),
    ).toBe(true)
})

test('projected offscreen badges and selected outlines follow scope and restore Basic positions', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, settings, view, history, store } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        const pivot = fixtures.events.stagePivotEvents[0]!
        settings.showOtherObjects = false
        show(
            {
                ...fixtures.notes,
                stagePivotEvents: [
                    { ...pivot, stageId: base.stageId, beat: 0, pivotLane: -40 },
                    { ...pivot, stageId: 2 as typeof base.stageId, beat: 0, pivotLane: 40 },
                ],
                slides: [
                    [{ ...base, beat: 3, left: 40 }],
                    [{ ...base, stageId: 2 as typeof base.stageId, beat: 3, left: 0 }],
                ],
            },
            1.5,
        )
        view.layout = 'composed'
        const selected = [...store.getAllEntities()].find(
            (entity) => entity.type === 'note' && entity.left === 40,
        )!
        history.replaceState({ ...history.state.value, selectedEntities: [selected] })
    })
    await settle(page)
    const badges = page.locator('.editor-chart').locator('..').locator('.offscreen-note-indicator')
    await expect(badges).toHaveCount(1)
    await expect(badges).toHaveAttribute('data-side', 'right')
    await expect(badges).toHaveAttribute('data-selectable', '1')
    const visibleSelected = () =>
        page.evaluate(async () => {
            const { visibleSelectedEntities } = await window.editorTest.appImport<
                typeof import('../../src/editor/entities/visible')
            >('/src/editor/entities/visible.ts')
            return visibleSelectedEntities.value.map((entity) =>
                entity.type === 'note' ? entity.left : null,
            )
        })
    expect(await visibleSelected()).toEqual([40])
    await page.evaluate(() => {
        window.editorTest.view.stageId = 1 as import('../../src/chart/stages').StageId
        window.editorTest.settings.showOtherStages = true
    })
    await expect(badges).toHaveAttribute('data-selectable', '0')
    await expect(badges).toHaveCSS('opacity', '0.25')
    await page.evaluate(() => {
        window.editorTest.settings.showOtherStages = false
    })
    await expect(badges).toHaveCount(0)
    expect(await visibleSelected()).toEqual([40])
    await page.evaluate(() => {
        window.editorTest.view.layout = 'basic'
    })
    await settle(page)
    await expect(badges).toHaveCount(1)
    await expect(badges).toHaveAttribute('data-selectable', '1')
    expect(await visibleSelected()).toEqual([])
})

test('engine dynamic stage level renders in the composed editor without browser errors', async ({
    page,
}, testInfo) => {
    const path = process.env.COMPOSED_ENGINE_FIXTURE
    test.skip(!path, 'Set COMPOSED_ENGINE_FIXTURE to an exported engine test level JSON')
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const data = JSON.parse(readFileSync(path!, 'utf8')) as { entities: unknown[] }
    await page.evaluate(async (data) => {
        const { parseLevelDataChart } = await window.editorTest.appImport<
            typeof import('../../src/chart/parse/levelData')
        >('/src/chart/parse/levelData/index.ts')
        const { settings, view, show } = window.editorTest
        const chart = parseLevelDataChart(
            data.entities as Parameters<typeof parseLevelDataChart>[0],
        )
        settings.width = 30
        settings.pps = 50
        settings.showOtherObjects = false
        show(chart, 5)
        view.layout = 'composed'
        for (const type of Object.keys(view.visibilities)) {
            view.visibilities[type as keyof typeof view.visibilities] =
                type === 'note' || type === 'connector'
        }
    }, data)
    await settle(page)
    await page.screenshot({ path: testInfo.outputPath('engine-composed.png') })
    expect(errors).toEqual([])
})

test('a Lane Color edit repaints a stage the composed layout has already drawn', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { fixtures, show, settings, view } = window.editorTest
        settings.width = 24
        settings.pps = 80
        settings.showOtherObjects = false
        // One style event from the start, so the whole visible stretch has its lane color.
        const style = { ...fixtures.events.stageStyleEvents[0]!, beat: 0, laneAlpha: 1 }
        show(
            {
                ...fixtures.events,
                bpms: [{ beat: 0, bpm: 120 }],
                cameraEvents: [],
                timeScales: [],
                stageStyleEvents: [style],
                slides: [],
            },
            5,
        )
        view.layout = 'composed'
        view.laneDivision = 4
    })
    await settle(page)
    await expect.poll(() => page.evaluate(() => window.editorFrames.chart)).toBeGreaterThan(1)
    const canvas = page.locator('canvas.editor-chart')
    const before = await canvas.screenshot()
    await page.evaluate(async () => {
        const { editSelectedEditableEntities } =
            (await import('/src/editor/sidebars/default/index.ts')) as typeof import('../../src/editor/sidebars/default')
        const { history, store } = window.editorTest
        const joint = [...store.getAllEntities()].find(
            (entity) => entity.type === 'stageStyleEventJoint',
        )!
        history.replaceState({ ...history.state.value, selectedEntities: [joint] })
        editSelectedEditableEntities({ laneColor: 'red' })
    })
    await settle(page)
    const after = await canvas.screenshot()
    expect(after.equals(before)).toBe(false)
    // The tint moves from Default’s blue-green to red: pixels gain red and lose blue.
    const moved = await page.evaluate(
        async ({ before, after }) => {
            const read = async (base64: string) => {
                const image = await createImageBitmap(
                    await (await fetch(`data:image/png;base64,${base64}`)).blob(),
                )
                const surface = new OffscreenCanvas(image.width, image.height)
                const ctx = surface.getContext('2d')!
                ctx.drawImage(image, 0, 0)
                return ctx.getImageData(0, 0, image.width, image.height).data
            }
            const [a, b] = await Promise.all([read(before), read(after)])
            let redUp = 0
            let blueDown = 0
            for (let i = 0; i < a.length; i += 4) {
                if (b[i]! > a[i]!) redUp++
                if (b[i + 2]! < a[i + 2]!) blueDown++
            }
            return { redUp, blueDown }
        },
        { before: before.toString('base64'), after: after.toString('base64') },
    )
    expect(moved.redUp).toBeGreaterThan(100)
    expect(moved.blueDown).toBeGreaterThan(100)
})
