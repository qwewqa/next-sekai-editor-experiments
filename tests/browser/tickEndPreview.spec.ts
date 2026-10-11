import { expect, test, type Page } from '@playwright/test'
import { notes, point, setup } from './crossStageSlide'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// In Basic, a drag that moves a slide's unmoved ticks, along their connector or past an end,
// draws the slide as it drops.
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
const tickRow = (page: Page) => area(page, -8, -1.5, 3.6, 4.4)

const area = async (
    page: Page,
    laneMin: number,
    laneMax: number,
    beatMin: number,
    beatMax: number,
) => {
    const from = await point(page, laneMin, beatMax)
    const to = await point(page, laneMax, beatMin)
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
            const pressed = await tickRow(page)
            // Short of the tick, the tick moves along its connector.
            const near = await point(page, lane, short)
            await page.mouse.move(near.x, near.y, { steps: 6 })
            const relerped = await previewed(page)
            expect(relerped?.find((note) => note.beat === 4)?.attached).toBe(true)
            expect(relerped).not.toEqual(before)
            // Past it, it becomes the end.
            const target = await point(page, lane, past)
            await page.mouse.move(target.x, target.y, { steps: 6 })
            const preview = await previewed(page)
            const drawn = await tickRow(page)
            // The moved note is drawn as it drops, without its ghost.
            const movedArea = () => area(page, lane - 2, lane + 2, past - 0.6, past + 0.6)
            const moved = await movedArea()
            expect(drawn.equals(pressed)).toBe(false)
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
            expect((await movedArea()).equals(moved)).toBe(true)

            // Escape draws the slide as it is again.
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
            await page.keyboard.press('z')
            await expect.poll(() => slide(page)).toEqual(before)
            await page.mouse.move(start.x, start.y)
            await page.mouse.down()
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

// Head at -4, a tick, a middle note at 0 and the tail at 2; the head is stored attached in one case.
const showSlide = (page: Page, attachedHead = false) =>
    page.evaluate((attachedHead) => {
        const { show, fixtures } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: false,
                slides: [
                    [
                        { ...base, beat: 2, left: -4, size: 2, isAttached: attachedHead },
                        { ...base, beat: 3, left: 0, size: 2, isAttached: true },
                        { ...base, beat: 4, left: 0, size: 2 },
                        { ...base, beat: 6, left: 2, size: 2 },
                    ],
                ],
            },
            3,
        )
    }, attachedHead)

const stored = (page: Page) =>
    page.evaluate(() =>
        [...window.editorTest.history.state.value.store.slides.note.values()]
            .flat()
            .map(({ beat, left, size, elevation, isAttached }) => ({
                beat,
                left,
                size,
                elevation,
                attached: isAttached,
            }))
            .sort((a, b) => a.beat - b.beat),
    )

for (const tool of ['select', 'note', 'slide'] as const) {
    test(`${tool}: moving a head sideways previews its tick moving along the connector`, async ({
        page,
    }) => {
        await showSlide(page)
        await useTool(page, tool)
        const before = await stored(page)
        const start = await point(page, -3, 2)
        const target = await point(page, -1, 2)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(target.x, target.y, { steps: 6 })
        const preview = await previewed(page)
        await page.mouse.up()
        const after = await stored(page)
        expect(after[1]!.left).not.toBe(before[1]!.left)
        expect(after[1]!.attached).toBe(true)
        expect(preview).toEqual(after)
    })
}

test('a drag that moves no unmoved tick draws its slide as it is', async ({ page }) => {
    // The tail's move leaves the tick between the head and the middle note; the head is stored attached.
    await showSlide(page, true)
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
    // A whole slide moves its ticks with it.
    await useTool(page, 'select')
    await page.evaluate(() => {
        const { history } = window.editorTest
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()].flat(),
        })
    })
    const start = await point(page, -3, 2)
    const end = await point(page, -1, 2.5)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 6 })
    expect(await page.evaluate(() => window.editorTest.view.entities.creating.length)).toBe(4)
    expect(await previewed(page)).toBeUndefined()
    await page.keyboard.press('Escape')
    await page.mouse.up()
})

test('a pending property edit under a Slide tool hover leaves the chart as it is', async ({
    page,
}) => {
    await showSlide(page)
    await page.evaluate(async () => {
        const { history, settings, nextTick } = window.editorTest
        settings.showSidebar = true
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...history.state.value.store.slides.note.values()]
                .flat()
                .filter((note) => note.beat === 2),
        })
        await nextTick()
    })
    await useTool(page, 'slide')
    const chart = () =>
        page.evaluate(async () => {
            await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
            )
            return document.querySelector<HTMLCanvasElement>('canvas.editor-chart')!.toDataURL()
        })
    const empty = await point(page, 4, 1)
    await page.mouse.move(empty.x, empty.y)
    const before = await chart()
    // Typed, not committed: the field keeps focus and only previews.
    await page.getByLabel('Lane', { exact: true }).fill('-1')
    await page.mouse.move(empty.x + 4, empty.y)
    const pending = await page.evaluate(async () => {
        const { appImport, view, history } = window.editorTest
        const { previewEdit } =
            await appImport<typeof import('../../src/preview/edit')>('/src/preview/edit.ts')
        const { previewSlides } = await appImport<typeof import('../../src/editor/sceneState')>(
            '/src/editor/sceneState.ts',
        )
        const [slideId] = history.state.value.store.slides.note.keys()
        return {
            edit: !!previewEdit.value,
            ghost: view.entities.creating.some(
                (entity) => entity.type === 'note' && entity.slideId === slideId,
            ),
            previewed: !!previewSlides.value,
        }
    })
    expect(pending).toEqual({ edit: true, ghost: true, previewed: false })
    expect(await chart()).toBe(before)
})

test('a previewed slide keeps its stacking with a note at the same beat', async ({ page }) => {
    // The slide's tail lies under a critical note at the same beat and lane, stored after it.
    await page.evaluate(() => {
        const { show, fixtures } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                isDynamicStages: false,
                slides: [
                    [
                        { ...base, beat: 2, left: -4, size: 2 },
                        { ...base, beat: 3, left: 0, size: 2, isAttached: true },
                        { ...base, beat: 4, left: 0, size: 2 },
                        { ...base, beat: 6, left: 2, size: 2 },
                    ],
                    [{ ...base, beat: 6, left: 2, size: 2, isCritical: true }],
                ],
            },
            3,
        )
    })
    await useTool(page, 'select')
    const start = await point(page, -3, 2)
    const target = await point(page, -1, 2)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(target.x, target.y, { steps: 6 })
    expect(await previewed(page)).toBeDefined()
    const drawn = await area(page, 1.5, 4.5, 5.7, 6.3)
    await page.mouse.up()
    expect((await area(page, 1.5, 4.5, 5.7, 6.3)).equals(drawn)).toBe(true)
})
