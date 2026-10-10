import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

declare global {
    interface Window {
        stageMotionTest: { strokes: number; shifted: number }
        windowTest: { windows: number; resizes: number; shifted: number }
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

// Draws the stages exactly again, on the same store: a new store can antialias stroke ends differently.
const redrawStages = (page: Page) =>
    page.evaluate(async () => {
        const { view, nextTick } = window.editorTest
        const division = view.laneDivision
        view.laneDivision = division === 1 ? 2 : 1
        await nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        view.laneDivision = division
        await nextTick()
    })

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
            const stopped = await page.evaluate(async () => {
                const { view, appImport } = window.editorTest
                const { scrollViewYBy } =
                    await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
                for (let i = 0; i < 6; i++) {
                    scrollViewYBy(-37, true)
                    for (let f = 0; f < 4; f++) await new Promise((r) => requestAnimationFrame(r))
                }
                while (view.scrollingY) await new Promise((r) => requestAnimationFrame(r))
                return window.stageMotionTest.strokes
            })
            // The still frame redraws the stages exactly once the view has held still a while.
            await expect
                .poll(() => page.evaluate(() => window.stageMotionTest.strokes))
                .toBeGreaterThan(stopped)
            await frames(page, 4)
            const after = await counters()
            const moved = after.frames - step.frames
            expect(after.shifted - step.shifted).toBeGreaterThan(moved / 2)
            // Far fewer exact redraws than frames, including the still frame's.
            expect(after.strokes - step.strokes).toBeLessThan((perDraw * moved) / 2)
            const settled = await page.locator('canvas.editor-chart').screenshot()

            // An exact redraw of the same view draws the same pixels.
            await redrawStages(page)
            await frames(page, 4)
            const exact = await page.locator('canvas.editor-chart').screenshot()
            expect(settled.equals(exact)).toBe(true)
        })
    })
}

// The chart canvas's own pixels once the pointer has left and activity has settled.
const pixels = async (page: Page) => {
    await page.mouse.move(8, 300)
    await page.waitForTimeout(800)
    await frames(page, 4)
    const url = await page
        .locator('canvas.editor-chart')
        .evaluate((element) => (element as HTMLCanvasElement).toDataURL())
    return Buffer.from(url.split(',')[1]!, 'base64')
}

// The same view with its stages drawn exactly.
const exactPixels = async (page: Page) => {
    await redrawStages(page)
    return pixels(page)
}

const scrollWhile = async (page: Page, change: () => Promise<unknown>) => {
    const scroll = (steps: number) =>
        page.evaluate(async (steps) => {
            const { appImport, view } = window.editorTest
            const { scrollViewYBy } =
                await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
            for (let i = 0; i < steps; i++) {
                scrollViewYBy(-37, true)
                for (let f = 0; f < 3; f++) await new Promise((r) => requestAnimationFrame(r))
            }
            while (view.scrollingY) await new Promise((r) => requestAnimationFrame(r))
        }, steps)
    const moving = scroll(8)
    await frames(page, 6)
    await change()
    await moving
}

test.describe('window sizing', () => {
    test.use({ deviceScaleFactor: 2 })

    test('motion faster than the window holds draws the view exactly; a reversal reuses the window', async ({
        page,
    }) => {
        await page.addInitScript(installCanvasCounters)
        await page.addInitScript(() => {
            const counts = { windows: 0, resizes: 0, shifted: 0 }
            window.windowTest = counts
            const chart = () => document.querySelector<HTMLCanvasElement>('canvas.editor-chart')
            const fillRect = CanvasRenderingContext2D.prototype.fillRect
            CanvasRenderingContext2D.prototype.fillRect = function (...args: number[]) {
                const target = chart()
                if (
                    target &&
                    !this.canvas.isConnected &&
                    this.globalCompositeOperation === 'copy' &&
                    args[2]! * args[3]! > target.width * target.height
                )
                    counts.windows++
                return Reflect.apply(fillRect, this, args)
            }
            for (const name of ['width', 'height'] as const) {
                const property = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name)!
                Object.defineProperty(HTMLCanvasElement.prototype, name, {
                    ...property,
                    set(this: HTMLCanvasElement, value: number) {
                        const target = chart()
                        if (target && !this.isConnected && value > target[name]) counts.resizes++
                        property.set!.call(this, value)
                    },
                })
            }
            const drawImage = CanvasRenderingContext2D.prototype.drawImage
            CanvasRenderingContext2D.prototype.drawImage = function (...args: unknown[]) {
                if (this.canvas.classList.contains('editor-chart') && args.length === 9)
                    counts.shifted++
                return Reflect.apply(drawImage, this, args)
            }
        })
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await seed(page, 5)
        await frames(page, 4)
        const move = (step: number, count: number) =>
            page.evaluate(
                async ({ step, count }) => {
                    for (let i = 0; i < count; i++) {
                        window.editorTest.view.time += step
                        await new Promise((r) => requestAnimationFrame(r))
                    }
                    await new Promise((r) => requestAnimationFrame(r))
                    return {
                        ...window.windowTest,
                    }
                },
                { step, count },
            )
        // Each frame moves most of a view: no window can hold two frames of it.
        expect(await move(0.6, 20)).toEqual({ windows: 0, resizes: 0, shifted: 0 })
        await page.waitForTimeout(300)
        // Slow motion draws one window and shifts it.
        const slow = await move(0.01, 20)
        expect(slow.windows).toBe(1)
        expect(slow.shifted).toBeGreaterThan(0)
        // Turning back draws it the other way, on the same canvas.
        const back = await move(-0.05, 30)
        expect(back.windows).toBeGreaterThan(slow.windows)
        expect(back.resizes).toBe(slow.resizes)
    })
})

test.describe('changes during motion', () => {
    test.use({ deviceScaleFactor: 1.25 })

    test.beforeEach(async ({ page }) => {
        await page.addInitScript(installCanvasCounters)
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await seed(page, 5)
        await frames(page, 4)
    })

    test('a theme switch mid-scroll settles on a fresh frame in the new theme', async ({
        page,
    }) => {
        // Selected names drawn against the chart background follow the theme.
        const seedNames = (time: number) =>
            page.evaluate(async (time) => {
                const { fixtures, show, view, settings, history, store, appImport, nextTick } =
                    window.editorTest
                const { clearNotification } = await appImport<
                    typeof import('../../src/editor/notification')
                >('/src/editor/notification.ts')
                show(fixtures.connectors, time)
                settings.showStageName = true
                settings.showGroupName = true
                settings.nameContrast = true
                for (const type of Object.keys(view.visibilities))
                    view.visibilities[type as keyof typeof view.visibilities] = true
                view.layout = 'composed'
                history.replaceState({
                    ...history.state.value,
                    selectedEntities: [...store.getAllEntities()].filter(
                        (entity) => entity.type === 'note' || entity.type === 'connector',
                    ),
                })
                clearNotification()
                await document.fonts.ready
                await nextTick()
            }, time)
        const theme = () => page.evaluate(() => document.documentElement.dataset.theme)
        await page.evaluate(() => {
            window.editorTest.settings.theme = 'dark'
        })
        await seedNames(5)
        await frames(page, 4)
        expect(await theme()).toBe('dark')
        await scrollWhile(page, () =>
            page.evaluate(() => {
                window.editorTest.settings.theme = 'light'
            }),
        )
        expect(await theme()).toBe('light')
        const settled = await pixels(page)

        // The same view drawn from scratch in light.
        const place = await page.evaluate(() => {
            const { view } = window.editorTest
            return { time: view.time, lane: view.lane, cursorTime: view.cursorTime }
        })
        await seedNames(place.time)
        await page.evaluate((place) => Object.assign(window.editorTest.view, place), place)
        expect(settled.equals(await pixels(page))).toBe(true)
        await page.evaluate(() => {
            window.editorTest.settings.theme = 'dark'
        })
        expect(settled.equals(await pixels(page))).toBe(false)
    })

    test('a pixel ratio change mid-scroll redraws exactly', async ({ page }) => {
        const cdp = await page.context().newCDPSession(page)
        await scrollWhile(page, () =>
            cdp.send('Emulation.setDeviceMetricsOverride', {
                width: 1600,
                height: 1000,
                deviceScaleFactor: 1.5,
                mobile: false,
            }),
        )
        expect(await page.evaluate(() => devicePixelRatio)).toBe(1.5)
        expect((await pixels(page)).equals(await exactPixels(page))).toBe(true)
    })

    test('hiding the app during playback leaves no shifted stage pixels', async ({ page }) => {
        const command = (name: 'play' | 'stop') =>
            page.evaluate(async (name) => {
                const { commands } = await window.editorTest.appImport<
                    typeof import('../../src/editor/commands')
                >('/src/editor/commands/index.ts')
                await commands[name].execute()
            }, name)
        await command('play')
        await frames(page, 20)
        await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        await page.waitForTimeout(300)
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await frames(page, 20)
        // Stopped while inactive, right after moving frames.
        await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        await command('stop')
        await page.waitForTimeout(300)
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        expect((await pixels(page)).equals(await exactPixels(page))).toBe(true)
    })
})
