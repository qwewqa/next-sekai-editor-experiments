import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

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
