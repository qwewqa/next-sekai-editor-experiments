import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { effectScope, type EffectScope } from 'vue'

// The History clock publishes a new calendar only when the local hour (so the day) or the
// zone changes, and it looks at the clock at the next boundary, every 60 s while subscribed, when
// History or Go To opens, and when the tab is shown or focused. New York has a fall-back (2026-11-01)
// where the 1 AM hour comes twice.
process.env.TZ = 'America/New_York'
assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/New_York')

const window = new EventTarget()
const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
Object.assign(globalThis, { window, document })

const { checkHistoryCalendar, historyCalendar, useHistoryCalendar } =
    await import('../../../src/editor/history/calendarClock')

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const scopes: EffectScope[] = []
/** Subscribes as a component would, for a scope the test ends. */
const subscribe = () => {
    const scope = effectScope()
    scopes.push(scope)
    const calendar = scope.run(() => useHistoryCalendar())!
    return { calendar, scope }
}

const start = (now: number) => {
    mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now })
}

beforeEach(() => {
    process.env.TZ = 'America/New_York'
    document.visibilityState = 'visible'
})
afterEach(() => {
    for (const scope of scopes.splice(0)) scope.stop()
    mock.restoreAll()
    mock.timers.reset()
    process.env.TZ = 'America/New_York'
})

test('the calendar changes at the next local hour and not before', () => {
    start(Date.UTC(2026, 9, 20, 14, 59, 30)) // 10:59:30 EDT
    const { calendar } = subscribe()
    const first = calendar.value
    assert.equal(first.zone, 'America/New_York')
    assert.equal(first.now, Date.UTC(2026, 9, 20, 14, 59, 30))
    mock.timers.tick(29_999)
    assert.equal(calendar.value, first, 'the same calendar before the hour')
    mock.timers.tick(1)
    assert.notEqual(calendar.value, first)
    assert.notEqual(calendar.value.span, first.span)
    assert.equal(calendar.value.today, first.today, 'the same day')
    assert.equal(calendar.value.now, Date.UTC(2026, 9, 20, 15, 0, 0))
    // And again an hour later.
    const second = calendar.value
    mock.timers.tick(HOUR - 1)
    assert.equal(calendar.value, second)
    mock.timers.tick(1)
    assert.notEqual(calendar.value, second)
})

test('the day changes at local midnight', () => {
    start(Date.UTC(2026, 9, 21, 3, 59, 0)) // 23:59 EDT on the 20th
    const { calendar } = subscribe()
    const first = calendar.value
    mock.timers.tick(MINUTE)
    assert.equal(calendar.value.today, first.today + 1)
})

test('at a fall-back the second 1 AM hour starts when the clock shows it, not an hour and a half later', () => {
    start(Date.UTC(2026, 10, 1, 5, 30)) // 01:30 EDT; the clock goes back to 01:00 EST at 06:00Z
    const { calendar } = subscribe()
    const first = calendar.value
    mock.timers.tick(30 * MINUTE - 1)
    assert.equal(calendar.value, first)
    mock.timers.tick(1)
    assert.notEqual(calendar.value.span, first.span, 'the second 1 AM is a new hour')
    assert.equal(calendar.value.today, first.today)
    // The old tick (the next local hour by the clock's hours, plus a second) was at 07:00:01Z.
    assert.equal(calendar.value.now, Date.UTC(2026, 10, 1, 6, 0, 0))
})

test('at a spring-forward the missing hour is skipped without a stale calendar', () => {
    start(Date.UTC(2026, 2, 8, 6, 30)) // 01:30 EST; at 07:00Z the clock jumps to 03:00 EDT
    const { calendar } = subscribe()
    const first = calendar.value
    mock.timers.tick(30 * MINUTE)
    assert.notEqual(calendar.value.span, first.span)
    assert.equal(calendar.value.now, Date.UTC(2026, 2, 8, 7, 0, 0))
})

test('a sleep that skips hours is caught within 60 s', () => {
    start(Date.UTC(2026, 9, 20, 14, 30)) // 10:30 EDT
    const { calendar } = subscribe()
    const first = calendar.value
    // The machine sleeps three hours: the clock jumps and no timer ran.
    mock.timers.setTime(Date.UTC(2026, 9, 20, 17, 30))
    mock.timers.tick(MINUTE)
    assert.notEqual(calendar.value, first)
    assert.equal(calendar.value.now >= Date.UTC(2026, 9, 20, 17, 30), true)
    assert.notEqual(calendar.value.span, first.span)
})

test('a zone change is caught by the 60 s check, not before', () => {
    start(Date.UTC(2026, 9, 20, 14, 30))
    const { calendar } = subscribe()
    const first = calendar.value
    process.env.TZ = 'Asia/Tokyo'
    mock.timers.tick(MINUTE - 1)
    assert.equal(calendar.value, first)
    mock.timers.tick(1)
    assert.equal(calendar.value.zone, 'Asia/Tokyo')
    assert.equal(calendar.value.today - first.today, 0, 'Oct 20 in both at 23:31 and 10:31')
    assert.notEqual(calendar.value, first)
})

test('History or Go To opening looks at the clock at once', () => {
    start(Date.UTC(2026, 9, 20, 14, 30))
    const { calendar } = subscribe()
    process.env.TZ = 'Pacific/Kiritimati'
    checkHistoryCalendar()
    assert.equal(calendar.value.zone, 'Pacific/Kiritimati')
})

test('a calendar is not republished when nothing moved', () => {
    start(Date.UTC(2026, 9, 20, 14, 30))
    const { calendar } = subscribe()
    const first = calendar.value
    checkHistoryCalendar()
    mock.timers.tick(10 * MINUTE)
    assert.equal(calendar.value, first)
})

test('focus, pageshow and a tab shown each look at the clock; a hidden tab does not', () => {
    start(Date.UTC(2026, 9, 20, 14, 30))
    const { calendar } = subscribe()
    for (const [zone, fire] of [
        ['Asia/Tokyo', () => window.dispatchEvent(new Event('focus'))],
        ['Europe/London', () => window.dispatchEvent(new Event('pageshow'))],
        [
            'Australia/Lord_Howe',
            () => {
                document.visibilityState = 'visible'
                document.dispatchEvent(new Event('visibilitychange'))
            },
        ],
    ] as const) {
        process.env.TZ = zone
        fire()
        assert.equal(calendar.value.zone, zone)
    }
    process.env.TZ = 'America/New_York'
    document.visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(calendar.value.zone, 'Australia/Lord_Howe', 'hidden: no check')
    document.visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(calendar.value.zone, 'America/New_York')
})

test('after the last subscriber leaves, nothing runs and nothing listens', () => {
    start(Date.UTC(2026, 9, 20, 14, 30))
    const { calendar, scope } = subscribe()
    const last = calendar.value
    scope.stop()
    process.env.TZ = 'Asia/Tokyo'
    window.dispatchEvent(new Event('focus'))
    checkHistoryCalendar()
    mock.timers.tick(3 * HOUR)
    assert.equal(calendar.value, last, 'no publication while idle')
})

test('two subscribers share the clock, and it runs until the last one leaves', () => {
    start(Date.UTC(2026, 9, 20, 14, 59, 30))
    const a = subscribe()
    const b = subscribe()
    assert.equal(a.calendar.value, b.calendar.value)
    a.scope.stop()
    const first = b.calendar.value
    mock.timers.tick(30_000)
    assert.notEqual(b.calendar.value, first, 'still running for the second')
    b.scope.stop()
})

test('a later subscriber starts from a fresh sample, not the value left from before', () => {
    start(Date.UTC(2026, 9, 20, 14, 30))
    const { calendar, scope } = subscribe()
    const stale = calendar.value
    scope.stop()
    mock.timers.setTime(Date.UTC(2026, 9, 22, 14, 30))
    process.env.TZ = 'Asia/Tokyo'
    const again = subscribe()
    assert.notEqual(again.calendar.value, stale)
    assert.equal(again.calendar.value.now, Date.UTC(2026, 9, 22, 14, 30))
    assert.equal(again.calendar.value.zone, 'Asia/Tokyo')
})

test('historyCalendar() is the published value while the clock runs and a fresh sample while idle', () => {
    start(Date.UTC(2026, 9, 20, 14, 30))
    const idle = historyCalendar()
    assert.equal(idle.now, Date.UTC(2026, 9, 20, 14, 30))
    mock.timers.setTime(Date.UTC(2026, 9, 20, 14, 45))
    assert.equal(historyCalendar().now, Date.UTC(2026, 9, 20, 14, 45), 'fresh, not cached')
    process.env.TZ = 'Asia/Tokyo'
    assert.equal(historyCalendar().zone, 'Asia/Tokyo', 'the zone is read each time')
    process.env.TZ = 'America/New_York'
    const { calendar } = subscribe()
    assert.equal(historyCalendar(), calendar.value, 'running: the published calendar')
})

test('a surface that mounts while another holds the clock looks at it: History opening after a sleep and a move', () => {
    start(Date.UTC(2026, 9, 20, 14, 30)) // 10:30 EDT
    // The peek bar holds the clock for the editor's whole life.
    const bar = subscribe()
    const stale = bar.calendar.value
    mock.timers.setTime(Date.UTC(2026, 9, 20, 17, 45))
    process.env.TZ = 'Asia/Tokyo'
    // The Timeline mounts as History opens: no timer, focus or visibility event has run.
    const timeline = subscribe()
    assert.equal(timeline.calendar.value.zone, 'Asia/Tokyo')
    assert.equal(timeline.calendar.value.now, Date.UTC(2026, 9, 20, 17, 45))
    assert.notEqual(timeline.calendar.value, stale)
    assert.equal(timeline.calendar.value, bar.calendar.value, 'one calendar for every surface')
    // And a surface that mounts when nothing moved does not republish.
    const same = timeline.calendar.value
    subscribe()
    assert.equal(bar.calendar.value, same)
})

test('the last subscriber leaving clears the timer and the interval and removes every listener', () => {
    start(Date.UTC(2026, 9, 20, 14, 30))
    const added: [EventTarget, string, unknown][] = []
    const removed: [EventTarget, string, unknown][] = []
    for (const target of [window, document])
        for (const [name, log] of [
            ['addEventListener', added],
            ['removeEventListener', removed],
        ] as const) {
            const original = target[name].bind(target)
            mock.method(target, name, (type: string, handler: EventListener) => {
                log.push([target, type, handler])
                original(type, handler)
            })
        }
    const setTimer = mock.method(globalThis, 'setTimeout')
    const setEvery = mock.method(globalThis, 'setInterval')
    const clearTimer = mock.method(globalThis, 'clearTimeout')
    const clearEvery = mock.method(globalThis, 'clearInterval')

    const a = subscribe()
    const b = subscribe()
    assert.equal(added.length, 3, 'focus, pageshow and visibilitychange, once')
    assert.equal(setEvery.mock.callCount(), 1)
    const interval = setEvery.mock.calls[0]!.result
    a.scope.stop()
    assert.equal(removed.length, 0, 'still held')
    assert.equal(clearEvery.mock.callCount(), 0)
    b.scope.stop()
    assert.deepEqual(removed.map(([, type]) => type).sort(), [
        'focus',
        'pageshow',
        'visibilitychange',
    ])
    for (const [target, type, handler] of added)
        assert.ok(
            removed.some(([t, ty, h]) => t === target && ty === type && h === handler),
            `${type} removed with the handler it was added with`,
        )
    assert.equal(clearEvery.mock.calls.at(-1)?.arguments[0], interval)
    assert.equal(
        clearTimer.mock.calls.at(-1)?.arguments[0],
        setTimer.mock.calls.at(-1)?.result,
        'the pending boundary timer',
    )
})

test('a timer that fires a moment early finds the same hour and arms again for the rest', () => {
    // The timers run on their own clock and the wall clock is set by hand, so the timer can fire
    // while the wall clock is still short of the hour, as a corrected clock lets it.
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    let wall = Date.UTC(2026, 9, 20, 14, 59, 30) // the next boundary is in 30 s
    mock.method(Date, 'now', () => wall)
    const { calendar } = subscribe()
    const first = calendar.value
    wall = Date.UTC(2026, 9, 20, 14, 59, 55)
    mock.timers.tick(30_000) // the timer fires, 5 s short of the hour
    assert.equal(calendar.value, first, 'same hour: nothing published')
    wall = Date.UTC(2026, 9, 20, 15, 0, 0)
    mock.timers.tick(5_000) // the interval (60 s) has not run: only the re-armed timer can
    assert.notEqual(calendar.value, first)
    assert.equal(calendar.value.now, Date.UTC(2026, 9, 20, 15, 0, 0))
})
