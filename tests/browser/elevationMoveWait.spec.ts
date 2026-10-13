import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

type Setup = {
    layout: 'basic' | 'composed'
    // Notes at beat 3 at these elevations, or a slide there whose tick sits between its ends on two stages.
    elevations?: number[]
    slide?: boolean
    snap?: number
    snapping?: 'absolute' | 'relative'
}

const setup = async (page: Page, options: Setup) => {
    await page.evaluate(
        async ({ layout, elevations = [], slide, snap = 4, snapping = 'absolute' }) => {
            const { show, fixtures, view, settings, history, appImport } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: true,
                    stageTransformEvents: slide
                        ? [1, 2].map((stageId) => ({
                              ...fixtures.events.stageTransformEvents[0]!,
                              stageId: stageId as never,
                              beat: 0,
                              xTranslation: 0,
                              elevation: stageId === 2 ? 4 : 0,
                          }))
                        : [],
                    slides: slide
                        ? [
                              [
                                  {
                                      ...base,
                                      beat: 3,
                                      left: -4,
                                      elevation: 0,
                                      connectorEase: 'inQuad',
                                  },
                                  { ...base, beat: 3, left: 0, elevation: 1, isAttached: true },
                                  { ...base, beat: 3, left: 4, elevation: 4, stageId: 2 as never },
                              ],
                          ]
                        : elevations.map((elevation, index) => [
                              { ...base, beat: 3, left: -4 + index * 4, elevation },
                          ]),
                },
                3,
            )
            view.layout = layout
            view.laneDivision = 1
            view.laneSnapping = 'absolute'
            view.snapping = snapping
            Object.assign(settings, { elevationSnap: snap })
            settings.showSidebar = false
            settings.showPreview = false
            settings.elevationEditorSideBySide = 'disallow'
            const source = history.state.value
            history.replaceState({
                ...source,
                selectedEntities: [...source.store.slides.note.values()].flat(),
            })
            const { openElevationEditor } = await appImport<
                typeof import('../../src/editor/elevation/state')
            >('/src/editor/elevation/state.ts')
            openElevationEditor(3)
            const { switchToolTo } = await appImport<typeof import('../../src/editor/tools')>(
                '/src/editor/tools/index.ts',
            )
            switchToolTo('select')
        },
        options,
    )
    await expect(page.locator('.elevation-canvas')).toBeVisible()
    // The vertical drags of 0.2 are 24px, past the 20px a drag starts at.
    await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const { elevationViewport } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/viewport')
        >('/src/editor/elevation/viewport.ts')
        Object.assign(elevationViewport, { center: 2.5, scale: 120 })
    })
}

// Drags the row at beat 3 drawn at this elevation (the first one) by dx lanes and up by dy.
const drag = async (page: Page, dx: number, dy: number, row = 0) => {
    const point = await page.evaluate(async (row) => {
        const { elevationLayout } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const layout = elevationLayout.value
        const target = [...layout.rows].sort((a, b) => a.note.left - b.note.left)[row]!
        const box = document.querySelector('canvas.elevation-canvas')!.getBoundingClientRect()
        return {
            x: box.x + target.x,
            y: box.y + target.y,
            lane: layout.laneScale,
            up: layout.yAt(1) - layout.yAt(0),
        }
    }, row)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.move(point.x + dx * point.lane, point.y + dy * point.up, { steps: 6 })
    await page.mouse.up()
}

const stored = (page: Page) =>
    page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { canUndo } =
            await appImport<typeof import('../../src/history')>('/src/history/index.ts')
        return {
            notes: [...history.state.value.store.slides.note.values()]
                .flat()
                .sort((a, b) => a.beat - b.beat || a.left - b.left)
                .map((note) => ({ left: note.left, elevation: note.elevation })),
            canUndo: canUndo.value,
        }
    })

for (const layout of ['basic', 'composed'] as const) {
    test(`${layout}: an Elevation Editor move waits for half an elevation step`, async ({
        page,
    }) => {
        for (const [snapping, dx, dy, elevation] of [
            // Under half a step of 1/4 up or down, a lane-only drag leaves the elevation.
            ['absolute', 1.2, 0.1, 0.37],
            ['absolute', 1.2, -0.1, 0.37],
            ['absolute', 0, 0.2, 0.5],
            ['absolute', 0, -0.2, 0.25],
            ['relative', 1.2, 0.1, 0.37],
            ['relative', 0, 0.2, 0.62],
        ] as const) {
            await setup(page, { layout, elevations: [0.37], snapping })
            await drag(page, dx, dy)
            const [note] = (await stored(page)).notes
            const label = `${snapping} ${dx} ${dy}`
            expect(note!.elevation, label).toBe(elevation)
            expect(note!.left, label).toBe(dx ? -3 : -4)
            await page.keyboard.press('Escape')
        }
        // Snap off follows the pointer.
        await setup(page, { layout, elevations: [0.37], snap: 0 })
        await drag(page, 1.2, 0.1)
        expect((await stored(page)).notes[0]!.elevation).toBeCloseTo(0.47, 2)
    })

    test(`${layout}: the grabbed row decides a multi-row elevation move`, async ({ page }) => {
        await setup(page, { layout, elevations: [0.37, 0.9] })
        await drag(page, 0, 0.1)
        expect((await stored(page)).notes.map((note) => note.elevation)).toEqual([0.37, 0.9])
        await setup(page, { layout, elevations: [0.37, 0.9] })
        await drag(page, 0, 0.2)
        const [first, second] = (await stored(page)).notes
        expect(first!.elevation).toBe(0.5)
        expect(second!.elevation).toBeCloseTo(1.03)
    })

    test(`${layout}: a jitter on an attached row edits nothing`, async ({ page }) => {
        await setup(page, { layout, slide: true })
        const before = await stored(page)
        await drag(page, 0.3, 0.1, 1)
        expect(await stored(page)).toEqual(before)
        expect(before.canUndo).toBe(false)
        // A real move still edits the slide.
        await drag(page, 0.3, 0.6, 1)
        const after = await stored(page)
        expect(after.notes[0]!.elevation).toBeGreaterThan(0)
        expect(after.notes[2]!.elevation).toBeGreaterThan(4)
        expect(after.canUndo).toBe(true)
    })
}
