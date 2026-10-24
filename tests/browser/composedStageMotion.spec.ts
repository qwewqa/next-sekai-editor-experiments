import { expect, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

declare global {
    interface Window {
        stageTest: {
            // Retained stage meshes built and drawn on the chart.
            built: number
            drawn: number
        }
        moving: boolean
    }
}

// Counts the chart's stage tile builds and draws, so tests wait on state rather than on time.
const installStageCounters = async () => {
    const { WebGLDrawContext } = await window.editorTest.appImport<
        typeof import('../../src/rendering/context')
    >('/src/rendering/context.ts')
    const counts: Window['stageTest'] = { built: 0, drawn: 0 }
    window.stageTest = counts
    const chart = (ctx: InstanceType<typeof WebGLDrawContext>) =>
        ctx.canvas instanceof HTMLCanvasElement && ctx.canvas.classList.contains('editor-chart')
    const { createStageMesh, drawStageMesh } = WebGLDrawContext.prototype
    WebGLDrawContext.prototype.createStageMesh = function (...args) {
        if (chart(this)) counts.built++
        return createStageMesh.apply(this, args)
    }
    WebGLDrawContext.prototype.drawStageMesh = function (...args) {
        if (chart(this)) counts.drawn++
        return drawStageMesh.apply(this, args)
    }
}

const counters = (page: Page) =>
    page.evaluate(() => ({ ...window.stageTest, frames: window.editorFrames.chart }))

// Moves the view by `step` seconds on app clock ticks, as eased scrolls and playback do,
// for `count` ticks or until `window.moving` is cleared. Ticks count as motion however
// far apart load spaces them. The clock runs while this needs it, as it does for them.
const moveOnTicks = (page: Page, step: number, count = Infinity) =>
    page.evaluate(
        async ({ step, count }) => {
            const { view, appImport } = window.editorTest
            const { keepClockWhile, time } =
                await appImport<typeof import('../../src/time')>('/src/time.ts')
            const vue = performance
                .getEntriesByType('resource')
                .find((entry) => new URL(entry.name).pathname.endsWith('/deps/vue.js'))!.name
            const { watch } = (await import(vue)) as typeof import('vue')
            window.moving = true
            const release = keepClockWhile(() => true)
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
                        release()
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

// The chart once the pointer has left and the view has settled.
const stillShot = async (page: Page, capture = chartShot) => {
    await page.mouse.move(8, 300)
    await frames(page, 4)
    return capture(page)
}

// The same view drawn from a new chart, so with new stage stores and caches.
const freshShot = async (page: Page, capture = chartShot) => {
    const place = await page.evaluate(() => {
        const { view } = window.editorTest
        return { time: view.time, lane: view.lane, cursorTime: view.cursorTime }
    })
    await seed(page, place.time)
    await page.evaluate((place) => Object.assign(window.editorTest.view, place), place)
    return stillShot(page, capture)
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

// The settled frame matches a fresh chart; a few pixels allow for rasteriser rounding.
const expectFresh = async (page: Page, settled: Buffer, capture = chartShot) => {
    // Left out as they were for the settled shot and are for the fresh one.
    const covered = await coveredAreas(page)
    const fresh = await freshShot(page, capture)
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
            for (let j = 0; j < x.height; j++) {
                for (let n = 0; n < x.width; n++) {
                    if (covered.some(({ l, r, t, b }) => l <= n && n < r && t <= j && j < b))
                        continue
                    const i = (j * x.width + n) * 4
                    for (let k = 0; k < 4; k++) {
                        if (Math.abs(x.data[i + k]! - y.data[i + k]!) > 24) {
                            pixels++
                            break
                        }
                    }
                }
            }
            return pixels
        },
        { a: settled.toString('base64'), b: fresh.toString('base64'), covered },
    )
    expect(difference).toBeLessThanOrEqual(4)
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

        test('scrolling builds only the stage tiles coming into view and settles on a fresh draw', async ({
            page,
        }) => {
            await page.addInitScript(installCanvasCounters)
            await page.goto('/')
            await expect(page.locator('canvas.editor-chart')).toBeVisible()
            await page.evaluate(installEditorFixture)
            await page.evaluate(installStageCounters)
            await seed(page, 5)
            await frames(page, 3)
            const before = await counters(page)
            expect(before.built).toBeGreaterThan(0)
            // A still redraw draws the same tiles and builds none.
            await page.evaluate(() => window.editorTest.view.cursorTime++)
            await frames(page, 3)
            const still = await counters(page)
            expect(still.built).toBe(before.built)
            expect(still.drawn).toBeGreaterThan(before.drawn)

            // Clock-driven motion, as in eased scrolling: about one tile a frame at most.
            await moveOnTicks(page, -0.075, 24)
            await frames(page, 4)
            const after = await counters(page)
            const moved = after.frames - still.frames
            expect(after.built - still.built).toBeLessThanOrEqual(moved)
            // Back over the same ground reuses every tile, building at most the next one past it.
            await moveOnTicks(page, 0.075, 24)
            await frames(page, 4)
            expect((await counters(page)).built - after.built).toBeLessThanOrEqual(1)
            await expectFresh(page, await stillShot(page))

            // Stages hidden, shown again and then scrolled out of view leave nothing behind.
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

// This fixed theme fixture has the same tiny atlas-edge rounding when comparing
// two fresh charts. Bound both its size and total displayed error; do not permit
// a broad per-channel tolerance or changes to flat interiors.
const displayedThemeDifference = (page: Page, a: Buffer, b: Buffer) =>
    page.evaluate(
        async ([a, b]) => {
            const load = async (png: string) =>
                createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob())
            const [first, second] = await Promise.all([load(a), load(b)])
            if (first.width !== second.width || first.height !== second.height)
                return {
                    max: Infinity,
                    changed: Infinity,
                    integrated: Infinity,
                    interior: Infinity,
                }
            const read = (image: ImageBitmap, background?: string) => {
                const context = new OffscreenCanvas(image.width, image.height).getContext('2d')!
                if (background) {
                    context.fillStyle = background
                    context.fillRect(0, 0, image.width, image.height)
                }
                context.drawImage(image, 0, 0)
                return context.getImageData(0, 0, image.width, image.height).data
            }
            const left = [read(first), read(first, '#000'), read(first, '#fff')]
            const right = [read(second), read(second, '#000'), read(second, '#fff')]
            let max = 0,
                changed = 0,
                integrated = 0,
                interior = 0
            const edge = (images: Uint8ClampedArray[], x: number, y: number, index: number) => {
                for (let dy = -1; dy <= 1; dy++)
                    for (let dx = -1; dx <= 1; dx++) {
                        if (
                            x + dx < 0 ||
                            x + dx >= first.width ||
                            y + dy < 0 ||
                            y + dy >= first.height
                        )
                            continue
                        const neighbor = ((y + dy) * first.width + x + dx) * 4
                        if (Math.abs(images[0]![neighbor + 3]! - images[0]![index + 3]!) > 3)
                            return true
                        for (const image of images.slice(1))
                            for (let c = 0; c < 3; c++)
                                if (Math.abs(image[neighbor + c]! - image[index + c]!) > 3)
                                    return true
                    }
                return false
            }
            for (let y = 0; y < first.height; y++)
                for (let x = 0; x < first.width; x++) {
                    const index = (y * first.width + x) * 4
                    const alpha = Math.abs(left[0]![index + 3]! - right[0]![index + 3]!)
                    let delta = alpha,
                        total = alpha
                    for (const background of [1, 2]) {
                        let sum = alpha
                        for (let c = 0; c < 3; c++) {
                            const difference = Math.abs(
                                left[background]![index + c]! - right[background]![index + c]!,
                            )
                            delta = Math.max(delta, difference)
                            sum += difference
                        }
                        total = Math.max(total, sum)
                    }
                    max = Math.max(max, delta)
                    integrated += total / 255
                    if (delta > 1) {
                        changed++
                        if (!edge(left, x, y, index) || !edge(right, x, y, index)) interior++
                    }
                }
            first.close()
            second.close()
            return { max, changed, integrated, interior }
        },
        [a.toString('base64'), b.toString('base64')] as const,
    )

// Applies `change` while clock-driven scrolling keeps moving the chart.
const scrollWhile = async (page: Page, change: () => Promise<unknown>) => {
    const frames = () => page.evaluate(() => window.editorFrames.chart)
    const moving = moveOnTicks(page, -0.05)
    // Awaited below; a failure here stops the scroll first.
    moving.catch(() => {})
    try {
        const before = await frames()
        await expect.poll(frames, { timeout: 15_000 }).toBeGreaterThan(before + 1)
        await change()
        // Moving frames follow the change before the scroll ends.
        const after = await frames()
        await expect.poll(frames, { timeout: 15_000 }).toBeGreaterThan(after + 1)
    } finally {
        await page.evaluate(() => (window.moving = false))
        await moving
    }
}

test.describe('changes during motion', () => {
    test.use({ deviceScaleFactor: 1.25 })

    test.beforeEach(async ({ page }) => {
        await page.addInitScript(installCanvasCounters)
        await page.goto('/')
        await expect(page.locator('canvas.editor-chart')).toBeVisible()
        await page.evaluate(installEditorFixture)
        await page.evaluate(installStageCounters)
        await seed(page, 5)
        await frames(page, 4)
    })

    test('a theme switch mid-scroll settles on a fresh frame in the new theme', async ({
        page,
    }, testInfo) => {
        // The chart canvas is transparent over the themed background and its names do not
        // change with the theme, so the theme shows in the page background only.
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
        const fresh = await pixels(page)
        const difference = await displayedThemeDifference(page, settled, fresh)
        if (
            difference.max > 3 ||
            difference.changed > 16 ||
            difference.integrated > 2 ||
            difference.interior
        ) {
            writeFileSync(testInfo.outputPath('settled-theme.png'), settled)
            writeFileSync(testInfo.outputPath('fresh-theme.png'), fresh)
            await testInfo.attach('settled-theme.png', { body: settled, contentType: 'image/png' })
            await testInfo.attach('fresh-theme.png', { body: fresh, contentType: 'image/png' })
        }
        expect(difference.max).toBeLessThanOrEqual(3)
        expect(difference.changed).toBeLessThanOrEqual(16)
        expect(difference.integrated).toBeLessThanOrEqual(2)
        expect(difference.interior).toBe(0)
        const background = () =>
            page.evaluate(() => getComputedStyle(document.body).backgroundColor)
        const light = await background()
        await page.evaluate(() => {
            window.editorTest.settings.theme = 'dark'
        })
        expect(await theme()).toBe('dark')
        expect(await background()).not.toBe(light)
    })

    test('a pixel ratio change mid-scroll settles on a fresh draw', async ({ page }) => {
        // Chromium's CDP override changes DPR without notifying resolution media
        // queries when the viewport size stays fixed. Exercise the original
        // resize plus DPR transition regardless of the suite's initial viewport.
        await page.setViewportSize({ width: 1440, height: 1000 })
        await frames(page, 4)
        const cdp = await page.context().newCDPSession(page)
        await scrollWhile(page, () =>
            cdp.send('Emulation.setDeviceMetricsOverride', {
                width: 1600,
                height: 1000,
                deviceScaleFactor: 1.5,
                mobile: false,
            }),
        )
        const resolution = () =>
            page.evaluate(() => {
                const canvas = document.querySelector<HTMLCanvasElement>('canvas.editor-chart')!
                const bounds = canvas.getBoundingClientRect()
                return {
                    viewport: [innerWidth, innerHeight],
                    dpr: devicePixelRatio,
                    actual: [canvas.width, canvas.height],
                    expected: [
                        Math.round(bounds.width * devicePixelRatio),
                        Math.round(bounds.height * devicePixelRatio),
                    ],
                }
            })
        await expect
            .poll(async () => {
                const value = await resolution()
                return value.actual.every((size, index) => size === value.expected[index])
            })
            .toBe(true)
        const before = await resolution()
        expect(before.viewport).toEqual([1600, 1000])
        expect(before.dpr).toBe(1.5)
        // Locator screenshots restore Playwright's configured viewport/DPR after
        // a CDP override. Read the actual canvas so both frames keep the new DPR.
        await expectFresh(page, await pixels(page), pixels)
        expect(await resolution()).toEqual(before)
    })

    test('hiding the app during playback settles on a fresh draw', async ({ page }) => {
        const command = (name: 'play' | 'stop') =>
            page.evaluate(async (name) => {
                const { commands } = await window.editorTest.appImport<
                    typeof import('../../src/editor/commands')
                >('/src/editor/commands/index.ts')
                await commands[name].execute()
            }, name)
        await command('play')
        // Hidden only once playback frames move the stage tiles.
        const drawn = await page.evaluate(() => window.stageTest.drawn)
        await expect
            .poll(() => page.evaluate(() => window.stageTest.drawn), { timeout: 15_000 })
            .toBeGreaterThan(drawn + 1)
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
