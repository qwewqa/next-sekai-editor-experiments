import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { GCSystem, type Renderer } from 'pixi.js'
import {
    CEILING_MS,
    QUIET_MS,
    RenderingScheduler,
    type Activity,
} from '../../src/rendering/scheduler'

type Host = ConstructorParameters<typeof RenderingScheduler>[0]

/** Mocked timers and clock. `advance` runs each millisecond's timers in turn. */
const clock = (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    t.mock.method(performance, 'now', () => Date.now())
    const activity: Activity = { last: -Infinity, since: -Infinity }
    const advance = (ms: number, each?: (now: number) => void) => {
        for (let i = 0; i < ms; i++) {
            t.mock.timers.tick(1)
            each?.(Date.now())
        }
    }
    return { activity, advance }
}

/** Pixi's real GC on the scheduler, with a frame run in Pixi's order. */
const withGc = (activity: Activity, gcFrequency = 10_000) => {
    const renderer = { tick: 0, context: { isLost: false } } as Record<string, unknown>
    const scheduler = new RenderingScheduler(renderer as Host, activity)
    renderer.scheduler = scheduler
    const gc = new GCSystem(renderer as unknown as Renderer)
    renderer.gc = gc
    gc.init({ gcActive: true, gcMaxUnusedTime: 60_000, gcFrequency })
    const passes: { at: number; inFrame: boolean }[] = []
    let inFrame = false
    const run = gc.run.bind(gc)
    gc.run = () => {
        passes.push({ at: performance.now(), inFrame })
        run()
    }
    // A texture the frame draws with, as Pixi's bind marks it.
    const texture = {
        _gcLastUsed: -1,
        autoGarbageCollect: true,
        unloaded: false,
        unload() {
            this.unloaded = true
        },
        once() {},
        off() {},
    }
    gc.addResource(texture as never, 'resource')
    const frame = (uses = true) => {
        inFrame = true
        try {
            scheduler.prerender()
            gc.now = performance.now()
            if (uses) texture._gcLastUsed = gc.now
            ;(gc as unknown as { postrender(): void }).postrender()
        } finally {
            inFrame = false
        }
    }
    return { scheduler, renderer, passes, frame, texture }
}

test('maintenance waits for a render and quiet time, and does not replay missed intervals', (t) => {
    const { activity, advance } = clock(t)
    const scheduler = new RenderingScheduler(undefined, activity)
    const calls: [number, number][] = []
    scheduler.repeat((elapsed) => calls.push([Date.now(), elapsed]), 100, false)
    advance(100_000)
    assert.deepEqual(calls, [], 'time passing alone never schedules work')
    scheduler.prerender()
    scheduler.prerender()
    assert.deepEqual(calls, [], 'a render never runs it')
    advance(QUIET_MS - 1)
    assert.deepEqual(calls, [])
    advance(1)
    assert.deepEqual(calls, [[101_000, 101_000]], 'one cleanup at idle time, without a burst')
    advance(100)
    assert.deepEqual(calls.length, 2, 'it repeats while idle, soon after the render')
})

test('no GC pass runs inside a frame while drawing goes on, and one runs once it stops', (t) => {
    const { activity, advance } = clock(t)
    const { passes, frame, texture } = withGc(activity)
    // 20 s of frames, every 16 ms: the pass falls due at 10 s.
    frame()
    advance(20_000, (now) => {
        if (now % 16 === 0) frame()
    })
    assert.deepEqual(passes, [])
    advance(QUIET_MS)
    assert.deepEqual(passes, [{ at: 20_000 + QUIET_MS, inFrame: false }])
    assert.equal(texture.unloaded, false, 'what the last frame drew stays loaded')
})

test('drawing that goes on runs a due pass at idle time once it is a minute overdue', (t) => {
    const { activity, advance } = clock(t)
    const { passes, frame } = withGc(activity)
    frame()
    advance(75_000, (now) => {
        if (now % 16 === 0) frame()
    })
    assert.deepEqual(passes, [{ at: 10_000 + CEILING_MS, inFrame: false }])
})

test('after a long pause, drawing again waits for quiet time, not the ceiling', (t) => {
    const { activity, advance } = clock(t)
    const { passes, frame } = withGc(activity)
    frame()
    // Idle for two minutes: passes run while what the frame drew is recent, then stop.
    advance(120_000)
    const at = () => passes.map(({ at }) => at)
    assert.deepEqual(at(), [10_000, 20_000])
    // A pass is now long overdue. Frames for 30 s from here still carry none.
    advance(30_000, (now) => {
        if (now % 16 === 0) frame()
    })
    assert.deepEqual(at(), [10_000, 20_000])
    advance(QUIET_MS)
    assert.deepEqual(at(), [10_000, 20_000, 150_000 - (150_000 % 16) + QUIET_MS])
    assert.ok(passes.every(({ inFrame }) => !inFrame))
})

test("a pass never comes so long after its renderer's last render that it unloads what it drew", (t) => {
    const { activity, advance } = clock(t)
    const shown = withGc(activity)
    const other = withGc(activity)
    shown.frame()
    // Another renderer draws on for two minutes: playback beside a still pane.
    advance(120_000, (now) => {
        if (now % 16 === 0) other.frame()
    })
    assert.deepEqual(shown.passes, [], 'none after it last drew, while the other draws')
    assert.equal(shown.texture.unloaded, false)
    // Its next frame draws with the texture again; the overdue pass keeps it.
    shown.frame()
    advance(100, (now) => {
        if (now % 16 === 0) other.frame()
    })
    assert.deepEqual(shown.passes, [{ at: 120_001, inFrame: false }])
    assert.equal(shown.texture.unloaded, false)
    // Unused for over a minute, it is unloaded by a later pass, as Pixi's own rule says.
    shown.frame(false)
    advance(15_000)
    shown.frame(false)
    advance(15_000)
    shown.frame(false)
    advance(15_000)
    shown.frame(false)
    advance(20_000)
    assert.equal(shown.texture.unloaded, true)
})

test('GC resource and collection maintenance keep their staggered intervals', (t) => {
    const { activity, advance } = clock(t)
    const scheduler = new RenderingScheduler(undefined, activity)
    const calls: [string, number][] = []
    scheduler.repeat(() => calls.push(['resources', Date.now()]), 100, false)
    scheduler.repeat(() => calls.push(['collections', Date.now()]), 100)
    scheduler.repeat(() => calls.push(['later', Date.now()]), 100)
    scheduler.prerender()
    advance(QUIET_MS + 1100)
    // Each waits its period plus its offset, then repeats with it.
    assert.deepEqual(
        calls.filter(([name]) => name === 'resources').map(([, at]) => at),
        Array.from({ length: 12 }, (_, i) => 1000 + i * 100),
    )
    assert.deepEqual(
        calls.filter(([name]) => name !== 'resources'),
        [
            ['collections', 1100],
            ['later', 2100],
        ],
    )
})

test('cancelled tasks stay cancelled, and destroy and context loss stop maintenance', (t) => {
    const { activity, advance } = clock(t)
    const host = { context: { isLost: false } }
    const scheduler = new RenderingScheduler(host as Host, activity)
    const calls: string[] = []
    const first = scheduler.repeat(
        () => {
            calls.push('first')
            scheduler.cancel(first)
            scheduler.cancel(cancelled)
        },
        100,
        false,
    )
    const cancelled = scheduler.repeat(() => calls.push('cancelled'), 100, false)
    scheduler.repeat(() => calls.push('last'), 100, false)
    scheduler.cancel(-1)
    scheduler.prerender()
    advance(QUIET_MS)
    assert.deepEqual(calls, ['first', 'last'])
    // Lost: nothing runs, and restoration alone does not resume it.
    host.context.isLost = true
    advance(1000)
    host.context.isLost = false
    advance(1000)
    assert.deepEqual(calls, ['first', 'last'])
    scheduler.prerender()
    advance(QUIET_MS)
    assert.deepEqual(calls, ['first', 'last', 'last'], 'the next render resumes it')
    scheduler.prerender()
    scheduler.destroy()
    const destroyed = calls.length
    advance(10_000)
    scheduler.prerender()
    advance(10_000)
    assert.equal(calls.length, destroyed)
})
