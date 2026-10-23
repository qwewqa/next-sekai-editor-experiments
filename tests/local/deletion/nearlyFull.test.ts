import assert from 'node:assert/strict'
import test from 'node:test'
import { isNearlyFull, noticeIfNearlyFull } from '../../../src/local/nearlyFull'
import { HIGH_SHARE } from '../../../src/local/pressure'

// "Browser storage is almost full." (owner, 2026-10-23): once a day, after GC and cleanup, when
// usage is still above the cleanup threshold.

const QUOTA = 1_000_000_000

const setup = (usage: number | undefined, quota: number | undefined = QUOTA, saved?: string) => {
    const state = { day: saved, notices: 0, today: '20000' }
    const run = () =>
        noticeIfNearlyFull({
            estimate: () => Promise.resolve({ usage, quota }),
            today: () => state.today,
            lastDay: () => state.day,
            saveDay: (day) => {
                state.day = day
            },
            notice: () => {
                state.notices++
            },
        })
    return { state, run }
}

test('above the cleanup threshold is nearly full; at it, below it, or without figures is not', () => {
    assert.equal(isNearlyFull({ usage: HIGH_SHARE * QUOTA + 1, quota: QUOTA }), true)
    assert.equal(isNearlyFull({ usage: HIGH_SHARE * QUOTA, quota: QUOTA }), false)
    assert.equal(isNearlyFull({ usage: 10, quota: QUOTA }), false)
    assert.equal(isNearlyFull({ usage: 10 }), false)
    assert.equal(isNearlyFull({ quota: QUOTA }), false)
    assert.equal(isNearlyFull({ usage: 10, quota: 0 }), false)
})

test('the notice shows once per day: a reload the same day says nothing, the next day says it again', async () => {
    const { state, run } = setup(0.9 * QUOTA)
    assert.equal(await run(), true)
    assert.equal(state.notices, 1)
    // A reload the same day.
    assert.equal(await run(), false)
    assert.equal(state.notices, 1)
    state.today = '20001'
    assert.equal(await run(), true)
    assert.equal(state.notices, 2)
})

test('below the threshold after cleanup there is no notice and no stamp', async () => {
    const { state, run } = setup(0.5 * QUOTA)
    assert.equal(await run(), false)
    assert.deepEqual([state.notices, state.day], [0, undefined])
})

test('a browser that cannot estimate says nothing', async () => {
    const { state } = setup(undefined)
    const run = () =>
        noticeIfNearlyFull({
            estimate: () => Promise.reject(new Error('unsupported')),
            today: () => '1',
            lastDay: () => undefined,
            saveDay: () => undefined,
            notice: () => {
                state.notices++
            },
        })
    assert.equal(await run(), false)
    assert.equal(state.notices, 0)
})
