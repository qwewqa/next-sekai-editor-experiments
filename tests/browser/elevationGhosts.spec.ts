import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, touchInput, useTool } from './editorFixture'

// Ghosts composite as one layer at half opacity in both editors; Basic drags ghost what they move.

declare global {
    interface Window {
        ghostShots: Record<string, ImageData>
    }
}

const errors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
    const pageErrors: string[] = []
    errors.set(page, pageErrors)
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        window.ghostShots = {}
        Object.defineProperty(navigator.clipboard, 'writeText', {
            configurable: true,
            value: async () => undefined,
        })
        Object.defineProperty(navigator.clipboard, 'readText', {
            configurable: true,
            value: async () => '',
        })
    })
})

test.afterEach(async ({ page }) => {
    expect(errors.get(page)).toEqual([])
})

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })

type Note = {
    beat?: number
    left: number
    size?: number
    elevation?: number
    isAttached?: boolean
    groupId?: number
    noteType?: 'anchor'
}

/** Slides of forceNonTick notes, so nothing outlines while the view is in use. */
const seed = (
    page: Page,
    slides: Note[][],
    options: {
        layout?: 'basic' | 'composed'
        sideBySide?: boolean
        groupName?: boolean
        bpms?: { beat: number; bpm: number }[]
        pivots?: { beat: number; pivotLane: number }[]
    } = {},
) =>
    page.evaluate(
        async ({ slides, layout, sideBySide, groupName, bpms, pivots }) => {
            const { fixtures, show, settings, view, history, appImport, nextTick } =
                window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            const pivot = fixtures.events.stagePivotEvents[0]!
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: true,
                    ...(bpms ? { bpms } : {}),
                    stagePivotEvents: pivots.map((event) => ({
                        ...pivot,
                        stageId: base.stageId,
                        ...event,
                    })),
                    slides: slides.map((slide) =>
                        slide.map((note) => ({
                            ...base,
                            beat: 3,
                            size: 4,
                            elevation: 0,
                            noteType: 'forceNonTick' as const,
                            ...note,
                            groupId: (note.groupId ?? base.groupId) as typeof base.groupId,
                        })),
                    ),
                },
                3,
            )
            view.layout = layout
            view.laneDivision = 1
            settings.showPreview = false
            settings.showSidebar = false
            settings.showStageName = false
            settings.showGroupName = groupName
            settings.elevationSnap = 4 as never
            settings.elevationEditorSideBySide = sideBySide ? 'allow' : 'disallow'
            history.replaceState({ ...history.state.value, selectedEntities: [] })
            const { openElevationEditor } = await appImport<
                typeof import('../../src/editor/elevation/state')
            >('/src/editor/elevation/state.ts')
            openElevationEditor(3)
            await nextTick()
        },
        {
            slides,
            layout: options.layout ?? 'basic',
            sideBySide: !!options.sideBySide,
            groupName: !!options.groupName,
            bpms: options.bpms,
            pivots: options.pivots ?? [{ beat: 0, pivotLane: 0.5 }],
        },
    )

// A same-beat slide: 0 to 2 to 4, all four lanes wide.
const pair: Note[][] = [
    [
        { left: -2, elevation: 0 },
        { left: -2, elevation: 2 },
        { left: -2, elevation: 4 },
    ],
]

/** A displayed lane and elevation in the Elevation Editor, in client pixels. */
const at = (page: Page, lane: number, elevation: number) =>
    page.evaluate(
        async ({ lane, elevation }) => {
            const scene = await window.editorTest.appImport<
                typeof import('../../src/editor/elevation/scene')
            >('/src/editor/elevation/scene.ts')
            const layout = scene.elevationLayout.value
            const box = document.querySelector('.elevation-canvas')!.getBoundingClientRect()
            return { x: box.x + layout.xAt(lane), y: box.y + layout.yAt(elevation) }
        },
        { lane, elevation },
    )

type Pane = 'elevation' | 'chart' | 'overlay'
const selectors: Record<Pane, string> = {
    elevation: '.elevation-canvas',
    chart: 'canvas.editor-chart',
    overlay: 'canvas.editor-overlay',
}

/** The device pixel of a canvas under a client point. */
const devicePoint = (page: Page, pane: Pane, point: { x: number; y: number }) =>
    page.evaluate(
        ({ selector, point }) => {
            const canvas = document.querySelector<HTMLCanvasElement>(selector)!
            const box = canvas.getBoundingClientRect()
            return {
                x: Math.round(((point.x - box.x) * canvas.width) / box.width),
                y: Math.round(((point.y - box.y) * canvas.height) / box.height),
            }
        },
        { selector: selectors[pane], point },
    )

const pixel = (page: Page, pane: Pane, point: { x: number; y: number }) =>
    page.evaluate(
        ({ selector, point }) => [
            ...window.editorRendering
                .getDrawContext(document.querySelector<HTMLCanvasElement>(selector)!)
                .getImageData(point.x, point.y, 1, 1).data,
        ],
        { selector: selectors[pane], point },
    )

/** A device pixel near a client point that is clear before anything is drawn there. */
const clearPoint = async (page: Page, pane: Pane, point: { x: number; y: number }) => {
    const device = await devicePoint(page, pane, point)
    return page.evaluate(
        ({ selector, device }) => {
            const canvas = document.querySelector<HTMLCanvasElement>(selector)!
            const data = window.editorRendering
                .getDrawContext(canvas)
                .getImageData(0, 0, canvas.width, canvas.height)
            // Nearest first, clear of grid lines.
            for (let d = 0; d < 12; d++)
                for (let dx = -d; dx <= d; dx++)
                    for (const dy of [d - Math.abs(dx), Math.abs(dx) - d]) {
                        const x = device.x + dx
                        const y = device.y + dy
                        if (data.data[(y * canvas.width + x) * 4 + 3] === 0) return { x, y }
                    }
            throw new Error('No clear pixel')
        },
        { selector: selectors[pane], device },
    )
}

const shoot = (page: Page, pane: Pane, name: string) =>
    page.evaluate(
        ({ selector, name }) => {
            const canvas = document.querySelector<HTMLCanvasElement>(selector)!
            window.ghostShots[name] = window.editorRendering
                .getDrawContext(canvas)
                .getImageData(0, 0, canvas.width, canvas.height)
        },
        { selector: selectors[pane], name },
    )

/** Bytes differing by more than 1 from a shot. */
const differences = (page: Page, pane: Pane, name: string) =>
    page.evaluate(
        ({ selector, name }) => {
            const canvas = document.querySelector<HTMLCanvasElement>(selector)!
            const now = window.editorRendering
                .getDrawContext(canvas)
                .getImageData(0, 0, canvas.width, canvas.height)
            const shot = window.ghostShots[name]!
            if (shot.width !== now.width || shot.height !== now.height) return -1
            let count = 0
            for (let i = 0; i < now.data.length; i++)
                if (Math.abs(now.data[i]! - shot.data[i]!) > 1) count++
            return count
        },
        { selector: selectors[pane], name },
    )

const expectClose = (actual: number[], expected: number[], tolerance = 1) => {
    expect(actual).toHaveLength(expected.length)
    for (const [i, value] of actual.entries())
        expect(Math.abs(value - expected[i]!), `${actual} vs ${expected}`).toBeLessThanOrEqual(
            tolerance,
        )
}

/** What either editor still holds for ghosts. */
const leftovers = (page: Page) =>
    page.evaluate(async () => {
        const { view, appImport } = window.editorTest
        const scene = await appImport<typeof import('../../src/editor/elevation/scene')>(
            '/src/editor/elevation/scene.ts',
        )
        const preview =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        const editor = (
            document.querySelector('.elevation-canvas') as unknown as
                | {
                      __vueParentComponent: {
                          setupState: { creating: unknown[]; ghostCanvas?: HTMLCanvasElement }
                      }
                  }
                | undefined
        )?.__vueParentComponent.setupState
        return {
            creating: view.entities.creating.length,
            rows: editor?.creating.length ?? 0,
            canvas: !!editor?.ghostCanvas,
            dragGhosts: scene.elevationDragRows.value?.ghosts.length ?? 0,
            preview: !!preview.previewEdit.value,
        }
    })
const none = { creating: 0, rows: 0, canvas: false, dragGhosts: 0, preview: false }

/** Copies the notes at these places in store order, and takes the Paste tool. */
const copy = async (page: Page, picks: number[]) => {
    await page.evaluate((picks) => {
        const { history } = window.editorTest
        const notes = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({
            ...history.state.value,
            selectedEntities: picks.map((index) => notes[index]!),
        })
    }, picks)
    await page.keyboard.press('c')
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const paste = await window.editorTest.appImport<
                    typeof import('../../src/editor/tools/paste')
                >('/src/editor/tools/paste/index.ts')
                return paste.getPasteNoteEntities().length
            }),
        )
        .toBe(picks.length)
    await useTool(page, 'paste')
}

/** The Elevation Editor's add and paste ghost rows, in client pixels, with its lane scale. */
const ghostRows = (page: Page) =>
    page.evaluate(async () => {
        const scene = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const layout = scene.elevationLayout.value
        const box = document.querySelector('.elevation-canvas')!.getBoundingClientRect()
        const editor = (
            document.querySelector('.elevation-canvas') as unknown as {
                __vueParentComponent: {
                    setupState: { creating: { lane: number; elevation: number }[] }
                }
            }
        ).__vueParentComponent.setupState
        return editor.creating.map((row) => ({
            x: box.x + layout.xAt(row.lane),
            y: box.y + layout.yAt(row.elevation),
            scale: layout.laneScale,
        }))
    })

const hover = async (page: Page, point: { x: number; y: number }) => {
    await page.mouse.move(point.x - 3, point.y)
    await page.mouse.move(point.x, point.y)
    await settle(page)
}

/** A move drag, held, by the grabbed note's displayed displacement. */
const hold = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y)
    await settle(page)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await settle(page)
}

test('overlapping paste ghosts composite as one half-opacity layer, coloured as they land', async ({
    page,
}) => {
    // Two single-note slides on the same spot.
    await seed(page, [[{ left: 4, elevation: 1 }], [{ left: 4, elevation: 1 }]])
    const target = await at(page, -4, 3.5)
    await copy(page, [0])
    await hover(page, target)
    const [row] = await ghostRows(page)
    await useTool(page, 'select')
    await settle(page)
    const sample = await clearPoint(page, 'elevation', { x: row!.x + 0.35 * row!.scale, y: row!.y })
    await useTool(page, 'paste')
    await hover(page, target)
    const single = await pixel(page, 'elevation', sample)
    await useTool(page, 'select')
    await copy(page, [0, 1])
    await hover(page, target)
    const rows = await ghostRows(page)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual(rows[0])
    expect(rows[0]).toEqual(row)
    const overlapping = await pixel(page, 'elevation', sample)
    expectClose(overlapping, single)
    // Half opacity over a clear pixel.
    expect(Math.abs(single[3]! - 127.5)).toBeLessThanOrEqual(1)
    // Landed, they have the ghosts' colour.
    await page.mouse.down()
    await page.mouse.up()
    await settle(page)
    await page.mouse.move(target.x, target.y + 300)
    await settle(page)
    const landed = await pixel(page, 'elevation', sample)
    expect(landed[3]).toBe(255)
    expectClose(single.slice(0, 3), landed.slice(0, 3), 2)
    await useTool(page, 'select')
    // Once drawn, without its ghosts.
    await settle(page)
    expect(await leftovers(page)).toEqual(none)
})

test('a paste ghost of a same-beat slide draws its ribbons at half their alpha', async ({
    page,
}) => {
    await seed(page, pair)
    await copy(page, [0, 1])
    await hover(page, await at(page, 8, 4))
    const rows = await ghostRows(page)
    expect(rows).toHaveLength(2)
    const ribbon = { x: rows[0]!.x, y: (rows[0]!.y + rows[1]!.y) / 2 }
    // Drawn into a shot without it, to find a clear pixel under the ribbon.
    await useTool(page, 'select')
    await settle(page)
    const sample = await clearPoint(page, 'elevation', { x: ribbon.x + 10, y: ribbon.y })
    await useTool(page, 'paste')
    await hover(page, await at(page, 8, 4))
    const ghost = await pixel(page, 'elevation', sample)
    await page.mouse.down()
    await page.mouse.up()
    await settle(page)
    await page.mouse.move(ribbon.x, ribbon.y + 300)
    await settle(page)
    const landed = await pixel(page, 'elevation', sample)
    expect(landed[3]).toBeGreaterThan(100)
    expect(Math.abs(ghost[3]! - landed[3]! / 2)).toBeLessThanOrEqual(1)
    expectClose(ghost.slice(0, 3), landed.slice(0, 3), 2)
})

test('a Slide add ghost draws its ribbon from the last same-beat note over the solid committed slide', async ({
    page,
}) => {
    await seed(page, pair)
    // The tail selected, so the add goes after it.
    await page.evaluate(() => {
        const { history } = window.editorTest
        const tail = [...history.state.value.store.slides.note.values()].flat().at(-1)
        history.replaceState({ ...history.state.value, selectedEntities: [tail!] })
    })
    await useTool(page, 'slide')
    // Its ribbon runs from the tail at lane 0 and elevation 4 to the ghost at lane 8 and 6.
    const ribbon = await at(page, 4, 5)
    const sample = await clearPoint(page, 'elevation', { x: ribbon.x, y: ribbon.y })
    // The committed ribbon from 0 to 2.
    const committed = await devicePoint(page, 'elevation', await at(page, 0, 1))
    await settle(page)
    const before = await pixel(page, 'elevation', committed)
    expect(before[3]).toBeGreaterThan(100)
    const target = await at(page, 8, 6)
    await hover(page, target)
    expect(await page.evaluate(() => window.editorTest.view.entities.creating.length)).toBe(1)
    const ghost = await pixel(page, 'elevation', sample)
    expect(await pixel(page, 'elevation', committed)).toEqual(before)
    await page.mouse.down()
    await page.mouse.up()
    await settle(page)
    await page.mouse.move(target.x, target.y + 300)
    await settle(page)
    const landed = await pixel(page, 'elevation', sample)
    expect(landed[3]).toBeGreaterThan(100)
    expect(Math.abs(ghost[3]! - landed[3]! / 2)).toBeLessThanOrEqual(1)
    expectClose(ghost.slice(0, 3), landed.slice(0, 3), 2)
})

test('a Slide insert after the selected same-beat note ghosts its ribbons to the next over the solid one between them', async ({
    page,
}) => {
    await seed(page, pair)
    await page.evaluate(() => {
        const { history } = window.editorTest
        const [head] = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({ ...history.state.value, selectedEntities: [head!] })
    })
    await useTool(page, 'slide')
    // The ghost at lane 8 and elevation 1 goes between the head at 0 and the note at 2, both at lane 0.
    const samples = {
        fromHead: await clearPoint(page, 'elevation', await at(page, 4, 0.5)),
        toNext: await clearPoint(page, 'elevation', await at(page, 4, 1.5)),
        // Where an append's, from the tail at 4, would run.
        fromTail: await clearPoint(page, 'elevation', await at(page, 4, 2.5)),
    }
    const committed = await devicePoint(page, 'elevation', await at(page, 0, 1))
    await settle(page)
    const before = await pixel(page, 'elevation', committed)
    expect(before[3]).toBeGreaterThan(100)
    await hover(page, await at(page, 8, 1))
    expect(
        await page.evaluate(async () => {
            const { view, appImport } = window.editorTest
            const { slideAddGhost } = await appImport<
                typeof import('../../src/editor/tools/slide/addPreview')
            >('/src/editor/tools/slide/addPreview.ts')
            return slideAddGhost(view.entities.creating)?.connectors.map(({ head, tail }) => [
                head.elevation,
                tail.elevation,
            ])
        }),
    ).toEqual([
        [0, 1],
        [1, 2],
    ])
    expect((await pixel(page, 'elevation', samples.fromHead))[3]).toBeGreaterThan(30)
    expect((await pixel(page, 'elevation', samples.toNext))[3]).toBeGreaterThan(30)
    expect((await pixel(page, 'elevation', samples.fromTail))[3]).toBe(0)
    expect(await pixel(page, 'elevation', committed)).toEqual(before)
})

test('an Elevation Editor Slide add ghosts the ribbons it changes on the chart beside it', async ({
    page,
}) => {
    // From beat 1 to 5 at lanes -2 to 2; the editor is at beat 3.
    await seed(
        page,
        [
            [
                { beat: 1, left: -2 },
                { beat: 5, left: -2 },
            ],
        ],
        { sideBySide: true },
    )
    await page.evaluate(() => {
        const { history } = window.editorTest
        const [head] = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({ ...history.state.value, selectedEntities: [head!] })
    })
    await useTool(page, 'slide')
    await hover(page, await at(page, 8, 1))
    // Its ribbons from the head and to the tail, at beats 2 and 4, are centred halfway to it.
    const middle = await page.evaluate(() => {
        const [ghost] = window.editorTest.view.entities.creating
        return ghost?.type === 'note' ? (ghost.left + ghost.size / 2) / 2 : NaN
    })
    expect(middle).toBeGreaterThan(3)
    expect(await alphaAt(page, 'overlay', middle, 2)).toBeGreaterThan(30)
    expect(await alphaAt(page, 'overlay', middle, 4)).toBeGreaterThan(30)
    await page.mouse.move(0, 0)
    await settle(page)
    expect(await alphaAt(page, 'overlay', middle, 2)).toBe(0)
    expect(await leftovers(page)).toEqual(none)
})

test('a Basic move ghosts the moved note and its ribbons over the solid committed slide', async ({
    page,
}) => {
    await seed(page, pair)
    // The ribbon from 0 to 2: committed at lane 0, moved to lane 6 its middle spans lanes 1 to 5.
    const old = await at(page, -1, 1)
    const moved = await at(page, 4.5, 1)
    const note = await at(page, 7, 2)
    const oldPoint = await clearPoint(page, 'elevation', moved)
    const notePoint = await clearPoint(page, 'elevation', { x: note.x, y: note.y })
    await settle(page)
    const committedRibbon = await pixel(
        page,
        'elevation',
        await devicePoint(page, 'elevation', old),
    )
    await shoot(page, 'elevation', 'before')
    const from = await at(page, 0, 2)
    const lane = (await at(page, 1, 0)).x - (await at(page, 0, 0)).x
    await hold(page, from, { x: from.x + 6 * lane, y: from.y })
    expect(await page.evaluate(() => window.editorTest.view.entities.creating.length)).toBe(1)
    // The committed ribbon is solid where it was.
    expect(await pixel(page, 'elevation', await devicePoint(page, 'elevation', old))).toEqual(
        committedRibbon,
    )
    const ghostRibbon = await pixel(page, 'elevation', oldPoint)
    const ghostNote = await pixel(page, 'elevation', notePoint)
    expect(Math.abs(ghostNote[3]! - 127.5)).toBeLessThanOrEqual(1)
    await page.mouse.up()
    // Dropped, the chart's ghosts go before any hover could replace them.
    expect(await page.evaluate(() => window.editorTest.view.entities.creating.length)).toBe(0)
    await settle(page)
    await page.mouse.move(from.x, from.y + 300)
    await settle(page)
    const droppedRibbon = await pixel(page, 'elevation', oldPoint)
    const droppedNote = await pixel(page, 'elevation', notePoint)
    expect(droppedRibbon[3]).toBeGreaterThan(100)
    expect(Math.abs(ghostRibbon[3]! - droppedRibbon[3]! / 2)).toBeLessThanOrEqual(1)
    expectClose(ghostRibbon.slice(0, 3), droppedRibbon.slice(0, 3), 2)
    // The ghost is highlighted, as the dropped note, still selected.
    expect(droppedNote[3]).toBe(255)
    expectClose(ghostNote.slice(0, 3), droppedNote.slice(0, 3), 2)
    expect(await leftovers(page)).toEqual(none)
})

/** Once the chart's eased scroll to the beat ends. */
const scrolled = (page: Page) =>
    expect
        .poll(() =>
            page.evaluate(() => {
                const { view } = window.editorTest
                return !view.scrollingX && !view.scrollingY && !view.scrollingPane
            }),
        )
        .toBe(true)

test('a Composed drag that retimes keeps the committed notes solid under its ghosts, as the chart', async ({
    page,
}) => {
    // A note at beat 1 and the tempo change at 2, both moved 2 beats later. The stage's offset
    // puts the note's committed lanes, 1.5 to 5.5, clear of its authored ones.
    await seed(page, [[{ beat: 1, left: -2, elevation: 1 }]], {
        layout: 'composed',
        sideBySide: true,
        bpms: [
            { beat: 0, bpm: 120 },
            { beat: 2, bpm: 60 },
        ],
        pivots: [{ beat: 0, pivotLane: 3.5 }],
    })
    await scrolled(page)
    const sample = await clearPoint(page, 'elevation', await at(page, 4.5, 1))
    // The pointer goes to the chart, which takes the press.
    const chart = (await page.locator('canvas.editor-chart').boundingBox())!
    await page.mouse.move(chart.x + 20, chart.y + 20)
    const drag = await page.evaluate(async () => {
        const { history, store, point, appImport } = window.editorTest
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const { select } = await appImport<typeof import('../../src/editor/tools/select')>(
            '/src/editor/tools/select.ts',
        )
        const { isScenePreview } = await appImport<typeof import('../../src/editor/sceneState')>(
            '/src/editor/sceneState.ts',
        )
        const { isElevationGhostDrag } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const { beatToTime } = await appImport<typeof import('../../src/state/integrals/bpms')>(
            '/src/state/integrals/bpms.ts',
        )
        const source = history.state.value
        const [note] = [...source.store.slides.note.values()].flat()
        history.replaceState({
            ...source,
            selectedEntities: [...store.getAllEntities()].filter(
                (entity) => entity.type === 'note' || (entity.type === 'bpm' && entity.beat > 0),
            ),
        })
        const lane = createComposedLayout(source).noteLeft(note!) + note!.size / 2
        const start = point(lane, beatToTime(source.bpms, note!.beat) * 2)
        const end = point(lane, beatToTime(source.bpms, note!.beat + 2) * 2)
        const modifiers = { ctrl: false, shift: false }
        select.dragStart!(start.x, start.y, modifiers)
        select.dragUpdate!(end.x, end.y, modifiers)
        return {
            scenePreview: isScenePreview.value,
            ghostDrag: isElevationGhostDrag.value,
            offset: createComposedLayout(source).offset(note!.stageId, note!.beat),
        }
    })
    expect(drag).toEqual({ scenePreview: false, ghostDrag: true, offset: 3.5 })
    await settle(page)
    // The pane follows the press to beat 1, where the note stays drawn as committed.
    expect(await leftovers(page)).toMatchObject({ preview: true })
    expect((await pixel(page, 'elevation', sample))[3]).toBe(255)
    await page.evaluate(async () => {
        const { select } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools/select')
        >('/src/editor/tools/select.ts')
        select.dragCancel!()
    })
})

test('a Composed drag that retimes places its ghosts on the committed lanes, as the chart', async ({
    page,
}) => {
    // The pressed note leaves the beat as one at 1 lands on it. The stage's offset eases from
    // 0.5 to 12.5 over beats 0 to 4, so moving the tempo change at 2 to 4 shifts it at beat 3.
    await seed(
        page,
        [[{ beat: 3, left: -10, elevation: 0 }], [{ beat: 1, left: -10, elevation: 1 }]],
        {
            layout: 'composed',
            sideBySide: true,
            bpms: [
                { beat: 0, bpm: 120 },
                { beat: 2, bpm: 60 },
            ],
            pivots: [
                { beat: 0, pivotLane: 0.5 },
                { beat: 4, pivotLane: 12.5 },
            ],
        },
    )
    await scrolled(page)
    const chart = (await page.locator('canvas.editor-chart').boundingBox())!
    await page.mouse.move(chart.x + 20, chart.y + 20)
    const drag = await page.evaluate(async () => {
        const { history, store, point, appImport, view } = window.editorTest
        const { createComposedLayout } =
            await appImport<typeof import('../../src/editor/composed')>('/src/editor/composed.ts')
        const { select } = await appImport<typeof import('../../src/editor/tools/select')>(
            '/src/editor/tools/select.ts',
        )
        const { isScenePreview, sceneState } = await appImport<
            typeof import('../../src/editor/sceneState')
        >('/src/editor/sceneState.ts')
        const { elevationDragRows, elevationState } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const { elevationBeat } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        const { beatToTime } = await appImport<typeof import('../../src/state/integrals/bpms')>(
            '/src/state/integrals/bpms.ts',
        )
        const source = history.state.value
        const pressed = [...source.store.slides.note.values()]
            .flat()
            .find((note) => note.beat === 3)!
        history.replaceState({
            ...source,
            selectedEntities: [...store.getAllEntities()].filter(
                (entity) => entity.type === 'note' || (entity.type === 'bpm' && entity.beat > 0),
            ),
        })
        const lane = createComposedLayout(source).noteLeft(pressed) + pressed.size / 2
        const start = point(lane, beatToTime(source.bpms, 3) * 2)
        const end = point(lane, beatToTime(source.bpms, 5) * 2)
        const modifiers = { ctrl: false, shift: false }
        select.dragStart!(start.x, start.y, modifiers)
        select.dragUpdate!(end.x, end.y, modifiers)
        const ghosts = elevationDragRows.value?.ghosts ?? []
        const [row] = ghosts
        const ghost = view.entities.creating.find(
            (entity) => entity.type === 'note' && entity.beat === 3,
        )
        const center = (state: typeof source, note: typeof pressed) => {
            const position = createComposedLayout(state).notePosition(note)
            return position.left + position.size / 2
        }
        const result = {
            scenePreview: isScenePreview.value,
            beat: elevationBeat.value,
            ghosts: ghosts.length,
            // From the chart's ghost, as its scene places it.
            chart: ghost?.type === 'note' && row ? center(sceneState.value, ghost) - row.lane : NaN,
            preview: row ? center(elevationState.value, row.note) - row.lane : NaN,
        }
        select.dragCancel!()
        return result
    })
    expect(drag).toMatchObject({ scenePreview: false, beat: 3, ghosts: 1 })
    expect(Math.abs(drag.chart)).toBeLessThan(1e-6)
    // The previewed tempo would place it a lane further.
    expect(Math.abs(drag.preview)).toBeGreaterThan(0.5)
})

test('a Basic drag that retimes ghosts only its moved notes, with no ghost ribbons or live slides, as the chart', async ({
    page,
}) => {
    // The middle note leaves the beat, opening a ribbon between the others; moving the far
    // slide's tail shifts its tick here; a note at 1 lands here. The tempo change at 2 moves with
    // them, rebuilding the unmoved tick of the slide across it, whose ends' lanes differ.
    await seed(
        page,
        [
            [
                { left: -2, elevation: 0 },
                { left: 2, elevation: 2 },
                { left: -2, elevation: 4 },
            ],
            [
                { beat: 1, left: 6, elevation: 0 },
                { left: 6, isAttached: true },
                { beat: 5, left: 6, elevation: 4 },
            ],
            [{ beat: 1, left: -10, elevation: -3 }],
            [
                { beat: 0, left: -12, elevation: -2 },
                { left: -12, isAttached: true },
                { beat: 6, left: -4, elevation: -2 },
            ],
        ],
        {
            sideBySide: true,
            bpms: [
                { beat: 0, bpm: 120 },
                { beat: 2, bpm: 60 },
            ],
        },
    )
    await scrolled(page)
    await settle(page)
    const sample = await clearPoint(page, 'elevation', await at(page, 0, 2))
    const chart = (await page.locator('canvas.editor-chart').boundingBox())!
    await page.mouse.move(chart.x + 20, chart.y + 20)
    const drag = await page.evaluate(async () => {
        const { history, store, point, appImport, view } = window.editorTest
        const { select } = await appImport<typeof import('../../src/editor/tools/select')>(
            '/src/editor/tools/select.ts',
        )
        const { isScenePreview, previewSlides } = await appImport<
            typeof import('../../src/editor/sceneState')
        >('/src/editor/sceneState.ts')
        const { elevationDragRows, elevationState } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const { elevationBeat } = await appImport<
            typeof import('../../src/editor/elevation/state')
        >('/src/editor/elevation/state.ts')
        const { beatToTime } = await appImport<typeof import('../../src/state/integrals/bpms')>(
            '/src/state/integrals/bpms.ts',
        )
        const source = history.state.value
        const notes = [...source.store.slides.note.values()].flat()
        const middle = notes.find((note) => note.left === 2)!
        const tail = notes.find((note) => note.beat === 5)!
        const landing = notes.find((note) => note.left === -10)!
        const head = notes.find((note) => note.beat === 0)!
        const tick = notes.find((note) => note.isAttached && note.slideId === head.slideId)!
        history.replaceState({
            ...source,
            selectedEntities: [
                middle,
                tail,
                landing,
                ...[...store.getAllEntities()].filter(
                    (entity) => entity.type === 'bpm' && entity.beat > 0,
                ),
            ],
        })
        const start = point(4, beatToTime(source.bpms, 3) * 2)
        const end = point(4, beatToTime(source.bpms, 5) * 2)
        const modifiers = { ctrl: false, shift: false }
        select.dragStart!(start.x, start.y, modifiers)
        select.dragUpdate!(end.x, end.y, modifiers)
        const editor = (
            document.querySelector('.elevation-canvas') as unknown as {
                __vueParentComponent: { setupState: { connections: { ghosts: unknown[] } } }
            }
        ).__vueParentComponent.setupState
        return {
            scenePreview: isScenePreview.value,
            chartSlides: !!previewSlides.value,
            chartGhosts: view.entities.creating.length,
            beat: elevationBeat.value,
            rebuilt: !elevationState.value.store.slides.note.get(tick.slideId)!.includes(tick),
            ghostRibbons: editor.connections.ghosts.length,
            ghostRows: elevationDragRows.value?.ghosts.map((row) => row.note.left),
            live: elevationDragRows.value?.live.size,
        }
    })
    expect(drag).toEqual({
        scenePreview: false,
        chartSlides: false,
        chartGhosts: 4,
        beat: 3,
        rebuilt: true,
        ghostRibbons: 0,
        ghostRows: [-10],
        live: 0,
    })
    await settle(page)
    // No ribbon is ghosted between the notes left on the beat.
    expect((await pixel(page, 'elevation', sample))[3]).toBe(0)
    await page.evaluate(async () => {
        const { select } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools/select')
        >('/src/editor/tools/select.ts')
        select.dragCancel!()
    })
})

test('a preview scene hides a hover ghost, as on the chart', async ({ page }) => {
    await seed(page, [[{ left: 4, elevation: 1 }]], { layout: 'composed' })
    const target = await at(page, -4, 3.5)
    const sample = await clearPoint(page, 'elevation', target)
    await copy(page, [0])
    await hover(page, target)
    expect(await leftovers(page)).toMatchObject({ rows: 1, canvas: true })
    expect((await pixel(page, 'elevation', sample))[3]).toBeGreaterThan(100)
    // A preview that isn't a draft, such as a dialog's, shows in Composed.
    await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { setPreviewEdit } =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        const source = history.state.value
        setPreviewEdit(source, () => ({ ...source }))
    })
    await settle(page)
    expect(await leftovers(page)).toMatchObject({ rows: 1, canvas: false })
    expect((await pixel(page, 'elevation', sample))[3]).toBe(0)
})

test('a chart move taking a note off the beat ghosts the ribbon it leaves between unmoved notes', async ({
    page,
}) => {
    // The middle note is off to the right, so the ribbon joining the others runs clear of it.
    await seed(
        page,
        [
            [
                { left: -2, elevation: 0 },
                { left: 2, elevation: 2 },
                { left: -2, elevation: 4 },
            ],
        ],
        { sideBySide: true },
    )
    await scrolled(page)
    await settle(page)
    const sample = await clearPoint(page, 'elevation', await at(page, 0, 2))
    const point = (lane: number, beat: number) =>
        page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), { lane, beat })
    await hold(page, await point(4, 3), await point(4, 5))
    expect(await leftovers(page)).toMatchObject({ preview: true, dragGhosts: 0, canvas: true })
    const ghost = await pixel(page, 'elevation', sample)
    expect(ghost[3]).toBeGreaterThan(30)
    expect(ghost[3]).toBeLessThan(160)
    await page.mouse.up()
})

test('a Composed move stays live', async ({ page }) => {
    await seed(page, pair, { layout: 'composed' })
    const moved = await at(page, 4.5, 1)
    const movedPoint = await clearPoint(page, 'elevation', moved)
    const from = await at(page, 0, 2)
    const lane = (await at(page, 1, 0)).x - (await at(page, 0, 0)).x
    await hold(page, from, { x: from.x + 6 * lane, y: from.y })
    expect(await leftovers(page)).toMatchObject({ canvas: false, dragGhosts: 0 })
    const live = await pixel(page, 'elevation', movedPoint)
    await page.mouse.up()
    await settle(page)
    await page.mouse.move(from.x, from.y + 300)
    await settle(page)
    expect(live[3]).toBeGreaterThan(100)
    expect(await pixel(page, 'elevation', movedPoint)).toEqual(live)
})

test('a Basic drag that shifts an unmoved attached tick draws its slide solid, as it drops', async ({
    page,
}) => {
    // The tick shares its head's beat, so it shows on the head, and follows it.
    await seed(page, [
        [
            { left: -2, elevation: 0 },
            { left: -2, isAttached: true },
            { beat: 5, left: -2, elevation: 4 },
        ],
    ])
    await page.evaluate(() => {
        const { history } = window.editorTest
        const [head] = [...history.state.value.store.slides.note.values()].flat()
        history.replaceState({ ...history.state.value, selectedEntities: [head!] })
    })
    const from = await at(page, 0, 0)
    const to = await at(page, 0, 2)
    await hold(page, from, to)
    const scene = await page.evaluate(async () => {
        const { appImport, view } = window.editorTest
        const { elevationDragRows } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const rows = elevationDragRows.value!
        return {
            ghosts: rows.ghosts.length,
            live: rows.live.size,
            elevations: rows.rows.map((row) => row.elevation),
            creating: view.entities.creating.length,
        }
    })
    expect(scene).toEqual({ ghosts: 0, live: 1, elevations: [2, 2], creating: 1 })
    expect(await leftovers(page)).toMatchObject({ canvas: false })
    await page.mouse.up()
})

test('a Basic drag that shifts a tick off the beat draws its slide solid, as the chart', async ({
    page,
}) => {
    // Moving the middle note's lane shifts the tick it heads at beat 4, so the chart previews the slide.
    await seed(page, [
        [
            { left: -2, elevation: 0 },
            { left: -2, elevation: 2 },
            { beat: 4, left: -2, isAttached: true },
            { beat: 5, left: 2, elevation: 4 },
        ],
    ])
    const from = await at(page, 0, 2)
    const lane = (await at(page, 1, 0)).x - (await at(page, 0, 0)).x
    await hold(page, from, { x: from.x + 6 * lane, y: from.y })
    const scene = await page.evaluate(async () => {
        const { appImport, view } = window.editorTest
        const { previewSlides } = await appImport<typeof import('../../src/editor/sceneState')>(
            '/src/editor/sceneState.ts',
        )
        const { elevationDragRows } = await appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const editor = (
            document.querySelector('.elevation-canvas') as unknown as {
                __vueParentComponent: { setupState: { connections: { ghosts: unknown[] } } }
            }
        ).__vueParentComponent.setupState
        const rows = elevationDragRows.value!
        return {
            chartSlides: previewSlides.value?.slideIds.size,
            creating: view.entities.creating.length,
            ghosts: rows.ghosts.length,
            ghostRibbons: editor.connections.ghosts.length,
            live: rows.live.size,
        }
    })
    expect(scene).toEqual({ chartSlides: 1, creating: 1, ghosts: 0, ghostRibbons: 0, live: 1 })
    expect(await leftovers(page)).toMatchObject({ canvas: false })
    await page.mouse.up()
})

test('a Basic drag of an attached tick ghosts the tick, as the chart does', async ({ page }) => {
    await seed(page, [
        [
            { left: -2, elevation: 0 },
            { left: -2, elevation: 2, isAttached: true },
            { left: -2, elevation: 4 },
        ],
    ])
    const from = await at(page, 0, 2)
    const to = await at(page, 0, 3)
    await hold(page, from, to)
    expect(await leftovers(page)).toMatchObject({ dragGhosts: 1, canvas: true, creating: 1 })
    await page.mouse.up()
})

for (const ending of ['Escape', 'tool switch', 'beat change', 'pane close'] as const) {
    test(`a Basic move leaves nothing behind after ${ending}`, async ({ page }) => {
        await seed(page, pair, { sideBySide: true })
        // Pressed, it's selected; selected first, the drag leaves the selection as it was.
        await page.evaluate(() => {
            const { history } = window.editorTest
            const [, middle] = [...history.state.value.store.slides.note.values()].flat()
            history.replaceState({ ...history.state.value, selectedEntities: [middle!] })
        })
        const from = await at(page, 0, 2)
        const lane = (await at(page, 1, 0)).x - (await at(page, 0, 0)).x
        // Once the chart's eased scroll to the beat ends.
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const { view } = window.editorTest
                    return !view.scrollingX && !view.scrollingY && !view.scrollingPane
                }),
            )
            .toBe(true)
        await settle(page)
        // Shot with the mouse away from notes, as nothing hovers then.
        const away = await at(page, -8, -3)
        await page.mouse.move(away.x, away.y)
        await settle(page)
        await shoot(page, 'elevation', 'before')
        await shoot(page, 'overlay', 'overlay')
        await hold(page, from, { x: from.x + 6 * lane, y: from.y })
        expect(await leftovers(page)).toMatchObject({ creating: 1, canvas: true, dragGhosts: 1 })
        // The chart's overlay isn't read here: a read canvas can keep stale pixels through a clear.
        await page.evaluate(async (ending) => {
            const { appImport } = window.editorTest
            const state = await appImport<typeof import('../../src/editor/elevation/state')>(
                '/src/editor/elevation/state.ts',
            )
            const tools = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            if (ending === 'tool switch') {
                tools.switchToolTo('brush')
                tools.switchToolTo('select')
            } else if (ending === 'beat change') {
                state.elevationBeat.value = 4
                await window.editorTest.nextTick()
                state.elevationBeat.value = 3
            } else if (ending === 'pane close') state.closeElevationEditor()
        }, ending)
        if (ending === 'Escape') await page.keyboard.press('Escape')
        // The chart's ghosts go with the drag, before any hover could replace them.
        expect(await page.evaluate(() => window.editorTest.view.entities.creating.length)).toBe(0)
        await page.mouse.up()
        await page.mouse.move(away.x, away.y)
        await settle(page)
        expect(await leftovers(page)).toEqual(none)
        // Closing the pane resizes the chart.
        if (ending !== 'pane close') {
            expect(await differences(page, 'overlay', 'overlay')).toBe(0)
            expect(await differences(page, 'elevation', 'before')).toBe(0)
        }
        expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(false)
    })
}

test('a ghost name composites with its note at half opacity', async ({ page }) => {
    await seed(page, [[{ left: 4, elevation: 1, groupId: 2 }]], { groupName: true })
    await copy(page, [0])
    const target = await at(page, -4, 3)
    await hover(page, target)
    const [row] = await ghostRows(page)
    const area = await page.evaluate((row) => {
        const canvas = document.querySelector<HTMLCanvasElement>('.elevation-canvas')!
        const box = canvas.getBoundingClientRect()
        const ratio = canvas.width / box.width
        return {
            x0: Math.round((row.x - box.x - 2 * row.scale) * ratio),
            y0: Math.round((row.y - box.y - 0.35 * row.scale) * ratio),
            w: Math.round(4 * row.scale * ratio),
            h: Math.round(0.7 * row.scale * ratio),
        }
    }, row!)
    const read = () =>
        page.evaluate(({ x0, y0, w, h }) => {
            const canvas = document.querySelector<HTMLCanvasElement>('.elevation-canvas')!
            return [
                ...window.editorRendering.getDrawContext(canvas).getImageData(x0, y0, w, h).data,
            ]
        }, area)
    const named = await read()
    await page.evaluate(() => {
        window.editorTest.settings.showGroupName = false
    })
    await settle(page)
    const plain = await read()
    await useTool(page, 'select')
    await page.mouse.move(target.x, target.y + 300)
    await settle(page)
    const blank = await read()
    // The name shows, and nowhere clear beneath is the ghost more than half opaque.
    expect(named).not.toEqual(plain)
    let max = 0
    for (let i = 3; i < named.length; i += 4) if (!blank[i]) max = Math.max(max, named[i]!)
    expect(max).toBeGreaterThan(100)
    expect(max).toBeLessThanOrEqual(128)
})

test('off-screen badges count the solid notes during a Basic drag, not its ghosts', async ({
    page,
}) => {
    await seed(page, [[{ left: -2, elevation: 0 }], [{ left: 3, elevation: -3 }]])
    await page.evaluate(() => {
        const { history } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()].flat(),
        })
    })
    await settle(page)
    const badges = page.locator('.elevation-editor .offscreen-note-indicator')
    await expect(badges).toHaveCount(0)
    const from = await at(page, 0, 0)
    const low = await at(page, 4, -3)
    const box = (await page.locator('.elevation-canvas').boundingBox())!
    // The low note's ghost goes below the pane while the grabbed one's stays in it.
    const delta = box.y + box.height + 40 - low.y
    expect(from.y + delta).toBeLessThan(box.y + box.height - 60)
    await hold(page, from, { x: from.x, y: from.y + delta })
    expect(await leftovers(page)).toMatchObject({ dragGhosts: 2 })
    await settle(page)
    await expect(badges).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.mouse.up()
})

test('ghost notes are highlighted: a ghost anchor shows while the view rests', async ({ page }) => {
    await seed(page, [[{ left: 4, elevation: 1, noteType: 'anchor' }]])
    await copy(page, [0])
    const target = await at(page, -4, 3)
    await hover(page, target)
    const [row] = await ghostRows(page)
    const area = await page.evaluate((row) => {
        const canvas = document.querySelector<HTMLCanvasElement>('.elevation-canvas')!
        const box = canvas.getBoundingClientRect()
        const ratio = canvas.width / box.width
        return {
            x0: Math.round((row.x - box.x - 2.2 * row.scale) * ratio),
            y0: Math.round((row.y - box.y - 0.4 * row.scale) * ratio),
            w: Math.round(4.4 * row.scale * ratio),
            h: Math.round(0.8 * row.scale * ratio),
        }
    }, row!)
    const read = () =>
        page.evaluate(({ x0, y0, w, h }) => {
            const canvas = document.querySelector<HTMLCanvasElement>('.elevation-canvas')!
            return [
                ...window.editorRendering.getDrawContext(canvas).getImageData(x0, y0, w, h).data,
            ]
        }, area)
    // Without recent use, only a highlighted anchor draws.
    await page.evaluate(() => {
        window.editorTest.view.lastActive = Number.NEGATIVE_INFINITY
    })
    await settle(page)
    const ghost = await read()
    await useTool(page, 'select')
    await page.evaluate(() => {
        window.editorTest.view.lastActive = Number.NEGATIVE_INFINITY
    })
    await settle(page)
    const blank = await read()
    let shown = 0
    for (let i = 3; i < ghost.length; i += 4) if (ghost[i]! > blank[i]! + 8) shown++
    expect(shown).toBeGreaterThan(20)
})

for (const layout of ['basic', 'composed'] as const) {
    test(`chart ${layout}: a slide note's move ${layout === 'basic' ? 'ghosts its ribbons over the committed ones' : 'stays live'}`, async ({
        page,
    }) => {
        await page.evaluate((layout) => {
            const { show, fixtures, view, settings, history } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: true,
                    slides: [
                        [
                            { ...base, beat: 2, left: -4, size: 2, noteType: 'forceNonTick' },
                            { ...base, beat: 4, left: -2, size: 2, noteType: 'forceNonTick' },
                            { ...base, beat: 6, left: 0, size: 2, noteType: 'forceNonTick' },
                        ],
                    ],
                },
                4,
            )
            view.layout = layout
            settings.showStageName = false
            settings.showGroupName = false
            history.replaceState({ ...history.state.value, selectedEntities: [] })
        }, layout)
        await settle(page)
        const point = (lane: number, beat: number) =>
            page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), { lane, beat })
        // At beat 3 the committed ribbon spans lanes -3 to -1; moved 6 right, 0 to 2.
        const old = await devicePoint(page, 'chart', await point(-2, 3))
        const moved = await point(1.5, 3)
        const movedOverlay = await devicePoint(page, 'overlay', moved)
        const movedChart = await devicePoint(page, 'chart', moved)
        const committed = await pixel(page, 'chart', old)
        const clearChart = await pixel(page, 'chart', movedChart)
        const from = await point(-1, 4)
        const to = await point(5, 4)
        await hold(page, from, to)
        const overlay = await pixel(page, 'overlay', movedOverlay)
        const chart = await pixel(page, 'chart', movedChart)
        if (layout === 'basic') {
            expect(overlay[3]).toBeGreaterThan(30)
            expect(overlay[3]).toBeLessThan(160)
            expect(await pixel(page, 'chart', old)).toEqual(committed)
            expect(chart).toEqual(clearChart)
        } else {
            expect(overlay[3]).toBe(0)
            expect(await pixel(page, 'chart', old)).not.toEqual(committed)
            expect(chart).not.toEqual(clearChart)
        }
        await page.mouse.up()
    })
}

type ChartNote = { beat: number; left: number; isAttached?: boolean; noteType?: 'default' }

/** Slides of two-lane notes on the chart, with those at these indexes, in store order, selected. */
const showChart = (
    page: Page,
    slides: ChartNote[][],
    selected: number[] = [],
    layout: 'basic' | 'composed' = 'basic',
) =>
    page.evaluate(
        ({ slides, selected, layout }) => {
            const { show, fixtures, view, settings, history } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: true,
                    slides: slides.map((slide) =>
                        slide.map((note) => ({
                            ...base,
                            size: 2,
                            noteType: 'forceNonTick' as const,
                            ...note,
                        })),
                    ),
                },
                4,
            )
            view.layout = layout
            settings.showStageName = false
            settings.showGroupName = false
            const notes = [...history.state.value.store.slides.note.values()].flat()
            history.replaceState({
                ...history.state.value,
                selectedEntities: selected.map((index) => notes[index]!),
            })
        },
        { slides, selected, layout },
    )

/** A chart lane and beat, in client pixels. */
const chartPoint = (page: Page, lane: number, beat: number) =>
    page.evaluate(({ lane, beat }) => window.editorTest.point(lane, beat), { lane, beat })

/** The alpha of a pane's pixel at a chart lane and beat. */
const alphaAt = async (page: Page, pane: Pane, lane: number, beat: number) =>
    (await pixel(page, pane, await devicePoint(page, pane, await chartPoint(page, lane, beat))))[3]!

test('chart basic: a drag that shifts an attached tick draws its slide solid, with no ghost ribbon over it', async ({
    page,
}) => {
    // The first slide's tick follows its head; the second slide only moves.
    await showChart(
        page,
        [
            [
                { beat: 2, left: -6 },
                { beat: 4, left: -5, isAttached: true },
                { beat: 6, left: -4 },
            ],
            [
                { beat: 2, left: 0 },
                { beat: 6, left: 0 },
            ],
        ],
        [0, 3],
    )
    await settle(page)
    // Moved 4 right, the first slide runs from lane -1 by its tick at -2 to -3; the second's ribbon at beat 4 spans 2 to 4.
    const shifted = [
        [-1.5, 3],
        [-2, 5],
    ] as const
    const before = await Promise.all(
        shifted.map(async ([lane, beat]) =>
            pixel(
                page,
                'chart',
                await devicePoint(page, 'chart', await chartPoint(page, lane, beat)),
            ),
        ),
    )
    await hold(page, await chartPoint(page, -5, 2), await chartPoint(page, -1, 2))
    expect(await alphaAt(page, 'overlay', 3.2, 4)).toBeGreaterThan(30)
    for (const [i, [lane, beat]] of shifted.entries()) {
        expect(await alphaAt(page, 'overlay', lane, beat)).toBe(0)
        const point = await devicePoint(page, 'chart', await chartPoint(page, lane, beat))
        expect(await pixel(page, 'chart', point)).not.toEqual(before[i])
    }
    await page.mouse.up()
})

test('chart basic: moving a slide end ghosts only the ribbon it changes', async ({ page }) => {
    await showChart(
        page,
        [
            [
                { beat: 2, left: -4 },
                { beat: 4, left: -4 },
                { beat: 6, left: -4 },
                { beat: 8, left: -4 },
            ],
        ],
        [3],
    )
    await settle(page)
    // Moved 4 right, the last ribbon at beat 7 spans lanes -2 to 0.
    await hold(page, await chartPoint(page, -3, 8), await chartPoint(page, 1, 8))
    expect(await alphaAt(page, 'overlay', -1, 7)).toBeGreaterThan(30)
    expect(await alphaAt(page, 'overlay', -3, 3)).toBe(0)
    expect(await alphaAt(page, 'overlay', -3, 5)).toBe(0)
    await page.mouse.up()
})

test('chart basic: moving a slide note past another ghosts the ribbon its leaving makes', async ({
    page,
}) => {
    await showChart(
        page,
        [
            [
                { beat: 2, left: -6 },
                { beat: 4, left: 0 },
                { beat: 6, left: -6 },
            ],
        ],
        [1],
    )
    await settle(page)
    // Moved to beat 8, the middle note leaves a ribbon from the first to the last, at lane -5.
    await hold(page, await chartPoint(page, 1, 4), await chartPoint(page, 1, 8))
    expect(await alphaAt(page, 'overlay', -5, 3)).toBeGreaterThan(30)
    expect(await alphaAt(page, 'overlay', -5, 5)).toBeGreaterThan(30)
    await page.mouse.up()
})

for (const tool of ['note', 'slide'] as const) {
    test(`chart basic: a ${tool} tool move ghosts its ribbons`, async ({ page }) => {
        await showChart(page, [
            [
                { beat: 2, left: -4 },
                { beat: 4, left: -2 },
                { beat: 6, left: 0 },
            ],
        ])
        await useTool(page, tool)
        await settle(page)
        // Moved 6 right, the first ribbon at beat 3 spans lanes 0 to 2.
        await hold(page, await chartPoint(page, -1, 4), await chartPoint(page, 5, 4))
        expect(await page.evaluate(() => window.editorTest.view.entities.creating.length)).toBe(1)
        const alpha = await alphaAt(page, 'overlay', 1.5, 3)
        expect(alpha).toBeGreaterThan(30)
        expect(alpha).toBeLessThan(160)
        await page.mouse.up()
    })
}

/** The chart's Slide add ghost: its note's centre, and its preview's ribbons and ticks. */
const chartAddGhost = (page: Page) =>
    page.evaluate(async () => {
        const { view, appImport } = window.editorTest
        const { slideAddGhost } = await appImport<
            typeof import('../../src/editor/tools/slide/addPreview')
        >('/src/editor/tools/slide/addPreview.ts')
        const [ghost] = view.entities.creating
        const preview = slideAddGhost(view.entities.creating)
        return {
            centre: ghost?.type === 'note' ? ghost.left + ghost.size / 2 : NaN,
            connectors: preview?.connectors.length ?? 0,
            ticks: preview?.ticks.map((tick) => tick.left + tick.size / 2) ?? [],
        }
    })

// A slide from lanes -4 to -2 at beat 2 to beat 4, its head selected.
const twoNotes: ChartNote[][] = [
    [
        { beat: 2, left: -4 },
        { beat: 4, left: -4 },
    ],
]

for (const layout of ['basic', 'composed'] as const) {
    test(`chart ${layout}: a Slide add between two notes ghosts the ribbons it makes over the solid one`, async ({
        page,
    }) => {
        await showChart(page, [[...twoNotes[0]!, { beat: 8, left: -4 }]], [0], layout)
        await useTool(page, 'slide')
        await settle(page)
        const solid = await devicePoint(page, 'chart', await chartPoint(page, -3, 6))
        const committed = await pixel(page, 'chart', solid)
        expect(committed[3]).toBeGreaterThan(100)
        await hover(page, await chartPoint(page, 4, 6))
        const ghost = await chartAddGhost(page)
        expect(ghost.connectors).toBe(2)
        // From the second note to the ghost at beat 5, and from it to the last at beat 7, halfway.
        const middle = (-3 + ghost.centre) / 2
        for (const beat of [5, 7]) {
            const alpha = await alphaAt(page, 'overlay', middle, beat)
            expect(alpha).toBeGreaterThan(30)
            expect(alpha).toBeLessThan(160)
        }
        // The first piece is unchanged, and the one replaced stays solid.
        expect(await alphaAt(page, 'overlay', -3, 3)).toBe(0)
        expect(await pixel(page, 'chart', solid)).toEqual(committed)
        await page.mouse.move(0, 0)
        await settle(page)
        expect(await alphaAt(page, 'overlay', middle, 5)).toBe(0)
    })
}

test("chart basic: a Slide insert at the selected note's beat ghosts the pieces to and from it, not on from it", async ({
    page,
}) => {
    // A and B at beat 2, C at beat 6; A selected.
    await showChart(
        page,
        [
            [
                { beat: 2, left: -6 },
                { beat: 2, left: 2 },
                { beat: 6, left: -6 },
            ],
        ],
        [0],
    )
    await useTool(page, 'slide')
    await hover(page, await chartPoint(page, -1, 2))
    const pieces = await page.evaluate(async () => {
        const { view, appImport } = window.editorTest
        const { slideAddGhost } = await appImport<
            typeof import('../../src/editor/tools/slide/addPreview')
        >('/src/editor/tools/slide/addPreview.ts')
        return slideAddGhost(view.entities.creating)?.connectors.map(({ head, tail }) => [
            head.left,
            tail.left,
        ])
    })
    expect(pieces).toEqual([
        [-6, -1],
        [-1, 2],
    ])
    // B to C stays as it is; an append would ghost one from the new note to C.
    expect(await alphaAt(page, 'overlay', -3, 4)).toBe(0)
})

test('chart basic: a Slide add past the tail ghosts the ribbon to it', async ({ page }) => {
    await showChart(page, twoNotes, [0])
    await useTool(page, 'slide')
    await hover(page, await chartPoint(page, 4, 6))
    const ghost = await chartAddGhost(page)
    expect(ghost.connectors).toBe(1)
    expect(await alphaAt(page, 'overlay', (-3 + ghost.centre) / 2, 5)).toBeGreaterThan(30)
    expect(await alphaAt(page, 'overlay', -3, 3)).toBe(0)
})

test('chart basic: a Slide add that re-attaches a tick ghosts it at its new lane', async ({
    page,
}) => {
    // The tick at beat 4 sits on lanes -6 to -4 between the ends.
    await showChart(
        page,
        [
            [
                { beat: 2, left: -6 },
                { beat: 4, left: -6, isAttached: true, noteType: 'default' },
                { beat: 6, left: -6 },
            ],
        ],
        [0],
    )
    await useTool(page, 'slide')
    const target = await chartPoint(page, 4, 5)
    await hover(page, target)
    const ghost = await chartAddGhost(page)
    // Between the head and the ghost at beat 5, it moves two thirds of the way.
    expect(ghost.ticks).toHaveLength(1)
    const tick = ghost.ticks[0]!
    expect(tick).toBeCloseTo(-5 + ((ghost.centre + 5) * 2) / 3, 1)
    // Opaque over the ghost ribbon, which alone composites to less.
    expect(await alphaAt(page, 'overlay', tick, 4)).toBeGreaterThan(120)
    expect(await alphaAt(page, 'overlay', (-5 + ghost.centre) / 2, 3.5)).toBeLessThan(115)
    await page.mouse.click(target.x, target.y)
    await settle(page)
    const landed = await page.evaluate(() => {
        const [slide] = window.editorTest.history.state.value.store.slides.note.values()
        const note = slide!.find((note) => note.beat === 4)!
        return note.left + note.size / 2
    })
    expect(landed).toBeCloseTo(tick, 9)
})

test('chart basic: a Slide width-drag add ghosts the ribbon it makes', async ({ page }) => {
    await showChart(page, twoNotes, [0])
    await useTool(page, 'slide')
    await hold(page, await chartPoint(page, 2, 6), await chartPoint(page, 5, 6))
    const ghost = await chartAddGhost(page)
    expect(ghost.connectors).toBe(1)
    expect(await alphaAt(page, 'overlay', (-3 + ghost.centre) / 2, 5)).toBeGreaterThan(30)
    await page.mouse.up()
    await settle(page)
    expect(await chartAddGhost(page)).toMatchObject({ connectors: 0, ticks: [] })
})

test('chart basic: a Slide hover near a note ghosts nothing', async ({ page }) => {
    await showChart(page, twoNotes, [0])
    await useTool(page, 'slide')
    await hover(page, await chartPoint(page, 4, 6))
    const middle = (-3 + (await chartAddGhost(page)).centre) / 2
    expect(await alphaAt(page, 'overlay', middle, 5)).toBeGreaterThan(30)
    await hover(page, await chartPoint(page, -3, 4))
    expect(await page.evaluate(() => window.editorTest.view.entities.creating.length)).toBe(0)
    expect(await alphaAt(page, 'overlay', middle, 5)).toBe(0)
})

test('chart basic: a Slide hover within one snapped cell keeps its add preview', async ({
    page,
}) => {
    await showChart(page, twoNotes, [0])
    await useTool(page, 'slide')
    // The ghost note and a ribbon of the add, kept on the page.
    const keep = () =>
        page.evaluate(async () => {
            const { view, appImport } = window.editorTest
            const { slideAddGhost } = await appImport<
                typeof import('../../src/editor/tools/slide/addPreview')
            >('/src/editor/tools/slide/addPreview.ts')
            const kept = ((window as unknown as { kept?: unknown[][] }).kept ??= [])
            kept.push([
                view.entities.creating[0],
                slideAddGhost(view.entities.creating)?.connectors[0],
            ])
        })
    const point = await chartPoint(page, 4.1, 6)
    await hover(page, point)
    await keep()
    await page.mouse.move(point.x + 2, point.y + 1)
    await settle(page)
    await keep()
    expect(
        await page.evaluate(() => {
            const [[ghost, connector], [next, nextConnector]] = (
                window as unknown as { kept: unknown[][] }
            ).kept as [unknown[], unknown[]]
            return [!!ghost && ghost === next, !!connector && connector === nextConnector]
        }),
    ).toEqual([true, true])
})

test.describe('with touch', () => {
    test.use({ hasTouch: true })

    test('a touch move drop leaves the chart no ghosts', async ({ page }) => {
        const touch = await touchInput(page)
        await seed(page, pair, { sideBySide: true })
        const from = await at(page, 0, 2)
        const lane = (await at(page, 1, 0)).x - (await at(page, 0, 0)).x
        await touch('touchStart', [[from.x, from.y]])
        await settle(page)
        for (let step = 1; step <= 6; step++)
            await touch('touchMove', [[from.x + step * lane, from.y]])
        await settle(page)
        expect(await leftovers(page)).toMatchObject({ creating: 1, dragGhosts: 1 })
        await touch('touchEnd', [])
        await settle(page)
        expect(await page.evaluate(() => window.editorTest.history.canUndo.value)).toBe(true)
        expect(await leftovers(page)).toEqual(none)
    })
})
