import { expect, test, type Page } from '@playwright/test'
import {
    installCanvasCounters,
    installEditorFixture,
    touchInput,
    type TouchInput,
} from './editorFixture'

test.use({ hasTouch: true })

let touch: TouchInput

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    touch = await touchInput(page)
})

/** A lone note at beat 2 under the pane's right edge, with the view on beat 2. */
const showNote = (page: Page) =>
    page.evaluate(async () => {
        const { fixtures, show, settings, nextTick } = window.editorTest
        const template = fixtures.interaction.slides.flat()[0]!
        show(
            {
                ...fixtures.interaction,
                slides: [[{ ...template, beat: 2, left: 6, size: 4, isAttached: false }]],
            },
            1.1,
        )
        settings.width = 20
        // A finger held still for half a second opens the context menu and ends the gesture,
        // which a loaded runner can leave between a gesture's events.
        settings.touchLongPressContextMenu = false
        await nextTick()
    })

const view = (page: Page) =>
    page.evaluate(() => {
        const { x, y, w, h, lane, time } = window.editorTest.view
        return { x, y, w, h, lane, time }
    })

const notes = (page: Page) =>
    page.evaluate(() =>
        window.editorTest.snapshot().notes.map(({ beat, left }) => ({ beat, left })),
    )

/** One finger from `x` pixels left of the pane's right edge at beat 2, moved by `dx` and `dy`. */
const swipe = async (page: Page, x: number, dx: number, dy: number) => {
    const pane = await view(page)
    const { y } = await page.evaluate(() => window.editorTest.point(8, 2))
    const from = { x: pane.x + pane.w - x, y }
    const steps = 6
    await touch('touchStart', [[from.x, from.y]])
    for (let step = 1; step <= steps; step++)
        await touch('touchMove', [[from.x + (dx * step) / steps, from.y + (dy * step) / steps]])
    await touch('touchEnd', [])
}

test('the zone is 32 pixels wide by default', async ({ page }) => {
    await showNote(page)
    await page.keyboard.press('a')
    const before = await notes(page)
    const start = await view(page)
    // Just inside: a scroll.
    await swipe(page, 28, 0, -60)
    await expect.poll(async () => (await view(page)).time).not.toBe(start.time)
    expect(await notes(page)).toEqual(before)
    // Just outside: the tool's drag.
    await swipe(page, 40, 0, -60)
    await expect.poll(() => notes(page)).not.toEqual(before)
})

test('a quick scroll moves the view vertically only, with or without inertia', async ({ page }) => {
    await showNote(page)
    for (const inertia of [false, true]) {
        await page.evaluate((inertia) => {
            window.editorTest.settings.touchScrollInertia = inertia
        }, inertia)
        const start = await view(page)
        await swipe(page, 20, -300, -80)
        await page.waitForTimeout(200)
        const end = await view(page)
        expect(end.lane).toBe(start.lane)
        expect(end.time).not.toBe(start.time)
    }
})

test('the zone is at most half the pane', async ({ page }) => {
    await showNote(page)
    await page.evaluate(() => {
        window.editorTest.settings.touchQuickScrollWidth = 200
    })
    const { w } = await view(page)
    expect(
        await page.evaluate(async (w) => {
            const { quickScrollWidth } = await window.editorTest.appImport<
                typeof import('../../src/editor/quickScroll')
            >('/src/editor/quickScroll.ts')
            return [quickScrollWidth(w), quickScrollWidth(300)]
        }, w),
    ).toEqual([200, 150])
})

test('the strip shows for On, hides for Off, and follows touch screens for Touch Screens Only', async ({
    page,
}) => {
    const strip = page.locator('.editor .editor-quick-scroll-zone')
    const set = (show: 'on' | 'off' | 'touch', touchScreen = false, width = 32) =>
        page.evaluate(
            async ({ show, touchScreen, width }) => {
                const { settings, appImport, nextTick } = window.editorTest
                const { hasTouchScreen } = await appImport<
                    typeof import('../../src/editor/quickScroll')
                >('/src/editor/quickScroll.ts')
                hasTouchScreen.value = touchScreen
                settings.touchQuickScrollShow = show
                settings.touchQuickScrollWidth = width
                await nextTick()
            },
            { show, touchScreen, width },
        )
    await set('on')
    await expect(strip).toHaveCount(1)
    const pane = await view(page)
    const box = (await strip.boundingBox())!
    expect(box.width).toBeCloseTo(32, 0)
    expect(box.x + box.width).toBeCloseTo(pane.x + pane.w, 0)
    expect(box.height).toBeCloseTo(pane.h, 0)
    await set('off')
    await expect(strip).toHaveCount(0)
    await set('touch')
    await expect(strip).toHaveCount(0)
    await set('touch', true)
    await expect(strip).toHaveCount(1)
    // No zone, no strip.
    await set('on', true, 0)
    await expect(strip).toHaveCount(0)
})

test('the strip sits over the chart, under the beat labels', async ({ page }) => {
    await page.evaluate(async () => {
        window.editorTest.settings.touchQuickScrollShow = 'on'
        await window.editorTest.nextTick()
    })
    const order = await page.evaluate(() => {
        const children = [...document.querySelector('.editor')!.children]
        const at = (selector: string) => children.findIndex((child) => child.matches(selector))
        return {
            overlay: at('.editor-overlay'),
            strip: at('.editor-quick-scroll-zone'),
            range: at('.editor-range-labels'),
            hover: at('.editor-hover-labels'),
        }
    })
    expect(order.strip).toBeGreaterThan(order.overlay)
    expect(order.strip).toBeLessThan(order.range)
    expect(order.strip).toBeLessThan(order.hover)
})
