import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

declare global {
    interface Window {
        stageMotionTest: { strokes: number; shifted: number }
    }
}

const frames = (page: Page, count: number) =>
    page.evaluate(
        (count) =>
            new Promise<void>((resolve) => {
                let left = count
                const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step))
                requestAnimationFrame(step)
            }),
        count,
    )

const seed = (page: Page, time: number) =>
    page.evaluate(async (time) => {
        const { fixtures, show, view, settings, appImport, nextTick } = window.editorTest
        const { clearNotification } = await appImport<
            typeof import('../../src/editor/notification')
        >('/src/editor/notification.ts')
        show(
            {
                ...fixtures.events,
                stageTransformEvents: fixtures.events.stageTransformEvents.map((event, i) => ({
                    ...event,
                    xTranslation: i % 2 ? 0.75 : -1.5,
                    eventEase: 'inOutSine',
                })),
            },
            time,
        )
        settings.showOtherObjects = false
        settings.showStageName = false
        settings.showGroupName = false
        for (const type of Object.keys(view.visibilities))
            view.visibilities[type as keyof typeof view.visibilities] = type === 'note'
        view.layout = 'composed'
        clearNotification()
        await document.fonts.ready
        await nextTick()
    }, time)

for (const dpr of [1, 1.25, 1.5]) {
    test.describe(`DPR ${dpr}`, () => {
        test.use({ deviceScaleFactor: dpr })

        test('moving frames reuse shifted stage pixels and the still frame matches a fresh draw', async ({
            page,
        }) => {
            await page.addInitScript(installCanvasCounters)
            await page.addInitScript(() => {
                window.stageMotionTest = { strokes: 0, shifted: 0 }
                const stroke = CanvasRenderingContext2D.prototype.stroke
                CanvasRenderingContext2D.prototype.stroke = function (path?: Path2D) {
                    if (!this.canvas.isConnected && this.strokeStyle === '#b4d6e8')
                        window.stageMotionTest.strokes++
                    return Reflect.apply(stroke, this, path ? [path] : [])
                }
                // Shifted copies take a source rectangle; exact ones copy whole.
                const drawImage = CanvasRenderingContext2D.prototype.drawImage
                CanvasRenderingContext2D.prototype.drawImage = function (...args: unknown[]) {
                    if (this.canvas.classList.contains('editor-chart') && args.length === 9)
                        window.stageMotionTest.shifted++
                    return Reflect.apply(drawImage, this, args)
                }
            })
            await page.goto('/')
            await expect(page.locator('canvas.editor-chart')).toBeVisible()
            await page.evaluate(installEditorFixture)
            await seed(page, 5)
            await frames(page, 3)
            const counters = () =>
                page.evaluate(() => ({
                    ...window.stageMotionTest,
                    frames: window.editorFrames.chart,
                }))

            // One scroll step redraws exactly, as before.
            const before = await counters()
            await page.evaluate(() => (window.editorTest.view.time += 0.0137))
            await frames(page, 3)
            const step = await counters()
            const perDraw = step.strokes - before.strokes
            expect(perDraw).toBeGreaterThan(0)
            expect(step.shifted).toBe(before.shifted)

            // Eased scrolling moves on every clock tick: frames shift one drawn window.
            const end = await page.evaluate(async () => {
                const { view, appImport } = window.editorTest
                const { scrollViewYBy } =
                    await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
                for (let i = 0; i < 6; i++) {
                    scrollViewYBy(-37, true)
                    for (let f = 0; f < 4; f++) await new Promise((r) => requestAnimationFrame(r))
                }
                while (view.scrollingY) await new Promise((r) => requestAnimationFrame(r))
                return view.time
            })
            await frames(page, 4)
            const after = await counters()
            const moved = after.frames - step.frames
            expect(after.shifted - step.shifted).toBeGreaterThan(moved / 2)
            // Far fewer exact redraws than frames, including the still frame's.
            expect(after.strokes - step.strokes).toBeLessThan((perDraw * moved) / 2)
            const settled = await page.locator('canvas.editor-chart').screenshot()

            // A fresh chart at the same time draws the same pixels.
            await seed(page, end)
            await frames(page, 4)
            const fresh = await page.locator('canvas.editor-chart').screenshot()
            expect(settled.equals(fresh)).toBe(true)
        })
    })
}
