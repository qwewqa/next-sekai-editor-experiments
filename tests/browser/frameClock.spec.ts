import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture, touchInput } from './editorFixture'

// Run the real clock and view watchers, controlling only the browser clock inputs.
const exerciseClock = async (scenario: 'motion' | 'activation') => {
    const { appImport, nextTick, settings, view } = window.editorTest
    const { time } = await appImport<typeof import('../../src/time')>('/src/time.ts')
    const { scrollViewYBy } =
        await appImport<typeof import('../../src/editor/view')>('/src/editor/view.ts')
    const { editorNavigation } = await appImport<typeof import('../../src/editor/navigation')>(
        '/src/editor/navigation.ts',
    )
    const { isFrameOpen } = await appImport<typeof import('../../src/frame')>('/src/frame.ts')
    const raf = window.requestAnimationFrame
    const cancel = window.cancelAnimationFrame
    const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now')
    const focusDescriptor = Object.getOwnPropertyDescriptor(document, 'hasFocus')
    const navigation = editorNavigation.value
    const pps = settings.pps
    const smooth = settings.mouseSmoothScrolling
    const queue = new Map<number, FrameRequestCallback>()
    let nextId = 1_000_000
    const start = Math.ceil(time.value.now * 1000) + 1000
    let wall = start
    const snapshot = () => ({
        now: time.value.now,
        delta: time.value.delta,
        position: view.time,
        velocity: view.scrollingY?.type === 'inertia' ? view.scrollingY.value : undefined,
        moving: !!view.scrollingY,
    })
    const runs: ReturnType<typeof snapshot>[][] = []
    const activations: ReturnType<typeof snapshot>[] = []
    const step = async (timestamp: number, wallTime: number) => {
        wall = wallTime
        const callbacks = [...queue.values()]
        queue.clear()
        for (const callback of callbacks) {
            callback(timestamp)
            // Also drain openFrame's finally callback before supplying another frame.
            await nextTick()
            await Promise.resolve()
        }
        if (isFrameOpen()) throw new Error('Clock frame did not close')
        return snapshot()
    }
    const activate = async (at: number) => {
        window.dispatchEvent(new Event('blur'))
        await nextTick()
        view.scrollingX = view.scrollingY = view.scrollingPane = undefined
        view.time = 5
        wall = at
        window.dispatchEvent(new Event('focus'))
        await nextTick()
        return snapshot()
    }

    window.dispatchEvent(new Event('blur'))
    await nextTick()
    try {
        window.requestAnimationFrame = (callback) => {
            const id = nextId++
            queue.set(id, callback)
            return id
        }
        window.cancelAnimationFrame = (id) => {
            queue.delete(id)
        }
        Object.defineProperty(performance, 'now', { configurable: true, value: () => wall })
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
        editorNavigation.value = undefined
        settings.pps = 120
        settings.mouseSmoothScrolling = true

        if (scenario === 'motion') {
            const timestamps = [0, 25, 50, 75, 125, 175, 250, 275]
            let base = start
            for (const motion of ['ease', 'inertia'] as const) {
                for (const delays of [timestamps.map(() => 0), [0, 9, 2, 8, 1, 7, 3, 9]]) {
                    await activate(base)
                    if (motion === 'ease') scrollViewYBy(120, true)
                    else view.scrollingY = { type: 'inertia', value: 160 }
                    const samples: ReturnType<typeof snapshot>[] = []
                    for (const [i, offset] of timestamps.entries()) {
                        samples.push(await step(base + offset, base + offset + delays[i]!))
                    }
                    runs.push(samples)
                    base += 1000
                }
            }
        } else {
            activations.push(await activate(start))
            view.scrollingY = { type: 'inertia', value: 160 }
            for (const [timestamp, wallTime] of [
                [-10, 5],
                [0, 8],
                [20, 24],
                [20, 26],
                [10, 28],
                [30, 35],
            ] as const) {
                activations.push(await step(start + timestamp, start + wallTime))
            }
            window.dispatchEvent(new Event('blur'))
            await nextTick()
            // Pending non-clock callbacks cannot advance an inactive app's motion.
            activations.push(await step(start + 49_990, start + 50_000))
            window.dispatchEvent(new Event('focus'))
            await nextTick()
            activations.push(snapshot())
            activations.push(await step(start + 49_995, start + 50_005))
            activations.push(await step(start + 50_010, start + 50_015))
            // Privacy rounding can put a focus reset's wall clock behind the last RAF.
            window.dispatchEvent(new Event('blur'))
            await nextTick()
            wall = start + 50_005
            window.dispatchEvent(new Event('focus'))
            await nextTick()
            activations.push(snapshot())
            activations.push(await step(start + 50_008, start + 50_009))
        }
        return { runs, activations, base: start }
    } finally {
        window.dispatchEvent(new Event('blur'))
        await nextTick()
        view.scrollingX = view.scrollingY = view.scrollingPane = undefined
        queue.clear()
        window.requestAnimationFrame = raf
        window.cancelAnimationFrame = cancel
        if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor)
        else Reflect.deleteProperty(performance, 'now')
        if (focusDescriptor) Object.defineProperty(document, 'hasFocus', focusDescriptor)
        else Reflect.deleteProperty(document, 'hasFocus')
        editorNavigation.value = navigation
        settings.pps = pps
        settings.mouseSmoothScrolling = smooth
        window.dispatchEvent(new Event('focus'))
        await nextTick()
    }
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

test('editor easing and inertia follow frame timestamps despite callback delay', async ({
    page,
}) => {
    const { runs } = await page.evaluate(exerciseClock, 'motion' as const)
    for (const [plain, delayed] of [
        [runs[0]!, runs[1]!],
        [runs[2]!, runs[3]!],
    ] as const) {
        for (const [i, sample] of plain.entries()) {
            expect(delayed[i]!.position).toBeCloseTo(sample.position, 10)
            expect(delayed[i]!.moving).toBe(sample.moving)
            if (sample.velocity !== undefined)
                expect(delayed[i]!.velocity).toBeCloseTo(sample.velocity, 10)
        }
    }
    const offsets = [0, 25, 50, 75, 125, 175, 250, 275]
    for (const [i, offset] of offsets.entries()) {
        const elapsed = offset / 1000
        expect(runs[0]![i]!.position).toBeCloseTo(6 - (1 - Math.min(elapsed / 0.25, 1)) ** 2, 10)
        const movingTime = Math.min(elapsed, 0.2)
        expect(runs[2]![i]!.position).toBeCloseTo(
            5 + (160 * movingTime - 400 * movingTime ** 2) / 120,
            10,
        )
    }
    expect(runs[0]!.at(-1)!.moving).toBe(false)
    expect(runs[2]!.at(-1)!.moving).toBe(false)
})

test('activation and repeated or older frames never reverse or jump editor motion', async ({
    page,
}) => {
    const { activations: samples, base } = await page.evaluate(exerciseClock, 'activation' as const)
    expect(samples[0]).toMatchObject({ now: base / 1000, delta: 0, position: 5 })
    for (const sample of samples) expect(sample.delta).toBeGreaterThanOrEqual(0)
    for (const i of [1, 2]) {
        expect(samples[i]).toMatchObject({ now: base / 1000, delta: 0, position: 5, velocity: 160 })
    }
    for (const i of [4, 5]) {
        expect(samples[i]).toEqual({ ...samples[3], delta: 0 })
    }
    expect(samples[7]).toEqual(samples[6])
    expect(samples[8]).toEqual({ ...samples[7], now: (base + 50_000) / 1000, delta: 0 })
    expect(samples[9]).toEqual(samples[8])
    expect(samples[10]!.delta).toBeCloseTo(0.01, 10)
    expect(samples[10]!.position - samples[9]!.position).toBeCloseTo(
        (samples[9]!.velocity! * 0.01 - 400 * 0.01 ** 2) / 120,
        10,
    )
    expect(samples[11]).toEqual({ ...samples[10], delta: 0 })
    expect(samples[12]).toEqual(samples[11])
})

// The clock ticks only while something needs it (src/time.ts). These count its ticks in the page
// and start each motion from a clock that has been idle.
declare global {
    interface Window {
        clockTicks: number
        inertiaStarts: number[]
    }
}

const countTicks = (page: Page) =>
    page.evaluate(async () => {
        const { appImport, view } = window.editorTest
        const { time } = await appImport<typeof import('../../src/time')>('/src/time.ts')
        const vue = performance
            .getEntriesByType('resource')
            .find((entry) => new URL(entry.name).pathname.endsWith('/deps/vue.js'))!.name
        const { watch } = (await import(vue)) as typeof import('vue')
        window.clockTicks = 0
        window.inertiaStarts = []
        watch(time, () => window.clockTicks++, { flush: 'sync' })
        watch(
            () => view.scrollingY,
            (scrolling) => {
                if (scrolling?.type === 'inertia') window.inertiaStarts.push(scrolling.value)
            },
            { flush: 'sync' },
        )
    })

const ticks = (page: Page) => page.evaluate(() => window.clockTicks)

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

/** Expects the clock to tick no more over 30 frames, once the frames in flight have run. */
const expectIdle = async (page: Page) => {
    await frames(page, 2)
    const before = await ticks(page)
    await frames(page, 30)
    expect(await ticks(page)).toBe(before)
}

const isScrolling = (page: Page) =>
    page.evaluate(() => {
        const { view } = window.editorTest
        return !!(view.scrollingX || view.scrollingY || view.scrollingPane)
    })

test('an idle editor runs no clock ticks, and an eased scroll wakes the clock and ends', async ({
    page,
}) => {
    await countTicks(page)
    await expectIdle(page)
    expect(await ticks(page)).toBe(0)

    const target = await page.evaluate(() => {
        const { view, settings } = window.editorTest
        settings.mouseSmoothScrolling = true
        return view.time + 120 / settings.pps
    })
    const chart = (await page.locator('canvas.editor-chart').boundingBox())!
    await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height / 2)
    await page.mouse.wheel(0, -120)
    await expect.poll(() => isScrolling(page)).toBe(false)
    expect(await page.evaluate(() => window.editorTest.view.time)).toBeCloseTo(target, 9)
    expect(await ticks(page)).toBeGreaterThan(2)
    await expectIdle(page)
})

test('playback wakes an idle clock, moves the cursor on its ticks and lets it stop', async ({
    page,
}) => {
    await countTicks(page)
    await expectIdle(page)
    const start = await page.evaluate(async () => {
        const { appImport, view } = window.editorTest
        const { startOrStopPlayer } =
            await appImport<typeof import('../../src/editor/player')>('/src/editor/player.ts')
        view.cursorTime = 1
        startOrStopPlayer()
        return window.clockTicks
    })
    await expect
        .poll(() => page.evaluate(() => window.editorTest.view.cursorTime))
        .toBeGreaterThan(1.2)
    expect((await ticks(page)) - start).toBeGreaterThan(5)
    await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { startOrStopPlayer } =
            await appImport<typeof import('../../src/editor/player')>('/src/editor/player.ts')
        startOrStopPlayer()
    })
    await expectIdle(page)
})

test.describe('touch', () => {
    test.use({ hasTouch: true })

    test('a quick-scroll flick from an idle clock throws at its last 100 ms’ speed and comes to rest', async ({
        page,
    }) => {
        const touch = await touchInput(page)
        await countTicks(page)
        await expectIdle(page)
        const { x, y, w, h } = await page.evaluate(() => {
            window.editorTest.settings.touchScrollInertia = true
            const { x, y, w, h } = window.editorTest.view
            return { x, y, w, h }
        })
        // Eight 20 px moves 3 frames apart: at most three of them fall in the last 100 ms.
        const at = { x: x + w - 12, y: y + h * 0.3 }
        await touch('touchStart', [[at.x, at.y]])
        for (let i = 1; i <= 8; i++) {
            await frames(page, 3)
            await touch('touchMove', [[at.x, at.y + 20 * i]])
        }
        await touch('touchEnd', [])
        await expect.poll(() => page.evaluate(() => window.inertiaStarts.length)).toBe(1)
        const [velocity] = await page.evaluate(() => window.inertiaStarts)
        // A clock that read one time for every move would count all eight.
        expect(velocity).toBeGreaterThan(0)
        expect(velocity).toBeLessThanOrEqual((4 * 20) / 0.1)
        await expect.poll(() => isScrolling(page)).toBe(false)
        await expectIdle(page)
    })
})
