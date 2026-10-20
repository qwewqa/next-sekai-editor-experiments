import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { effectScope, type EffectScope } from 'vue'

// I-10: the History clock publishes a new calendar only when the local hour (so the day) or the
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
