import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createStartupWindow,
    NOTICE_MAX_MS,
    NOTICE_MS,
    noticeDuration,
    RESUME_MIN_MS,
    STARTUP_NOTICE_MS,
    STARTUP_WINDOW_MS,
} from '../../src/editor/noticeTiming'

// How long a notice card stays: the longer of the base time and 2 s plus
// 60 ms a character, at most 12 s.

test('short messages keep the base time', () => {
    assert.equal(noticeDuration(false, 0), NOTICE_MS)
    assert.equal(noticeDuration(false, 'Nothing to undo'.length), 6000)
    assert.equal(noticeDuration(true, 20), STARTUP_NOTICE_MS)
})

test('a longer message gets 2 s and 60 ms a character', () => {
    assert.equal(noticeDuration(false, 100), 8000)
    assert.equal(noticeDuration(false, 150), 11_000)
    assert.equal(noticeDuration(true, 120), 9200)
})

test('the time never passes 12 s', () => {
    assert.equal(noticeDuration(false, 250), NOTICE_MAX_MS)
    assert.equal(noticeDuration(true, 5000), 12_000)
})

test('a hold lets go with at least 1.5 s left', () => {
    assert.equal(RESUME_MIN_MS, 1500)
})

test('the start-up window is open until the gate lifts, then for 12 s', () => {
    const window = createStartupWindow()
    assert.equal(window.isOpen(100_000), true)
    window.start(1000)
    // A later lift changes nothing.
    window.start(5000)
    assert.equal(window.isOpen(1000 + STARTUP_WINDOW_MS - 1), true)
    assert.equal(window.isOpen(1000 + STARTUP_WINDOW_MS), false)
})

test('a hold keeps the window open past 12 s, and its release starts the 12 s again', () => {
    const window = createStartupWindow()
    window.start(0)
    window.hold(true, 1000)
    assert.equal(window.isOpen(30_000), true)
    window.hold(false, 30_000)
    assert.equal(window.isOpen(30_000 + STARTUP_WINDOW_MS - 1), true)
    assert.equal(window.isOpen(30_000 + STARTUP_WINDOW_MS), false)
})
