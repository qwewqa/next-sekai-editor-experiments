import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { ref, watch } from 'vue'

// The app clock (src/time.ts) runs only while something needs it. Its activity module reads the
// document; a load hook swaps it for a ref these tests set, and the frames and wall clock are fakes.
const here = (path: string) => new URL(path, import.meta.url).href
const activity = here('../../src/activity.ts')
registerHooks({
    load: (url, context, next) =>
        url === activity
            ? {
                  format: 'module',
                  shortCircuit: true,
                  source: "import { ref } from 'vue'\nexport const isAppActive = ref(true)",
              }
            : next(url, context),
})

const frames = new Map<number, FrameRequestCallback>()
let frameIds = 0
globalThis.requestAnimationFrame = (callback) => {
    frames.set(++frameIds, callback)
    return frameIds
}
globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id)
}
let wall = 10_000
Object.defineProperty(performance, 'now', { configurable: true, value: () => wall })

const { isAppActive } = (await import('../../src/activity')) as unknown as {
    isAppActive: { value: boolean }
}
const { clockNow, keepClockWhile, time } = await import('../../src/time')

const settle = () => new Promise((resolve) => setTimeout(resolve))
/** Runs the pending frame at `timestamp` (ms) with the wall clock at `at`, and its Vue flush. */
const frame = async (timestamp: number, at = timestamp) => {
    wall = at
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(timestamp)
    await settle()
    return { ...time.value }
}

test('an idle clock requests no frames, and a need wakes it until the tick that ends it', async () => {
    assert.equal(frames.size, 0)
    const moving = ref(false)
    const release = keepClockWhile(() => moving.value)
    try {
        assert.equal(frames.size, 0)
        moving.value = true
        assert.equal(frames.size, 1)
        // A watcher ends the motion on the third tick, as an ease reaching its end does.
        let ticks = 0
        const stop = watch(time, () => {
            if (++ticks === 3) moving.value = false
        })
        await frame(10_100)
        await frame(10_116)
        assert.equal(frames.size, 1)
        await frame(10_132)
        assert.equal(ticks, 3)
        assert.equal(frames.size, 0)
        stop()

        // Woken again, it ticks again.
        moving.value = true
        assert.equal(frames.size, 1)
        moving.value = false
        await frame(10_200)
        assert.equal(frames.size, 0)
    } finally {
        release()
    }
})

test('a woken clock’s first frame moves by about one frame, as a running clock’s does', async () => {
    const moving = ref(true)
    const release = keepClockWhile(() => moving.value)
    try {
        // Running at 240 Hz.
        for (let i = 0; i <= 4; i++) await frame(20_000 + i * 4)
        assert.ok(Math.abs(time.value.delta - 0.004) < 1e-9)
        moving.value = false
        await frame(20_020)
        assert.equal(frames.size, 0)

        // Stopped, its time is a frame before the wall clock, and never goes back.
        wall = 25_000
        assert.ok(Math.abs(clockNow() - 24.996) < 1e-9)
        wall = 24_000
        assert.ok(Math.abs(clockNow() - 24.996) < 1e-9)

        // Input dispatched just after a frame began wakes the clock in that same frame.
        wall = 26_001
        const start = clockNow()
        moving.value = true
        const first = await frame(26_000, 26_001)
        assert.ok(Math.abs(start - 25.997) < 1e-9)
        assert.ok(Math.abs(first.delta - 0.003) < 1e-9)
        const second = await frame(26_004)
        assert.ok(Math.abs(second.delta - 0.004) < 1e-9)
        // While it runs, its time is the last tick's.
        wall = 26_006
        assert.equal(clockNow(), 26.004)
    } finally {
        moving.value = false
        await frame(26_008)
        release()
    }
})

test('an inactive app runs no frames, and activation runs them only while needed', async () => {
    const moving = ref(true)
    const release = keepClockWhile(() => moving.value)
    try {
        assert.equal(frames.size, 1)
        isAppActive.value = false
        assert.equal(frames.size, 0)
        moving.value = false
        moving.value = true
        assert.equal(frames.size, 0)

        // Activation publishes the current time at once, and resumes the motion.
        wall = 40_000
        isAppActive.value = true
        assert.deepEqual(time.value, { now: 40, delta: 0 })
        assert.equal(frames.size, 1)

        isAppActive.value = false
        moving.value = false
        wall = 41_000
        isAppActive.value = true
        assert.deepEqual(time.value, { now: 41, delta: 0 })
        assert.equal(frames.size, 0)
    } finally {
        release()
    }
})

test('a need that is released stops the clock after its next tick', async () => {
    const release = keepClockWhile(() => true)
    assert.equal(frames.size, 1)
    release()
    await frame(50_000)
    assert.equal(frames.size, 0)
})
