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

/** Two lone notes at beat 2, centred on lanes -3 and 3. */
const showNotes = (page: Page) =>
    page.evaluate(async () => {
        const { fixtures, show, nextTick } = window.editorTest
        const template = fixtures.interaction.slides.flat()[0]!
        show(
            {
                ...fixtures.interaction,
                slides: [-4, 2].map((left) => [
                    { ...template, beat: 2, left, size: 2, isAttached: false },
                ]),
            },
            1.1,
        )
        await nextTick()
    })

const point = (page: Page, lane: number, beat: number) =>
    page.evaluate(([lane, beat]) => window.editorTest.point(lane, beat), [lane, beat] as const)

const paneBounds = (page: Page) =>
    page.evaluate(() => {
        const { x, y, w, h } = window.editorTest.view
        return { x, y, w, h }
    })

/** Presses, moves in steps and, unless held, releases one mouse button or finger. */
const press = async (
    page: Page,
    input: 'mouse' | 'touch',
    from: { x: number; y: number },
    to: { x: number; y: number },
    release = true,
) => {
    const steps = 6
    const at = (step: number): [number, number] => [
        from.x + ((to.x - from.x) * step) / steps,
        from.y + ((to.y - from.y) * step) / steps,
    ]
    if (input === 'mouse') {
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move(to.x, to.y, { steps })
        if (release) await page.mouse.up()
    } else {
        await touch('touchStart', [at(0)])
        for (let step = 1; step <= steps; step++) await touch('touchMove', [at(step)])
        if (release) await touch('touchEnd', [])
    }
}

const release = (page: Page, input: 'mouse' | 'touch') =>
    input === 'mouse' ? page.mouse.up() : touch('touchEnd', [])

test('a touch drag held past the pane edge pans as fast as a mouse drag', async ({ page }) => {
    const rate = async (input: 'mouse' | 'touch') => {
        await showNotes(page)
        await page.evaluate(() => {
            const { settings, view } = window.editorTest
            settings.dragToPanX = false
            settings.dragToPanY = true
            view.scrollingY = undefined
            view.time = 0
        })
        await page.keyboard.press('a')
        const from = await point(page, -3, 2)
        const pane = await paneBounds(page)
        await press(page, input, from, { x: from.x, y: pane.y - 200 }, false)
        // Past any reveal the drag's start eases in.
        await page.waitForTimeout(400)
        const sample = () =>
            page.evaluate(
                () =>
                    new Promise<{ time: number; now: number }>((resolve) => {
                        requestAnimationFrame((now) => {
                            // Observe motion after this frame's reactive updates, on the same clock.
                            void window.editorTest
                                .nextTick()
                                .then(() => resolve({ time: window.editorTest.view.time, now }))
                        })
                    }),
            )
        const before = await sample()
        await page.waitForTimeout(500)
        const after = await sample()
        await release(page, input)
        return (after.time - before.time) / (after.now - before.now)
    }
    const mouse = await rate('mouse')
    expect(mouse).toBeGreaterThan(0)
    const ratio = (await rate('touch')) / mouse
    expect(ratio).toBeGreaterThan(0.8)
    expect(ratio).toBeLessThan(1.25)
})
