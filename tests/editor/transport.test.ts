import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { effectScope, nextTick, ref, shallowReactive, watch } from 'vue'
import { createTransport } from '../../src/editor/transport'

const fixture = (t: TestContext) => {
    type Dependencies = Parameters<typeof createTransport>[0]
    const view = shallowReactive<Dependencies['view']>({
        cursorTime: 3,
        time: 4,
        h: 600,
        scrollingY: undefined,
    })
    const settings = { playFollow: false, playFollowPosition: 25, pps: 100 }
    const clock = {
        now: 10,
        audio: undefined as number | undefined,
        display: undefined as number | undefined,
    }
    const starts: { time: number; speed: number; delay?: number }[] = []
    // Each start's failure callback, as the audio calls it when the start fails.
    const failures: (() => void)[] = []
    const auditions: number[] = []
    let stopped = 0
    let active = 0
    const notifications: (string | number)[] = []
    const flushVersion = ref(0)
    const transport = createTransport({
        audio: {
            start(time, speed, onFailure, delay) {
                starts.push({ time, speed, delay })
                failures.push(onFailure)
                clock.audio = time
            },
            stop() {
                stopped++
                clock.audio = undefined
            },
            getTime: () => clock.audio,
            getDisplayTime: () => clock.display ?? clock.audio,
            audition: (time) => auditions.push(time),
        },
        view,
        settings,
        now: () => clock.now,
        focus: (time) => {
            view.cursorTime = time
        },
        activate: () => active++,
        queueFlush: () => flushVersion.value++,
        onPlay: () => notifications.push('play'),
        onStop: () => notifications.push('stop'),
        onStartFailed: () => notifications.push('failed'),
        onSpeedChange: (speed) => notifications.push(speed),
    })
    const scope = effectScope()
    scope.run(() => {
        watch(flushVersion, transport.flushAudition)
    })
    t.after(() => scope.stop())
    return {
        transport,
        view,
        settings,
        clock,
        starts,
        failures,
        auditions,
        notifications,
        counts: () => ({ stopped, active }),
    }
}

test('a requested clip plays its own time at the next flush, also time 0, and leaves the cursor', async (t) => {
    const { transport, view, auditions } = fixture(t)
    transport.audition(12)
    transport.audition(13)
    assert.deepEqual(auditions, [])
    await nextTick()
    assert.deepEqual(auditions, [13])
    transport.audition(0)
    await nextTick()
    assert.deepEqual(auditions, [13, 0])
    assert.equal(view.cursorTime, 3)
})

test('moving the cursor through time plays no clip: writes, steps, scrubs and Stop', async (t) => {
    const { transport, view, clock, auditions } = fixture(t)
    view.cursorTime = 5
    await nextTick()
    transport.step(10)
    await nextTick()
    assert.equal(view.cursorTime, 5.01)
    // Clamped at 0, without a cursor change.
    view.cursorTime = 0
    transport.step(-1)
    transport.step(-100)
    await nextTick()
    assert.equal(view.cursorTime, 0)
    transport.beginScrub()
    transport.scrubTo(4)
    transport.endScrub()
    await nextTick()
    assert.equal(view.cursorTime, 4)
    transport.play(view.cursorTime)
    clock.audio = 6
    transport.update()
    transport.stop(true)
    await nextTick()
    assert.equal(view.cursorTime, 4)
    assert.deepEqual(auditions, [])
})

test('steps drop a queued clip and later requests play', async (t) => {
    const { transport, view, auditions } = fixture(t)
    view.cursorTime = 3.123456
    transport.audition(12)
    transport.step(1)
    transport.step(10)
    await nextTick()
    assert.equal(view.cursorTime, 3.123456 + 0.001 + 0.01)
    assert.deepEqual(auditions, [])
    transport.step(100)
    transport.audition(14)
    await nextTick()
    assert.deepEqual(auditions, [14])
})

test('stopping a paused transport cancels a queued clip before it flushes', async (t) => {
    const { transport, auditions } = fixture(t)
    transport.audition(12)
    transport.stop()
    await nextTick()
    assert.deepEqual(auditions, [])

    // New requests after the stop still play.
    transport.audition(14)
    await nextTick()
    assert.deepEqual(auditions, [14])
})

test('play and pause discard queued auditions and pause captures the audio clock', async (t) => {
    const { transport, view, clock, starts, auditions } = fixture(t)
    transport.audition(8)
    transport.play(view.cursorTime)
    await nextTick()
    assert.deepEqual(starts, [{ time: 3, speed: 1, delay: undefined }])
    assert.deepEqual(auditions, [])
    clock.audio = 3.123456
    view.cursorTime = 9
    transport.audition(12)
    transport.pause()
    await nextTick()
    assert.equal(view.cursorTime, 3.123456)
    assert.equal(transport.isPlaying, false)
    assert.deepEqual(auditions, [])
    transport.audition(14)
    await nextTick()
    assert.deepEqual(auditions, [14])
})

test('frames draw the smoothed position while pause and speed changes use the audio clock', async (t) => {
    const { transport, view, clock, starts } = fixture(t)
    transport.play(3)
    clock.audio = 4
    clock.display = 4.02
    transport.update()
    assert.equal(view.cursorTime, 4.02)
    transport.changeSpeed(1)
    assert.deepEqual(starts.at(-1), { time: 4, speed: 1.5, delay: 0 })
    transport.pause()
    await nextTick()
    assert.equal(view.cursorTime, 4)
})

test('stepping during playback preserves the displayed position while speed changes use audio time', async (t) => {
    const { transport, view, clock, starts, auditions, counts } = fixture(t)
    transport.play(3)
    clock.audio = 4.25
    transport.changeSpeed(-1)
    assert.deepEqual(starts.at(-1), { time: 4.25, speed: 0.75, delay: 0 })
    assert.equal(view.cursorTime, 3)
    transport.step(10)
    await nextTick()
    assert.equal(transport.isPlaying, false)
    assert.equal(counts().stopped, 1)
    assert.equal(view.cursorTime, 3.01)
    assert.deepEqual(auditions, [])
})

// The app clock runs while this is true, so it must change as playback starts and ends.
test('whether it plays is reactive, also when the next frame finds the audio stopped', (t) => {
    const { transport, view, clock } = fixture(t)
    const seen: boolean[] = []
    const scope = effectScope()
    scope.run(() =>
        watch(
            () => transport.isPlaying,
            (playing) => seen.push(playing),
            { flush: 'sync' },
        ),
    )
    t.after(() => scope.stop())
    transport.play(view.cursorTime)
    // Stopped outside the transport, as a failed audio resume does.
    clock.audio = undefined
    transport.update()
    transport.play(view.cursorTime)
    transport.pause()
    assert.deepEqual(seen, [true, false, true, false])
})

test('a failed start shows Play at once, so the next press plays, before any frame', (t) => {
    const { transport, view, clock, starts, failures, notifications, counts } = fixture(t)
    transport.play(view.cursorTime)
    clock.audio = undefined
    failures.at(-1)!()
    assert.equal(transport.isPlaying, false)
    assert.deepEqual(notifications, ['play', 'failed'])
    transport.play(view.cursorTime)
    assert.equal(transport.isPlaying, true)
    assert.equal(starts.length, 2)
    assert.equal(counts().stopped, 0)
    // A late call from the earlier start leaves the newer playback alone.
    failures[0]!()
    assert.equal(transport.isPlaying, true)
    assert.deepEqual(notifications, ['play', 'failed', 'play'])
})

test('stop returns to the original play position after speed changes', async (t) => {
    const { transport, view, clock, notifications } = fixture(t)
    transport.play(3)
    clock.audio = 8
    transport.update()
    transport.changeSpeed(1)
    transport.stop(true)
    await nextTick()
    assert.equal(view.cursorTime, 3)
    assert.deepEqual(notifications, ['play', 1.5, 'stop'])
})

test('a scrub stops playback, drops queued and new clips through its end, and later requests play', async (t) => {
    const { transport, view, auditions } = fixture(t)
    transport.play(3)
    transport.beginScrub()
    assert.equal(transport.isPlaying, false)
    transport.endScrub()
    transport.audition(12)
    transport.beginScrub()
    transport.scrubTo(-1)
    assert.equal(view.cursorTime, 0)
    transport.audition(18)
    transport.scrubTo(4.250456)
    transport.endScrub()
    transport.endScrub()
    transport.scrubTo(20)
    await nextTick()
    assert.equal(view.cursorTime, 4.250456)
    assert.deepEqual(auditions, [])
    transport.audition(9)
    await nextTick()
    assert.deepEqual(auditions, [9])
})

test('play and exact steps take over a scrub', async (t) => {
    const { transport, view, auditions, starts } = fixture(t)
    transport.beginScrub()
    transport.scrubTo(4.123456)
    transport.play(view.cursorTime)
    transport.scrubTo(20)
    assert.deepEqual(starts, [{ time: 4.123456, speed: 1, delay: undefined }])
    transport.beginScrub()
    transport.scrubTo(5.123456)
    transport.step(-1)
    transport.endScrub()
    await nextTick()
    assert.equal(view.cursorTime, 5.123456 - 0.001)
    assert.deepEqual(auditions, [])
})

test('smooth follow retargets using the clock and cancels only its own scroll', (t) => {
    const { transport, view, settings, clock } = fixture(t)
    settings.playFollow = true
    transport.step(100)
    assert.deepEqual(view.scrollingY, {
        type: 'ease',
        from: { time: 10, viewTime: 4 },
        to: { time: 10.25, viewTime: 4.6 },
    })
    clock.now = 10.1
    view.time = 4.2
    transport.step(100)
    assert.deepEqual(view.scrollingY, {
        type: 'ease',
        from: { time: 10.1, viewTime: 4.2 },
        to: { time: 10.35, viewTime: 4.7 },
    })
    transport.cancelFollow()
    assert.equal(view.scrollingY, undefined)
    transport.step(100)
    const editorScroll = { type: 'inertia', value: 240 } as const
    view.scrollingY = editorScroll
    transport.cancelFollow()
    assert.equal(view.scrollingY, editorScroll)
})

test('locked scrub follows immediately and invalid input preserves state', (t) => {
    const { transport, view, settings } = fixture(t)
    settings.playFollow = true
    transport.beginScrub('locked')
    assert.equal(view.time, 4.5)
    transport.scrubTo(5)
    assert.equal(view.time, 6.5)
    assert.equal(view.scrollingY, undefined)
    transport.scrubTo(NaN)
    transport.step(Infinity)
    transport.endScrub()
    assert.equal(view.cursorTime, 5)
})

test('a speed change never moves the drawn position back', async (t) => {
    const { transport, view, clock } = fixture(t)
    transport.play(3)
    clock.audio = 4
    clock.display = 4.02
    transport.update()
    // The new playback starts at the audio clock, behind the shown frame.
    transport.changeSpeed(1)
    clock.display = 4.005
    transport.update()
    assert.equal(view.cursorTime, 4.02)
    clock.display = 4.03
    transport.update()
    assert.equal(view.cursorTime, 4.03)
    // Once past, it follows the clock again, and pause still reads the audio clock.
    clock.audio = 4.01
    transport.pause()
    await nextTick()
    assert.equal(view.cursorTime, 4.01)
})
