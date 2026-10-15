import assert from 'node:assert/strict'
import test from 'node:test'
import { RenderingScheduler } from '../../src/rendering/scheduler'

test('idle maintenance waits for a render and does not replay missed intervals', (t) => {
    let now = 10
    t.mock.method(performance, 'now', () => now)
    const scheduler = new RenderingScheduler()
    const calls: number[] = []
    scheduler.repeat((elapsed) => calls.push(elapsed), 100, false)
    now = 109
    scheduler.prerender()
    assert.deepEqual(calls, [])
    now = 110
    scheduler.prerender()
    assert.deepEqual(calls, [100])
    now = 100_010
    assert.deepEqual(calls, [100], 'time passing alone never schedules work')
    scheduler.prerender()
    scheduler.prerender()
    assert.deepEqual(calls, [100, 100_000], 'resume runs one cleanup, without a catch-up burst')
})

test('GC resource and collection maintenance retain their staggered intervals', (t) => {
    let now = 0
    t.mock.method(performance, 'now', () => now)
    const scheduler = new RenderingScheduler()
    const calls: string[] = []
    scheduler.repeat(() => calls.push('resources'), 100, false)
    scheduler.repeat(() => calls.push('collections'), 100)
    scheduler.repeat(() => calls.push('later'), 100)
    now = 100
    scheduler.prerender()
    assert.deepEqual(calls, ['resources'])
    now = 1100
    scheduler.prerender()
    assert.deepEqual(calls, ['resources', 'resources', 'collections'])
    now = 2100
    scheduler.prerender()
    assert.deepEqual(calls, ['resources', 'resources', 'collections', 'resources', 'later'])
    now = 2200
    scheduler.prerender()
    assert.deepEqual(calls.slice(-2), ['resources', 'collections'])
})

test('cancelled tasks stay cancelled, including cancellation during maintenance', (t) => {
    let now = 0
    t.mock.method(performance, 'now', () => now)
    const scheduler = new RenderingScheduler()
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
    now = 100
    scheduler.prerender()
    assert.deepEqual(calls, ['first', 'last'])
    now = 200
    scheduler.prerender()
    assert.deepEqual(calls, ['first', 'last', 'last'])
    scheduler.destroy()
    now = 300
    scheduler.prerender()
    assert.deepEqual(calls, ['first', 'last', 'last'])
})
