import { expect, test, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installCanvasCounters, installEditorFixture, useTool } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// A chart point at the current tempo, which the fixture's point() assumes is 120 BPM.
const at = (page: Page, lane: number, beat: number) =>
    page.evaluate(
        async ({ lane, beat }) => {
            const { view, settings, history, appImport } = window.editorTest
            const { beatToTime } = await appImport<typeof import('../../src/state/integrals/bpms')>(
                '/src/state/integrals/bpms.ts',
            )
            const time = beatToTime(history.state.value.bpms, beat)
            return {
                x: view.x + view.w * (0.5 + (lane - view.lane) / settings.width),
                y: view.y + view.h / 2 - (time - view.time) * settings.pps,
            }
        },
        { lane, beat },
    )

const slideNotes = (page: Page) =>
    page.evaluate(() =>
        [...window.editorTest.history.state.value.store.slides.note.values()]
            .flat()
            .sort((a, b) => a.beat - b.beat)
            .map((note) => ({
                beat: note.beat,
                left: note.left,
                size: note.size,
                isAttached: note.isAttached,
            })),
    )

const editor = (page: Page) => page.locator('.editor-chart').locator('..')

// Slide 1593 of level 15003: a tail at 148 with the attached ticks before it 1/8 beat apart.
const showOverlap = (page: Page, layout: 'basic' | 'composed') =>
    page.evaluate(async (layout) => {
        const { show, fixtures, view, settings, history, appImport } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: layout === 'composed',
                bpms: [{ beat: 0, bpm: 168 }],
                slides: [
                    [
                        { ...base, beat: 147, left: 2, size: 4 },
                        ...Array.from({ length: 7 }, (_, i) => ({
                            ...base,
                            beat: 147.125 + i / 8,
                            left: 1 - i,
                            size: 4,
                            isAttached: true,
                        })),
                        { ...base, beat: 148, left: -6, size: 4 },
                    ],
                ],
            },
            0,
        )
        view.layout = layout
        view.laneDivision = 1
        settings.pps = 400
        const { beatToTime } = await appImport<typeof import('../../src/state/integrals/bpms')>(
            '/src/state/integrals/bpms.ts',
        )
        view.time = beatToTime(history.state.value.bpms, 148)
        view.lane = -4
    }, layout)

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: a press on a tail's edge under an attached tick's hitbox resizes the tail`, async ({
        page,
    }) => {
        await showOverlap(page, layout)
        await useTool(page, 'select')
        // The tail's right edge: the tick 1/8 beat earlier spans it, but draws only its diamond at -3.
        const edge = await at(page, -2.08, 148)
        await page.mouse.move(edge.x - 2, edge.y)
        await page.mouse.move(edge.x, edge.y)
        await expect
            .poll(() => page.evaluate(() => window.editorTest.snapshot().hovered[0]))
            .toEqual({ type: 'note', beat: 148, left: -6, size: 4 })
        await expect(editor(page)).toHaveCSS('cursor', 'ew-resize')
        const lane = await page.evaluate(
            () => window.editorTest.view.w / window.editorTest.settings.width,
        )
        await page.mouse.down()
        await page.mouse.move(edge.x + lane * 0.7, edge.y, { steps: 6 })
        await page.mouse.up()
        const notes = await slideNotes(page)
        expect(notes.at(-1)).toEqual({ beat: 148, left: -6, size: 5, isAttached: false })
        // The ticks stay attached at their beats.
        expect(notes.slice(1, -1).map((note) => [note.beat, note.isAttached])).toEqual(
            Array.from({ length: 7 }, (_, i) => [147.125 + i / 8, true]),
        )

        // On the tick's diamond, the tick is on top; with nothing selected, the hover shows it.
        await page.keyboard.press('Control+z')
        await page.evaluate(() => {
            const { history } = window.editorTest
            history.replaceState({ ...history.state.value, selectedEntities: [] })
        })
        const diamond = await at(page, -3, 147.875)
        await page.mouse.move(diamond.x - 2, diamond.y)
        await page.mouse.move(diamond.x, diamond.y)
        await expect
            .poll(() => page.evaluate(() => window.editorTest.snapshot().hovered[0]?.beat))
            .toBe(147.875)
        await expect(editor(page)).toHaveCSS('cursor', 'move')

        // The Note tool and the eraser take the same note.
        // Over a selection the eraser removes it, so start from none.
        await page.evaluate(() => {
            const { history } = window.editorTest
            history.replaceState({ ...history.state.value, selectedEntities: [] })
        })
        await useTool(page, 'eraser')
        await page.mouse.move(edge.x - 2, edge.y)
        await page.mouse.move(edge.x, edge.y)
        await expect
            .poll(() => page.evaluate(() => window.editorTest.snapshot().hovered))
            .toEqual([{ type: 'note', beat: 148, left: -6, size: 4 }])
        await useTool(page, 'slide')
        await page.mouse.move(edge.x - 2, edge.y)
        await page.mouse.move(edge.x, edge.y)
        await expect(editor(page)).toHaveCSS('cursor', 'ew-resize')
    })
}

test('of a same-beat pair, the one drawn on top is hit first', async ({ page }) => {
    await page.evaluate(() => {
        const { show, fixtures } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 4, left: 0, size: 2, isCritical: false }],
                    [{ ...base, beat: 4, left: 0, size: 2, isCritical: true }],
                ],
            },
            3,
        )
    })
    await useTool(page, 'select')
    const point = await at(page, 1, 4)
    const order = await page.evaluate(async (point) => {
        const { history, view, settings, appImport } = window.editorTest
        const { orderEntities } = await appImport<
            typeof import('../../src/editor/canvas/ordering')
        >('/src/editor/canvas/ordering.ts')
        const { pointHitsAt } = await appImport<typeof import('../../src/editor/tools/utils')>(
            '/src/editor/tools/utils.ts',
        )
        const { scopeLookup } =
            await appImport<typeof import('../../src/editor/scope')>('/src/editor/scope.ts')
        const notes = [...history.state.value.store.slides.note.values()].flat()
        const drawn = orderEntities(notes, new Set(), {
            scope: scopeLookup.value,
            visibilities: view.visibilities,
            showOtherObjects: settings.showOtherObjects,
        })
        return {
            top: drawn.map(({ entity }) => entity.type === 'note' && entity.isCritical).at(-1),
            hit: pointHitsAt(point.x, point.y).hits.map((note) =>
                note.type === 'note' ? note.isCritical : undefined,
            ),
        }
    }, point)
    expect(order).toEqual({ top: true, hit: [true, false] })
    await page.mouse.click(point.x, point.y)
    const selected = () =>
        page.evaluate(() =>
            window.editorTest.history.state.value.selectedEntities.map((note) =>
                note.type === 'note' ? note.isCritical : undefined,
            ),
        )
    expect(await selected()).toEqual([true])
    // Tapping again still cycles to the one beneath.
    await page.mouse.click(point.x, point.y)
    expect(await selected()).toEqual([false])
})

test('the Elevation Editor hits the row drawn on top', async ({ page }) => {
    await page.evaluate(() => {
        const { show, fixtures, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        settings.elevationEditorSideBySide = 'disallow'
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [{ ...base, beat: 4, left: 0, size: 2, elevation: 2 }],
                    [{ ...base, beat: 4, left: 1, size: 2, elevation: 2 }],
                ],
            },
            3,
        )
        // Opening with them selected shows their beat.
        const { history } = window.editorTest
        const source = history.state.value
        history.replaceState({
            ...source,
            selectedEntities: [...source.store.slides.note.values()].flat(),
        })
    })
    await page.keyboard.press('t')
    await expect(page.locator('canvas.elevation-canvas')).toBeVisible()
    await page.evaluate(() => {
        const { history } = window.editorTest
        history.replaceState({ ...history.state.value, selectedEntities: [] })
    })
    const target = await page.evaluate(async () => {
        const { elevationLayout } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const layout = elevationLayout.value
        const box = document.querySelector('canvas.elevation-canvas')!.getBoundingClientRect()
        // Later rows are drawn over earlier ones.
        return {
            x: box.x + layout.xAt(1.5),
            y: box.y + layout.yAt(2),
            top: layout.rows.at(-1)!.note.left,
        }
    })
    await page.mouse.click(target.x, target.y)
    expect(
        await page.evaluate(() =>
            window.editorTest.history.state.value.selectedEntities.map((note) =>
                note.type === 'note' ? note.left : undefined,
            ),
        ),
    ).toEqual([target.top])
})

// Hit = drawn on top: an attached tick's diamond drawn over another selected note's edge is
// what a press takes, so it moves the tick rather than resizing the note beneath.
test("a press on a selected tick's diamond over a selected note's edge moves the tick", async ({
    page,
}) => {
    const show = (gap: number) =>
        page.evaluate((gap) => {
            const { show, fixtures, settings, history } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    slides: [
                        [
                            { ...base, beat: 3, left: 1, size: 2 },
                            { ...base, beat: 4, left: 1, size: 2, isAttached: true },
                            { ...base, beat: 5, left: 1, size: 2 },
                        ],
                        // Its right edge runs under the tick's diamond, centred at lane 2.
                        [{ ...base, beat: 4 + gap, left: 0, size: 2 }],
                    ],
                },
                3,
            )
            settings.pps = 400
            const source = history.state.value
            history.replaceState({
                ...source,
                selectedEntities: [...source.store.slides.note.values()]
                    .flat()
                    .filter((note) => note.beat !== 3 && note.beat !== 5),
            })
        }, gap)
    await show(0.1)
    // The note sits 0.1 lane above the tick (120 BPM): earlier beats draw on top.
    const gap = await page.evaluate(async () => {
        const { ups } =
            await window.editorTest.appImport<typeof import('../../src/editor/view')>(
                '/src/editor/view.ts',
            )
        return (0.1 / Math.abs(ups.value)) * 2
    })
    await show(gap)
    await useTool(page, 'select')
    const press = await at(page, 1.9, 4)
    await page.mouse.move(press.x - 2, press.y)
    await page.mouse.move(press.x, press.y)
    await expect(editor(page)).toHaveCSS('cursor', 'move')
    // With only the note selected, the same press resizes it.
    await page.evaluate(() => {
        const { history } = window.editorTest
        const source = history.state.value
        history.replaceState({
            ...source,
            selectedEntities: source.selectedEntities.filter(
                (note) => note.type === 'note' && !note.isAttached,
            ),
        })
    })
    await page.mouse.move(press.x - 2, press.y)
    await page.mouse.move(press.x, press.y)
    await expect(editor(page)).toHaveCSS('cursor', 'ew-resize')

    await show(gap)
    await page.mouse.move(press.x - 2, press.y)
    await page.mouse.move(press.x, press.y)
    const end = await page.evaluate(() => window.editorTest.point(1.9, 4.5))
    await page.mouse.down()
    await page.mouse.move(press.x, end.y, { steps: 6 })
    await page.mouse.up()
    const notes = await slideNotes(page)
    expect(notes.find((note) => note.isAttached)).toMatchObject({ beat: 4.5, size: 2 })
    const note = notes.find((note) => note.left === 0)!
    expect(note.beat).toBeCloseTo(4.5 + gap, 9)
    expect(note).toMatchObject({ left: 0, size: 2, isAttached: false })
})

// The drawn size differs in Composed; the hit still classifies the note as drawn.
test('a forceNonTick attached note shown at another size is hit on its body', async ({ page }) => {
    await page.evaluate(() => {
        const { show, fixtures } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [
                        { ...base, beat: 2, left: 0, size: 4 },
                        {
                            ...base,
                            beat: 4,
                            left: 0,
                            size: 4,
                            noteType: 'forceNonTick',
                            isAttached: true,
                        },
                        { ...base, beat: 6, left: 0, size: 4 },
                    ],
                ],
            },
            3,
        )
    })
    const point = await at(page, 4, 4)
    const order = await page.evaluate(async (point) => {
        const { history, appImport } = window.editorTest
        const { orderPointHits } = await appImport<typeof import('../../src/editor/tools/utils')>(
            '/src/editor/tools/utils.ts',
        )
        const source = history.state.value
        const [head, tick] = [...source.store.slides.note.values()].flat()
        // Shown a lane wider; the point is on its body, a lane and a half from its diamond.
        const composed = {
            notePosition: (note: { left: number; size: number }) => ({
                left: note.left,
                size: note.size + 1,
            }),
        }
        return orderPointHits([head!, tick!], point.x, point.y, source, composed as never).map(
            (note) => note.beat,
        )
    }, point)
    expect(order).toEqual([4, 2])
})

// Real levels from the engine's resource cache: SEKAI_LEVELS=<...>/resources/levels.
const levels = process.env.SEKAI_LEVELS
const level = levels && join(levels, 'coconut-next-sekai-15003', 'data')

test('level 15003: a press on slide tails at pps 400 resizes the tail', async ({ page }) => {
    test.skip(!level || !existsSync(level), 'Set SEKAI_LEVELS to the engine level cache')
    await page.evaluate(async (data) => {
        const { history, nextTick, appImport } = window.editorTest
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
        const text = await new Response(
            new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
        ).text()
        const { parseLevelData } =
            await appImport<typeof import('../../src/levelData/parse')>('/src/levelData/parse.ts')
        const { parseLevelDataChart } = await appImport<
            typeof import('../../src/chart/parse/levelData')
        >('/src/chart/parse/levelData/index.ts')
        const levelData = parseLevelData(JSON.parse(text))
        history.resetState(false, parseLevelDataChart(levelData.entities), levelData.bgmOffset)
        await nextTick()
    }, readFileSync(level!).toString('base64'))
    await useTool(page, 'select')
    for (const layout of ['basic', 'composed'] as const) {
        // Slides 1593 and 1974 when the editor loads it.
        for (const beat of [148, 165]) {
            const tail = await page.evaluate(
                async ({ beat, layout }) => {
                    const { view, settings, history, appImport } = window.editorTest
                    const { beatToTime } = await appImport<
                        typeof import('../../src/state/integrals/bpms')
                    >('/src/state/integrals/bpms.ts')
                    view.layout = layout
                    settings.pps = 400
                    history.replaceState({ ...history.state.value, selectedEntities: [] })
                    const [id, notes] = [...history.state.value.store.slides.note].find(
                        ([, notes]) =>
                            notes.some((note) => note.isAttached && note.beat === beat - 1 / 8) &&
                            notes.some((note) => !note.isAttached && note.beat === beat),
                    )!
                    const tail = notes.find((note) => note.beat === beat)!
                    view.time = beatToTime(history.state.value.bpms, tail.beat)
                    view.lane = tail.left + tail.size / 2
                    return { id, beat: tail.beat, left: tail.left, size: tail.size }
                },
                { beat, layout },
            )
            await page.evaluate(() => new Promise(requestAnimationFrame))
            const edge = await at(page, tail.left + tail.size * 0.98, tail.beat)
            const lane = await page.evaluate(
                () => window.editorTest.view.w / window.editorTest.settings.width,
            )
            await page.mouse.move(edge.x - 2, edge.y)
            await page.mouse.move(edge.x, edge.y)
            await page.mouse.down()
            await page.mouse.move(edge.x + lane * 0.7, edge.y, { steps: 6 })
            await page.mouse.up()
            const notes = await page.evaluate(
                (id) =>
                    [...window.editorTest.history.state.value.store.slides.note.get(id)!]
                        .sort((a, b) => a.beat - b.beat)
                        .map((note) => [note.beat, note.left, note.size, note.isAttached]),
                tail.id,
            )
            expect(notes.at(-1), `${layout} ${beat}`).toEqual([
                tail.beat,
                tail.left,
                tail.size + 1,
                false,
            ])
            expect(notes.filter((note) => note[3]).length).toBe(7)
            await page.keyboard.press('Control+z')
        }
    }
})
