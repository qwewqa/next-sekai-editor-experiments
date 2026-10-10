import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

declare global {
    interface Window {
        stageTest: {
            strokes: number
            shifted: number
            windows: number
            resizes: number
            // The chart's last stage copy: shifted from the motion window, or the exact surface.
            last?: 'shift' | 'exact'
            strokesAtShift: number
            shiftedAt: number
            motionWindow?: HTMLCanvasElement
            releasedAt?: number
        }
        moving: boolean
    }
}

// Counts stage draws and copies, so tests wait on state rather than on time.
const installStageCounters = () => {
    const counts: Window['stageTest'] = {
        strokes: 0,
        shifted: 0,
        windows: 0,
        resizes: 0,
        strokesAtShift: 0,
        shiftedAt: 0,
    }
    window.stageTest = counts
    const chart = () => document.querySelector<HTMLCanvasElement>('canvas.editor-chart')
    const stroke = CanvasRenderingContext2D.prototype.stroke
    CanvasRenderingContext2D.prototype.stroke = function (path?: Path2D) {
        if (!this.canvas.isConnected && this.strokeStyle === '#b4d6e8') counts.strokes++
        return Reflect.apply(stroke, this, path ? [path] : [])
    }
    const fillRect = CanvasRenderingContext2D.prototype.fillRect
    CanvasRenderingContext2D.prototype.fillRect = function (...args: number[]) {
        const target = chart()
        if (
            target &&
            !this.canvas.isConnected &&
            this.globalCompositeOperation === 'copy' &&
            args[2]! * args[3]! > target.width * target.height
        ) {
            counts.windows++
            counts.motionWindow = this.canvas
        }
        return Reflect.apply(fillRect, this, args)
    }
    for (const name of ['width', 'height'] as const) {
        const property = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name)!
        Object.defineProperty(HTMLCanvasElement.prototype, name, {
            ...property,
            set(this: HTMLCanvasElement, value: number) {
                const target = chart()
                if (target && !this.isConnected && value > target[name]) counts.resizes++
                if (this === counts.motionWindow && value === 0)
                    counts.releasedAt ??= performance.now()
                property.set!.call(this, value)
            },
        })
    }
    // Shifted copies take a source rectangle; exact ones copy the same-sized surface whole.
    const drawImage = CanvasRenderingContext2D.prototype.drawImage
    CanvasRenderingContext2D.prototype.drawImage = function (...args: unknown[]) {
        const target = this.canvas
        const [source] = args
        if (target.classList.contains('editor-chart')) {
            if (args.length === 9) {
                counts.shifted++
                counts.last = 'shift'
                counts.strokesAtShift = counts.strokes
                counts.shiftedAt = performance.now()
            } else if (
                args.length === 3 &&
                source instanceof HTMLCanvasElement &&
                !source.isConnected &&
                source.width === target.width &&
                source.height === target.height
            )
                counts.last = 'exact'
        }
        return Reflect.apply(drawImage, this, args)
    }
}

// Longer than the gap that ends one motion (stageSurface SUSTAINED_MS).
const SPACED_MS = 200

const counters = (page: Page) =>
    page.evaluate(() => {
        const { strokes, shifted, windows, resizes, last, strokesAtShift, shiftedAt, releasedAt } =
            window.stageTest
        return {
            ...{ strokes, shifted, windows, resizes, last, strokesAtShift, shiftedAt, releasedAt },
            frames: window.editorFrames.chart,
        }
    })

// Waits, however long load makes it, until the chart shows exact stage pixels again.
const stillStages = (page: Page) =>
    expect
        .poll(() => page.evaluate(() => window.stageTest.last !== 'shift'), { timeout: 15_000 })
        .toBe(true)

// Moves the view by `step` seconds on app clock ticks, as eased scrolls and playback do,
// for `count` ticks or until `window.moving` is cleared. Ticks count as motion however
// far apart load spaces them.
const moveOnTicks = (page: Page, step: number, count = Infinity) =>
    page.evaluate(
        async ({ step, count }) => {
            const { view, appImport } = window.editorTest
            const { time } = await appImport<typeof import('../../src/time')>('/src/time.ts')
            const { watch } = await appImport<typeof import('vue')>(
                '/node_modules/.vite/deps/vue.js',
            )
            window.moving = true
            await new Promise<void>((resolve) => {
                let left = count
                const stop = watch(
                    time,
                    () => {
                        if (window.moving && left-- > 0) {
                            view.time += step
                            return
                        }
                        stop()
                        resolve()
                    },
                    { flush: 'sync' },
                )
            })
            // The last tick's frame draws, then the next one.
            await new Promise((r) => requestAnimationFrame(r))
            await new Promise((r) => requestAnimationFrame(r))
        },
        { step, count },
    )

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

// Unmasked: a mask repaints the page, which can hide stale stage pixels.
const chartShot = (page: Page) => page.locator('canvas.editor-chart').screenshot()

// The chart once the pointer has left and the stages are drawn exactly again.
const stillShot = async (page: Page) => {
    await page.mouse.move(8, 300)
    await stillStages(page)
    await frames(page, 4)
    return chartShot(page)
}

// The same view drawn from a new chart, so with new stage stores and caches.
const freshShot = async (page: Page) => {
    const place = await page.evaluate(() => {
        const { view } = window.editorTest
        return { time: view.time, lane: view.lane, cursorTime: view.cursorTime }
    })
    await seed(page, place.time)
    await page.evaluate((place) => Object.assign(window.editorTest.view, place), place)
    return stillShot(page)
}

// Areas of the toolbar and notifications over the chart, which can be mid-transition.
const coveredAreas = (page: Page) =>
    page.evaluate(() => {
        const chart = document.querySelector('canvas.editor-chart')!.getBoundingClientRect()
        const covers = document.querySelectorAll('[data-editor-toolbar] > *, .notification')
        return [...covers].map((element) => {
            const box = element.getBoundingClientRect()
            const edge = (value: number, origin: number, margin: number) =>
                (value - origin + margin) * devicePixelRatio
            return {
                l: edge(box.left, chart.left, -8),
                r: edge(box.right, chart.left, 8),
                t: edge(box.top, chart.top, -8),
                b: edge(box.bottom, chart.top, 8),
            }
        })
    })

// A new store can antialias stroke ends a little differently; stale pixels differ by far more.
const expectFresh = async (page: Page, settled: Buffer) => {
    // Left out as they were for the settled shot and are for the fresh one.
    const covered = await coveredAreas(page)
    const fresh = await freshShot(page)
    covered.push(...(await coveredAreas(page)))
    const difference = await page.evaluate(
        async ({ a, b, covered }) => {
            const read = async (png: string) => {
                const bitmap = await createImageBitmap(
                    await (await fetch(`data:image/png;base64,${png}`)).blob(),
                )
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
                const ctx = canvas.getContext('2d')!
                ctx.drawImage(bitmap, 0, 0)
                return ctx.getImageData(0, 0, bitmap.width, bitmap.height)
            }
            const [x, y] = await Promise.all([read(a), read(b)])
            let pixels = 0
            let row = 0
            for (let j = 0; j < x.height; j++) {
                let count = 0
                for (let n = 0; n < x.width; n++) {
                    if (covered.some(({ l, r, t, b }) => l <= n && n < r && t <= j && j < b))
                        continue
                    const i = (j * x.width + n) * 4
                    for (let k = 0; k < 4; k++) {
                        if (Math.abs(x.data[i + k]! - y.data[i + k]!) > 24) {
                            count++
                            break
                        }
                    }
                }
                pixels += count
                row = Math.max(row, count)
            }
            return { pixels, row }
        },
        { a: settled.toString('base64'), b: fresh.toString('base64'), covered },
    )
    expect(difference.pixels).toBeLessThanOrEqual(64)
    expect(difference.row).toBeLessThanOrEqual(16)
}

// Hides or shows every stage.
const hideStages = (page: Page, hidden: boolean) =>
    page.evaluate(async (hidden) => {
        const { view, history, nextTick } = window.editorTest
        view.stageVisibility = new Map(
            hidden ? [...history.state.value.stages.keys()].map((id) => [id, 'hidden']) : [],
        )
        await nextTick()
    }, hidden)

for (const dpr of [1, 1.25, 1.5]) {
    test.describe(`DPR ${dpr}`, () => {
        test.use({ deviceScaleFactor: dpr })

        test('moving frames reuse shifted stage pixels and the still frame matches a fresh draw', async ({
            page,
        }) => {
            await page.addInitScript(installCanvasCounters)
            await page.addInitScript(installStageCounters)
            await page.goto('/')
            await expect(page.locator('canvas.editor-chart')).toBeVisible()
            await page.evaluate(installEditorFixture)
            await seed(page, 5)
            await frames(page, 3)

            // One scroll step redraws exactly, as before, and so does one spaced past a motion's gap.
            const before = await counters(page)
            await page.evaluate(() => (window.editorTest.view.time += 0.0137))
            await frames(page, 3)
            const first = await counters(page)
            const perDraw = first.strokes - before.strokes
            expect(perDraw).toBeGreaterThan(0)
            await page.waitForTimeout(SPACED_MS)
            await page.evaluate(() => (window.editorTest.view.time += 0.0137))
            await frames(page, 3)
            const step = await counters(page)
            expect(step.strokes - first.strokes).toBe(perDraw)
            expect(step.shifted).toBe(before.shifted)

            // Clock-driven motion, as in eased scrolling, moves on every tick: frames shift one drawn window.
            await moveOnTicks(page, -0.075, 24)
            // The still frame redraws the stages exactly once the view has held still a while.
            await stillStages(page)
            await frames(page, 4)
            const after = await counters(page)
            expect(after.last).toBe('exact')
            expect(after.strokes).toBeGreaterThan(after.strokesAtShift)
            const moved = after.frames - step.frames
            expect(after.shifted - step.shifted).toBeGreaterThan(moved / 2)
            // Far fewer exact redraws than frames, including the still frame's.
            expect(after.strokes - step.strokes).toBeLessThan((perDraw * moved) / 2)
            await expectFresh(page, await stillShot(page))

            // Stages hidden, shown again and then scrolled out of view leave nothing on the reused stores.
            await hideStages(page, true)
            await frames(page, 3)
            await hideStages(page, false)
            await frames(page, 3)
            await page.evaluate(() => (window.editorTest.view.lane += 2000))
            await expectFresh(page, await stillShot(page))
        })
    })
}

// The chart canvas's own pixels once the pointer has left and activity has settled.
const pixels = async (page: Page) => {
    await page.mouse.move(8, 300)
    await stillStages(page)
    // Hover highlights return once the view is no longer recently active.
    await expect
        .poll(
            () =>
                page.evaluate(async () => {
                    const { isViewRecentlyActive } =
                        await window.editorTest.appImport<typeof import('../../src/editor/view')>(
                            '/src/editor/view.ts',
                        )
                    return isViewRecentlyActive.value
                }),
            { timeout: 15_000 },
        )
        .toBe(false)
    await frames(page, 4)
    const url = await page
        .locator('canvas.editor-chart')
        .evaluate((element) => (element as HTMLCanvasElement).toDataURL())
    return Buffer.from(url.split(',')[1]!, 'base64')
}

// Applies `change` while clock-driven scrolling keeps shifting stage pixels.
const scrollWhile = async (page: Page, change: () => Promise<unknown>) => {
    const moving = moveOnTicks(page, -0.05)
    // Awaited below; a failure here stops the scroll first.
    moving.catch(() => {})
    try {
        await expect
            .poll(() => page.evaluate(() => window.stageTest.last), { timeout: 15_000 })
            .toBe('shift')
        await change()
        // Moving frames follow the change before the scroll ends.
        const shifted = await page.evaluate(() => window.stageTest.shifted)
        await expect
            .poll(() => page.evaluate(() => window.stageTest.shifted), { timeout: 15_000 })
            .toBeGreaterThan(shifted)
    } finally {
        await page.evaluate(() => (window.moving = false))
        await moving
    }
}

test.describe('window sizing', () => {
    test.use({ deviceScaleFactor: 2 })

    test('motion faster than the window holds draws the view exactly; a reversal reuses the window', async ({
        page,
    }) => {
        await page.addInitScript(installCanvasCounters)
        await page.addInitScript(installStageCounters)
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await seed(page, 5)
        await frames(page, 4)
        const move = async (step: number, count: number) => {
            await moveOnTicks(page, step, count)
            const { windows, resizes, shifted } = await counters(page)
            return { windows, resizes, shifted }
        }
        // Each frame moves most of a view: no window can hold two frames of it.
        expect(await move(0.6, 20)).toEqual({ windows: 0, resizes: 0, shifted: 0 })
        // Slow motion draws one window and shifts it.
        const slow = await move(0.01, 20)
        expect(slow.windows).toBe(1)
        expect(slow.shifted).toBeGreaterThan(0)
        // Turning back draws it the other way, on the same canvas.
        const back = await move(-0.05, 30)
        expect(back.windows).toBeGreaterThan(slow.windows)
        expect(back.resizes).toBe(slow.resizes)
    })

    test('the window is released a few seconds after the view comes to rest', async ({ page }) => {
        await page.addInitScript(installCanvasCounters)
        await page.addInitScript(installStageCounters)
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await seed(page, 5)
        await frames(page, 4)
        const size = () =>
            page.evaluate(() => {
                const canvas = window.stageTest.motionWindow
                return canvas ? canvas.width * canvas.height : undefined
            })
        await moveOnTicks(page, 0.01, 20)
        const moved = await counters(page)
        expect(moved.windows).toBe(1)
        expect(moved.shifted).toBeGreaterThan(0)
        await expect.poll(size, { timeout: 15_000 }).toBe(0)
        // Kept through a pause, for the next motion: released seconds after the last moving frame.
        const { shiftedAt, releasedAt } = await counters(page)
        expect(releasedAt! - shiftedAt).toBeGreaterThan(2000)
    })
})

test.describe('changes during motion', () => {
    test.use({ deviceScaleFactor: 1.25 })

    test.beforeEach(async ({ page }) => {
        await page.addInitScript(installCanvasCounters)
        await page.addInitScript(installStageCounters)
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
        await expectFresh(page, await stillShot(page))
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
        // Hidden only once playback frames shift stage pixels.
        await expect
            .poll(() => page.evaluate(() => window.stageTest.shifted), { timeout: 15_000 })
            .toBeGreaterThan(1)
        await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        await page.waitForTimeout(300)
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await frames(page, 20)
        // Stopped while inactive, right after moving frames.
        await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        await command('stop')
        await page.waitForTimeout(300)
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await expectFresh(page, await stillShot(page))
    })
})
