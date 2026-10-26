import assert from 'node:assert/strict'
import test from 'node:test'
import { chartObjects } from '../../src/analytics/catalogue'
import { createSpan, createStateLog, takeSeconds } from '../../src/analytics/intervals'

// The interval figures behind the `perf` event, driven with fake long-frame entries.

type Frame = { startTime: number }

/** Sorts fake long frames by the state log, as field.ts does with the browser's entries. */
const sorted = (log: ReturnType<typeof createStateLog>, frames: Frame[]) => {
    const counts = { playing: 0, busy: 0, other: 0, unclassified: 0 }
    for (const { startTime } of frames) counts[log.at(startTime) ?? 'unclassified']++
    return counts
}

test('a long frame is sorted by the state it began in, not the state when it was delivered', () => {
    const log = createStateLog('other', 1000)
    log.set('playing', 2000)
    log.set('other', 3000)
    log.set('busy', 4000)
    // All delivered after 4000, when the state is busy.
    const counts = sorted(log, [
        { startTime: 1500 },
        { startTime: 2500 },
        { startTime: 2999.9 },
        { startTime: 3000 },
        { startTime: 4500 },
    ])
    assert.deepEqual(counts, { playing: 2, busy: 1, other: 2, unclassified: 0 })
})

test('a frame from before the log began cannot be placed', () => {
    const log = createStateLog('playing', 1000)
    assert.equal(log.at(999), undefined)
    assert.equal(log.at(1000), 'playing')
})

test('trimming keeps the state in force, and the log stays bounded', () => {
    const log = createStateLog('other', 0)
    log.set('playing', 100)
    log.set('busy', 200)
    log.trim(150)
    assert.equal(log.size(), 2)
    assert.equal(log.at(150), 'playing')
    assert.equal(log.at(99), undefined, 'older than the retained state')
    for (let i = 0; i < 500; i++) log.set(i % 2 ? 'playing' : 'busy', 300 + i)
    assert.ok(log.size() <= 64)
    // The oldest changes were dropped, so an old frame is no longer placed.
    assert.equal(log.at(310), undefined)
    assert.ok(log.at(790))
})

test('a change to the state it already has adds nothing', () => {
    const log = createStateLog('other', 0)
    log.set('other', 10)
    assert.equal(log.size(), 1)
})

test('a value that changed within the interval is mixed, then the next interval starts clean', () => {
    const host = createSpan<'main' | 'worker' | 'none'>('main')
    assert.equal(host.take('main'), 'main')
    host.see('worker')
    assert.equal(host.take('worker'), 'mixed')
    assert.equal(host.take('worker'), 'worker', 'the next interval began with the value then')
    // A change not yet watched is seen when the interval closes.
    assert.equal(host.take('none'), 'mixed')
})

test('playback seconds keep the remainder, so short spans are not rounded away', () => {
    let sent = 0
    let total = 0
    let reported = 0
    // Four 400 ms spans: 1.6 s of playback.
    for (let i = 0; i < 4; i++) {
        total += 400
        const taken = takeSeconds(total, sent)
        sent = taken.sent
        reported += taken.seconds
    }
    assert.equal(reported, 2)
    assert.equal(takeSeconds(0, 0).seconds, 0)
    assert.equal(takeSeconds(100 * 86_400_000, 0).seconds, 86_400, 'capped at a day a send')
})

test('the object total sums raw counts and leaves out slides', () => {
    assert.equal(
        chartObjects({ notes: 100, timeScales: 5, events: 20, bpms: 3, stages: 2, groups: 4 }),
        134,
    )
})
