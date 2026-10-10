import { expect, test, type Page } from '@playwright/test'
import { gzipSync } from 'node:zlib'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

// A stage that moves past Basic's range, with Max Scroll X at 0.
const seed = (page: Page, layout: 'basic' | 'composed', travel = 3) =>
    page.evaluate(
        async ({ layout, travel }) => {
            const { fixtures, show, view, settings, nextTick } = window.editorTest
            const base = fixtures.interaction.slides[0]![0]!
            // The stage moves from lane 0 to 8 * travel over 8 beats; it and its notes leave Basic's range.
            show(
                {
                    ...fixtures.interaction,
                    isDynamicStages: true,
                    stageTransformEvents: [0, 8].map((beat) => ({
                        stageId: base.stageId,
                        beat,
                        rotation: 0,
                        xTranslation: beat * travel,
                        yTranslation: 0,
                        elevation: 0,
                        anchor: 'default' as const,
                        eventEase: 'linear' as const,
                    })),
                    stageMaskEvents: [
                        {
                            stageId: base.stageId,
                            beat: 0,
                            maskLeft: -2,
                            maskSize: 4,
                            isMaskNotes: false,
                            eventEase: 'linear',
                        },
                    ],
                    slides: [[{ ...base, beat: 4, left: -1, size: 2 }]],
                },
                2,
            )
            settings.width = 16
            settings.maxScrollX = 0
            view.layout = layout
            await nextTick()
        },
        { layout, travel },
    )

const scroll = (page: Page, layout: 'basic' | 'composed') =>
    seed(page, layout).then(() => scrolled(page))

const scrolled = (page: Page) =>
    page.evaluate(async () => {
        const { view, settings, appImport, nextTick } = window.editorTest
        const { scrollViewXBy, scrollViewYBy } =
            await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
        const lanes = (dx: number) => {
            for (let i = 0; i < 40; i++) scrollViewXBy(dx)
            return view.lane + 0
        }
        const right = lanes(100)
        // Vertical scrolling leaves the reach unchanged.
        scrollViewYBy(400)
        const stillRight = lanes(100)
        const left = lanes(-100)
        lanes(100)
        // Zooming out shrinks the reach below the view; it eases back instead of jumping.
        settings.width = 40
        const before = view.lane
        scrollViewXBy(1)
        const outward = view.lane - before + 0
        scrollViewXBy(-1)
        const inward = view.lane - before + 0
        settings.width = 16
        view.layout = 'basic'
        await nextTick()
        return { right, stillRight, left, outward, inward, afterBasic: view.lane + 0 }
    })

test('composed scrolls sideways to stages and notes moved past Max Scroll X', async ({ page }) => {
    const result = await scroll(page, 'composed')
    // The stage reaches 24 + 2 lanes at beat 8; the view's right edge stops there.
    expect(result.right).toBeCloseTo(26 - 8, 6)
    expect(result.stillRight).toBeCloseTo(26 - 8, 6)
    // The left reach stays Basic's, since the chart starts inside the view.
    expect(result.left).toBe(0)
    expect(result.outward).toBe(0)
    expect(result.inward).toBeLessThan(0)
    expect(result.inward).toBeGreaterThan(-1)
    // Back in Basic, the view returns to its own range.
    expect(result.afterBasic).toBe(0)
})

test('basic keeps Max Scroll X for the same chart', async ({ page }) => {
    expect(await scroll(page, 'basic')).toEqual({
        right: 0,
        stillRight: 0,
        left: 0,
        outward: 0,
        inward: 0,
        afterBasic: 0,
    })
})

test('vertical wheels leave the sideways reach uncomputed, smooth or not', async ({ page }) => {
    await page.evaluate(async () => {
        const { fixtures, show, view, settings, nextTick } = window.editorTest
        show(fixtures.events, 2)
        settings.maxScrollX = 0
        view.layout = 'composed'
        await nextTick()
    })
    const box = (await page.locator('canvas.editor-chart').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    // Counts the current layout's reach computations, as the first wheel after an edit makes.
    const calls = () =>
        page.evaluate(async () => {
            const { appImport } = window.editorTest
            const { getComposedLayout } = await appImport<
                typeof import('../../src/editor/composedView')
            >('/src/editor/composedView.ts')
            const layout = getComposedLayout()!
            let calls = 0
            const extent = layout.displayedExtent
            layout.displayedExtent = () => {
                calls++
                return extent()
            }
            ;(window as unknown as { extentCalls: () => number }).extentCalls = () => calls
        })
    for (const smooth of [false, true]) {
        await page.evaluate((smooth) => {
            window.editorTest.settings.mouseSmoothScrolling = smooth
            window.editorTest.view.lane = 0
        }, smooth)
        await calls()
        const time = await page.evaluate(() => window.editorTest.view.time)
        await page.mouse.wheel(0, 100)
        // Handled, and any eased scroll has come to rest.
        await expect
            .poll(() =>
                page.evaluate((time) => {
                    const { view } = window.editorTest
                    return view.time !== time && !view.scrollingY
                }, time),
            )
            .toBe(true)
        expect(
            await page.evaluate(() => ({
                calls: (window as unknown as { extentCalls: () => number }).extentCalls(),
                lane: window.editorTest.view.lane,
            })),
        ).toEqual({ calls: 0, lane: 0 })
        // A sideways wheel still reaches by it.
        await page.mouse.wheel(100, 0)
        await expect
            .poll(() =>
                page.evaluate(() =>
                    (window as unknown as { extentCalls: () => number }).extentCalls(),
                ),
            )
            .toBeGreaterThan(0)
    }
})

test('a lower Max Scroll X brings the view within the reach at once, in either layout', async ({
    page,
}) => {
    const lane = () => page.evaluate(() => window.editorTest.view.lane)
    const place = (lane: number, limit: number) =>
        page.evaluate(
            ({ lane, limit }) => {
                const { view, settings } = window.editorTest
                settings.maxScrollX = limit
                view.lane = lane
            },
            { lane, limit },
        )
    // Through the Settings dialog, as the user would.
    const setLimit = async (limit: number) => {
        await page.mouse.move(800, 500)
        await page.keyboard.press(',')
        const field = page.getByRole('spinbutton', { name: 'Max Scroll X (lanes)', exact: true })
        await field.fill(`${limit}`)
        await field.press('Enter')
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
    }

    await seed(page, 'basic')
    await place(8, 10)
    await setLimit(3)
    expect(await lane()).toBe(3)
    await place(-8, 10)
    await setLimit(3)
    expect(await lane()).toBe(-3)
    // Raising it leaves the view where it is.
    await setLimit(10)
    expect(await lane()).toBe(-3)

    // Composed keeps the stage's reach: its right edge stops at lane 26, as a sideways scroll does.
    await seed(page, 'composed')
    await place(25, 30)
    await setLimit(5)
    expect(await lane()).toBeCloseTo(26 - 8, 6)
    await place(-20, 30)
    await setLimit(5)
    expect(await lane()).toBe(-5)

    // An eased sideways scroll ends within the new limit.
    await seed(page, 'basic')
    await place(0, 10)
    await page.evaluate(async () => {
        const { view, settings, appImport } = window.editorTest
        const { scrollViewXBy } =
            await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
        scrollViewXBy(10_000, true)
        settings.maxScrollX = 4
        ;(window as unknown as { easing: boolean }).easing = !!view.scrollingX
    })
    expect(await page.evaluate(() => (window as unknown as { easing: boolean }).easing)).toBe(true)
    await expect.poll(() => page.evaluate(() => !window.editorTest.view.scrollingX)).toBe(true)
    expect(await lane()).toBe(4)
})

test('a chart opened in Composed starts within its own reach', async ({ page }) => {
    // A chart whose stage only travels to lane 8, so its reach ends at lane 10 - 8.
    await seed(page, 'composed', 1)
    const level = await page.evaluate(async () => {
        const { history, appImport } = window.editorTest
        const { serializeToLevelData } = await appImport<
            typeof import('../../src/levelData/serialize')
        >('/src/levelData/serialize.ts')
        const { store, groups, stages } = history.state.value
        return serializeToLevelData(1000, true, 0, store, groups, stages)
    })
    // Scrolled to the right edge of a chart that reaches further.
    await seed(page, 'composed')
    const right = await page.evaluate(async () => {
        const { view, appImport } = window.editorTest
        const { scrollViewXBy } =
            await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
        for (let i = 0; i < 40; i++) scrollViewXBy(100)
        // The file input path, as in browsers without the File System Access API.
        Object.defineProperty(window, 'showOpenFilePicker', {
            configurable: true,
            value: undefined,
        })
        return view.lane
    })
    expect(right).toBeCloseTo(26 - 8, 6)

    const opening = page.waitForEvent('filechooser')
    await page.keyboard.press('o')
    await (
        await opening
    ).setFiles({
        name: 'narrow',
        mimeType: 'application/octet-stream',
        buffer: gzipSync(JSON.stringify(level)),
    })
    await expect
        .poll(() => page.evaluate(() => window.editorTest.history.state.value.filename))
        .toBe('narrow')
    expect(await page.evaluate(() => window.editorTest.view.lane)).toBeCloseTo(10 - 8, 6)
})
