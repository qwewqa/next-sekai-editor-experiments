import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const useTool = (page: Page, name: string) =>
    page.evaluate(async (name) => {
        const { switchToolTo } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools')
        >('/src/editor/tools/index.ts')
        switchToolTo(name as never)
    }, name)

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
