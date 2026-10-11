import { expect, test, type Page } from '@playwright/test'
import { notes, point, setup } from './crossStageSlide'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// In Basic, dragging a slide's head or tail past an unselected tick draws the slide as it drops,
// with the tick as the new end where gameplay drew it.
const errors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
    const pageErrors: string[] = []
    errors.set(page, pageErrors)
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test.afterEach(async ({ page }) => {
    expect(errors.get(page)).toEqual([])
})

const useTool = (page: Page, tool: string) =>
    page.evaluate(async (tool) => {
        const { switchToolTo } = await window.editorTest.appImport<
            typeof import('../../src/editor/tools')
        >('/src/editor/tools/index.ts')
        switchToolTo(tool as never)
    }, tool)

const brief = ({
    beat,
    left,
    size,
    elevation,
    attached,
}: Awaited<ReturnType<typeof notes>>[0]) => ({
    beat,
    left,
    size,
    elevation,
    attached,
})

/** The previewed slides' notes, as the chart draws them; undefined when none. */
const previewed = (page: Page) =>
    page.evaluate(async () => {
        const { previewSlides } = await window.editorTest.appImport<
            typeof import('../../src/editor/sceneState')
        >('/src/editor/sceneState.ts')
        const preview = previewSlides.value
        if (!preview) return
        return [...preview.entities]
            .flatMap((note) =>
                note.type === 'note'
                    ? [
                          {
                              beat: note.beat,
                              left: note.left,
                              size: note.size,
                              elevation: note.elevation,
                              attached: note.isAttached,
                          },
                      ]
                    : [],
            )
            .sort((a, b) => a.beat - b.beat || a.left - b.left)
    })

/** Slide S's notes as stored. */
const slide = async (page: Page) =>
    (await notes(page))
        .filter((note) => note.beat !== 8)
        .map(brief)
        .sort((a, b) => a.beat - b.beat || a.left - b.left)

/** The editor around the tick, left of the notices. */
const tickRow = async (page: Page) => {
    const from = await point(page, -8, 4.4)
    const to = await point(page, -1.5, 3.6)
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    return page.screenshot({
        clip: { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y },
    })
}

for (const tool of ['select', 'note', 'slide'] as const) {
    for (const [end, lane, from, past, short] of [
        ['head', -3, 2, 5, 3],
        ['tail', -2.5, 6, 3, 5],
    ] as const) {
        test(`${tool}: dragging the ${end} past a tick previews the tick as the new end`, async ({
            page,
        }) => {
            await setup(page, 'basic')
            await useTool(page, tool)
            const before = await slide(page)
            const start = await point(page, lane, from)
            await page.mouse.move(start.x, start.y)
            await page.mouse.down()
            // Short of the tick, the chart draws the slide as it is.
            const near = await point(page, lane, short)
            await page.mouse.move(near.x, near.y, { steps: 6 })
            expect(await previewed(page)).toBeUndefined()
            const shown = await tickRow(page)
            // Past it, the slide as it drops.
            const target = await point(page, lane, past)
            await page.mouse.move(target.x, target.y, { steps: 6 })
            const preview = await previewed(page)
            const drawn = await tickRow(page)
            expect(drawn.equals(shown)).toBe(false)
            await page.mouse.up()
            const after = await slide(page)
            expect(after).not.toEqual(before)
            expect(preview).toEqual(after)
            expect(after.find((note) => note.beat === 4)).toEqual({
                beat: 4,
                left: -5.25,
                size: 2.5,
                elevation: 2,
                attached: true,
            })
            expect((await tickRow(page)).equals(drawn)).toBe(true)

            // Escape draws the slide as it is again.
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
            await page.keyboard.press('z')
            await expect.poll(() => slide(page)).toEqual(before)
            await page.mouse.move(start.x, start.y)
            await page.mouse.down()
            await page.mouse.move(near.x, near.y, { steps: 6 })
            const again = await tickRow(page)
            await page.mouse.move(target.x, target.y, { steps: 6 })
            expect(await previewed(page)).toEqual(after)
            await page.keyboard.press('Escape')
            await expect.poll(() => previewed(page)).toBeUndefined()
            expect((await tickRow(page)).equals(again)).toBe(true)
            await page.mouse.up()
            expect(await slide(page)).toEqual(before)
        })
    }
}

test('a drag that leaves a slide’s ends draws it as it is, even with an end stored attached', async ({
    page,
}) => {
    await page.evaluate(() => {
        const { show, fixtures } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: false,
                slides: [
                    [
                        { ...base, beat: 2, left: -4, size: 2, isAttached: true },
                        { ...base, beat: 4, left: 0, size: 2, isAttached: true },
                        { ...base, beat: 6, left: 2, size: 2 },
                    ],
                ],
            },
            3,
        )
    })
    for (const tool of ['select', 'note'] as const) {
        await useTool(page, tool)
        const start = await point(page, 3, 6)
        const end = await point(page, 4.5, 6.5)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(end.x, end.y, { steps: 6 })
        expect(await page.evaluate(() => window.editorTest.view.entities.creating.length)).toBe(1)
        expect(await previewed(page)).toBeUndefined()
        await page.keyboard.press('Escape')
        await page.mouse.up()
    }
})
