import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, useTool } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const ghost = (page: Page) =>
    page.evaluate(() =>
        window.editorTest.view.entities.creating
            .filter((entity) => entity.type === 'note')
            .map((entity) => ({ beat: entity.beat, lane: entity.hitbox!.lane })),
    )

const notes = (page: Page) =>
    page.evaluate(() =>
        window.editorTest
            .snapshot()
            .notes.map((note) => ({ beat: note.beat, lane: note.left! + note.size! / 2 })),
    )

// The right dock rail, beside the chart pane.
const offPane = { x: 1590 }

for (const layout of ['basic', 'composed'] as const) {
    for (const tool of ['note', 'slide', 'paste'] as const) {
        test(`${layout} ${tool}: a still hover ghost follows division changes and a click lands on it`, async ({
            page,
        }) => {
            await page.evaluate((layout) => {
                const { show, fixtures, view, history } = window.editorTest
                const base = fixtures.interaction.slides[0]![0]!
                show({ ...fixtures.interaction, slides: [[{ ...base, beat: 1, left: 4 }]] }, 3)
                view.layout = layout
                view.division = 8
                view.laneDivision = 4
                const source = history.state.value
                history.replaceState({
                    ...source,
                    selectedEntities: [...source.store.slides.note.values()].flat(),
                })
            }, layout)
            if (tool === 'paste') await page.keyboard.press('Control+c')
            await useTool(page, tool)
            const at = await page.evaluate(() => window.editorTest.point(-2.6, 4.375))
            await page.mouse.move(at.x - 4, at.y)
            await page.mouse.move(at.x, at.y)
            const beat = async () => (await ghost(page))[0]?.beat
            await expect.poll(beat).toBe(4.375)
            await page.keyboard.press('2')
            await expect.poll(beat).toBe(4.5)
            await page.evaluate(() => {
                window.editorTest.view.laneDivision = 1
            })
            // Paste keeps a Basic note's lane fraction, so only placement snaps the lane here.
            if (tool !== 'paste')
                await expect.poll(() => ghost(page)).toEqual([{ beat: 4.5, lane: -2 }])
            await page.evaluate(() => new Promise(requestAnimationFrame))
            const [shown] = await ghost(page)
            await page.mouse.click(at.x, at.y)
            expect(await notes(page)).toContainEqual(shown)
        })
    }
}

test('a still hover ghost reappears at its new place after a layout switch', async ({ page }) => {
    await page.evaluate(() => {
        const { show, fixtures, view } = window.editorTest
        const pivot = fixtures.events.stagePivotEvents[0]!
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: true,
                stagePivotEvents: [{ ...pivot, beat: 0, pivotLane: 1.2 }],
                slides: [],
            },
            3,
        )
        view.layout = 'basic'
        view.division = 4
    })
    await useTool(page, 'note')
    const at = await page.evaluate(() => window.editorTest.point(-2.6, 4))
    await page.mouse.move(at.x - 4, at.y)
    await page.mouse.move(at.x, at.y)
    await expect.poll(() => ghost(page)).toHaveLength(1)
    const basic = (await ghost(page))[0]!
    await page.evaluate(() => {
        window.editorTest.view.layout = 'composed'
    })
    await expect.poll(() => ghost(page)).toHaveLength(1)
    expect((await ghost(page))[0]!.lane).not.toBe(basic.lane)
})

test('the Elevation Editor ghost follows lane division changes under a still mouse', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { show, fixtures, view, settings } = window.editorTest
        show({ ...fixtures.interaction, slides: [] }, 3)
        view.laneDivision = 4
        settings.elevationEditorSideBySide = 'disallow'
    })
    await page.keyboard.press('t')
    await expect(page.locator('canvas.elevation-canvas')).toBeVisible()
    await page.locator('.elevation-editor').focus()
    await page.keyboard.press('a')
    const at = await page.evaluate(async () => {
        const { elevationLayout } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const layout = elevationLayout.value
        const box = document.querySelector('canvas.elevation-canvas')!.getBoundingClientRect()
        return { x: box.x + layout.xAt(1.37), y: box.y + layout.yAt(2) }
    })
    await page.mouse.move(at.x - 4, at.y)
    await page.mouse.move(at.x, at.y)
    const left = () =>
        page.evaluate(() => window.editorTest.snapshot().creating.map((note) => note.left))
    await expect.poll(left).toEqual([1.25])
    await page.evaluate(() => {
        window.editorTest.view.laneDivision = 1
    })
    await expect.poll(left).toEqual([1])
})

test('the Elevation Editor ghost follows elevation snap changes under a still mouse', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { show, fixtures, settings } = window.editorTest
        show({ ...fixtures.interaction, slides: [] }, 3)
        Object.assign(settings, { elevationSnap: 8 })
        settings.elevationEditorSideBySide = 'disallow'
    })
    await page.keyboard.press('t')
    await expect(page.locator('canvas.elevation-canvas')).toBeVisible()
    await page.locator('.elevation-editor').focus()
    await page.keyboard.press('a')
    const at = await page.evaluate(async () => {
        const { elevationLayout } = await window.editorTest.appImport<
            typeof import('../../src/editor/elevation/scene')
        >('/src/editor/elevation/scene.ts')
        const layout = elevationLayout.value
        const box = document.querySelector('canvas.elevation-canvas')!.getBoundingClientRect()
        return { x: box.x + layout.xAt(1), y: box.y + layout.yAt(2.3) }
    })
    await page.mouse.move(at.x - 4, at.y)
    await page.mouse.move(at.x, at.y)
    const elevation = () =>
        page.evaluate(() =>
            window.editorTest.view.entities.creating.map((note) =>
                note.type === 'note' ? note.elevation : undefined,
            ),
        )
    await expect.poll(elevation).toEqual([2.25])
    await page.evaluate(() => {
        Object.assign(window.editorTest.settings, { elevationSnap: 1 })
    })
    await expect.poll(elevation).toEqual([2])
})

// No hover ghost reads the lane snapping mode (paste keeps its lanes), so only beat snapping is checked.
for (const layout of ['basic', 'composed'] as const) {
    test(`${layout} paste: a still hover ghost follows the beat snapping mode`, async ({
        page,
    }) => {
        await page.evaluate((layout) => {
            const { show, fixtures, view, history } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: layout === 'composed',
                    slides: [[{ ...base, beat: 1.1, left: 4 }]],
                },
                3,
            )
            view.layout = layout
            view.division = 8
            const source = history.state.value
            history.replaceState({
                ...source,
                selectedEntities: [...source.store.slides.note.values()].flat(),
            })
        }, layout)
        await page.keyboard.press('Control+c')
        await useTool(page, 'paste')
        const at = await page.evaluate(() => window.editorTest.point(-2.6, 4.375))
        await page.mouse.move(at.x - 4, at.y)
        await page.mouse.move(at.x, at.y)
        const beat = async () => (await ghost(page))[0]?.beat
        await expect.poll(beat).toBe(4.375)
        // Relative snapping keeps the copied note's 0.1 beat off the grid.
        await page.evaluate(() => {
            window.editorTest.view.snapping = 'relative'
        })
        await expect.poll(beat).toBe(4.35)
        await page.evaluate(() => new Promise(requestAnimationFrame))
        const [shown] = await ghost(page)
        await page.mouse.click(at.x, at.y)
        expect(await notes(page)).toContainEqual(shown)
    })
}

for (const tool of ['note', 'stagePivotEvent', 'bpm', 'paste'] as const) {
    test(`${tool}: the hover ghost goes when the pointer leaves the chart and comes back with it`, async ({
        page,
    }) => {
        await page.evaluate(() => {
            const { show, fixtures, history } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            show({ ...fixtures.interaction, slides: [[{ ...base, beat: 1, left: 4 }]] }, 3)
            const source = history.state.value
            history.replaceState({
                ...source,
                selectedEntities: [...source.store.slides.note.values()].flat(),
            })
        })
        if (tool === 'paste') await page.keyboard.press('Control+c')
        const at = await page.evaluate(() => window.editorTest.point(-2.6, 4.5))
        const clip = { x: at.x - 120, y: at.y - 30, width: 240, height: 60 }
        const creating = () => page.evaluate(() => window.editorTest.view.entities.creating.length)
        // The same path with Select, which shows no ghost, draws the reference.
        await useTool(page, 'select')
        await page.mouse.move(at.x, at.y, { steps: 4 })
        await page.mouse.move(offPane.x, at.y, { steps: 6 })
        const empty = await page.screenshot({ clip })
        await useTool(page, tool)
        await page.mouse.move(at.x - 4, at.y)
        await page.mouse.move(at.x, at.y)
        await expect.poll(creating).toBeGreaterThan(0)
        await expect.poll(async () => (await page.screenshot({ clip })).equals(empty)).toBe(false)
        await page.mouse.move(offPane.x, at.y, { steps: 6 })
        await expect.poll(creating).toBe(0)
        await expect.poll(async () => (await page.screenshot({ clip })).equals(empty)).toBe(true)
        // A lane limit change off the pane doesn't bring it back.
        await page.evaluate(() => {
            window.editorTest.settings.maxLane = 6
        })
        await page.evaluate(() => new Promise(requestAnimationFrame))
        expect(await creating()).toBe(0)
        await page.mouse.move(at.x, at.y, { steps: 6 })
        await expect.poll(creating).toBeGreaterThan(0)
    })
}

test('a drag that leaves the chart keeps its preview until release', async ({ page }) => {
    await page.evaluate(() => {
        const { show, fixtures } = window.editorTest
        show({ ...fixtures.interaction, slides: [] }, 3)
    })
    await useTool(page, 'note')
    const at = await page.evaluate(() => window.editorTest.point(-2.6, 4.5))
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 40, at.y, { steps: 4 })
    await page.mouse.move(offPane.x, at.y, { steps: 6 })
    expect(
        await page.evaluate(() => window.editorTest.view.entities.creating.length),
    ).toBeGreaterThan(0)
    await page.mouse.up()
    expect(await notes(page)).toHaveLength(1)
})

test('the Elevation Editor ghost goes when the pointer leaves it', async ({ page }) => {
    await page.evaluate(() => {
        const { show, fixtures, settings } = window.editorTest
        show({ ...fixtures.interaction, slides: [] }, 3)
        settings.elevationEditorSideBySide = 'disallow'
    })
    await page.keyboard.press('t')
    const canvas = page.locator('canvas.elevation-canvas')
    await expect(canvas).toBeVisible()
    await page.locator('.elevation-editor').focus()
    await page.keyboard.press('a')
    const box = (await canvas.boundingBox())!
    const at = { x: box.width * 0.25, y: box.height * 0.3 }
    const clip = { x: box.x + at.x - 120, y: box.y + at.y - 40, width: 240, height: 80 }
    const empty = await page.screenshot({ clip })
    await page.mouse.move(box.x + at.x - 4, box.y + at.y)
    await page.mouse.move(box.x + at.x, box.y + at.y)
    await expect
        .poll(() => page.evaluate(() => window.editorTest.view.entities.creating.length))
        .toBe(1)
    await expect.poll(async () => (await page.screenshot({ clip })).equals(empty)).toBe(false)
    await page.mouse.move(box.x - 20, box.y + at.y, { steps: 6 })
    await expect
        .poll(() => page.evaluate(() => window.editorTest.view.entities.creating.length))
        .toBe(0)
    await expect.poll(async () => (await page.screenshot({ clip })).equals(empty)).toBe(true)
})
