import assert from 'node:assert/strict'
import test from 'node:test'

// The calendar module agrees with the `Date` code it replaces, in the zone the host runs in
// (a caller sets TZ before importing this). The old code is copied here as it was in rows.ts,
// labels.ts, days.ts, GoToList.vue and dateTime.ts.

const MINUTE = 60_000
const DAY = 86_400_000

const legacy = {
    minuteOf: (time: number) => Math.floor(time / MINUTE),
    hourStart: (time: number) => {
        const date = new Date(time)
        return (
            time - (date.getMinutes() * MINUTE + date.getSeconds() * 1000 + date.getMilliseconds())
        )
    },
    dayStart: (time: number) => new Date(time).setHours(0, 0, 0, 0),
    daysBefore: (time: number, now: number) =>
        Math.round((legacy.dayStart(now) - legacy.dayStart(time)) / DAY),
    spanOf: (time: number) => `${legacy.dayStart(time)}|${legacy.hourStart(time)}`,
    localDate: (time: number) => {
        const date = new Date(time)
        const pad = (value: number) => String(value).padStart(2, '0')
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    },
    sameDay: (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString(),
    sameYear: (a: number, b: number) => new Date(a).getFullYear() === new Date(b).getFullYear(),
    // The old tick: one second after the next local hour by the clock's own hours.
    tick: (time: number) => {
        const next = new Date(time)
        next.setHours(next.getHours() + 1, 0, 1, 0)
        return next.getTime()
    },
}

export const runLegacyTests = async (zone: string, alias = zone) => {
    // The engine may resolve a zone to its older name (Asia/Calcutta).
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
    assert.ok(
        resolved === zone || resolved === alias,
        `This platform ignores TZ (the resolved zone is ${resolved})`,
    )

    const calendar = await import('../../src/calendar/calendar')
    const dateTime = await import('../../src/i18n/dateTime')
    const host = calendar.hostZone()

    /** Times across 2019–2030 every 53 minutes (and 17 s), then each move of the offset in
     * 2024–2027 minute by minute. */
    const grid = () => {
        const times: number[] = []
        const end = Date.UTC(2031, 0, 1)
        for (let t = Date.UTC(2019, 0, 1), i = 0; t < end; t += 53 * MINUTE, i++)
            times.push(t + (i % 7) * 17_000)
        return times
    }
    const offsetOf = (time: number) => -new Date(time).getTimezoneOffset() * MINUTE
    const moves = () => {
        const found: number[] = []
        const step = 6 * 3_600_000
        let previous = offsetOf(Date.UTC(2024, 0, 1))
        for (let t = Date.UTC(2024, 0, 1) + step; t < Date.UTC(2028, 0, 1); t += step) {
            const offset = offsetOf(t)
            if (offset !== previous) found.push(t)
            previous = offset
        }
        return found
    }
    const dense = () =>
        moves().flatMap((moved) =>
            Array.from({ length: 241 }, (_, i) => moved - 3 * 3_600_000 + i * MINUTE),
        )

    test(`${zone}: keys, labels and ticks agree with the Date code`, () => {
        const times = [...grid(), ...dense()].sort((a, b) => a - b)
        const days = new Map<number, number>()
        const dayStarts = new Map<number, number>()
        const spans = new Map<string, string>()
        const spanKeys = new Map<string, string>()
        for (const [i, t] of times.entries()) {
            assert.equal(calendar.hourKey(t, host), legacy.hourStart(t), `hour ${t}`)
            assert.equal(calendar.minuteKey(t, host), legacy.minuteOf(t), `minute ${t}`)
            assert.equal(calendar.dateText(t, host), legacy.localDate(t), `date ${t}`)
            // A day is the same day exactly when the old day starts are the same.
            const key = calendar.dayKey(t, host)
            const start = legacy.dayStart(t)
            assert.equal(days.get(start) ?? key, key, `day key of ${start}`)
            assert.equal(dayStarts.get(key) ?? start, start, `day start of ${key}`)
            days.set(start, key)
            dayStarts.set(key, start)
            const span = calendar.spanKey(t, host)
            const old = legacy.spanOf(t)
            assert.equal(spans.get(old) ?? span, span, `span of ${old}`)
            assert.equal(spanKeys.get(span) ?? old, old, `old span of ${span}`)
            spans.set(old, span)
            spanKeys.set(span, old)
            const later = times[Math.min(times.length - 1, i + 1 + (i % 13) * 29)]!
            assert.equal(
                calendar.daysBetween(key, calendar.dayKey(later, host)),
                legacy.daysBefore(t, later),
                `days between ${t} and ${later}`,
            )
            assert.equal(calendar.sameDay(t, later, host), legacy.sameDay(t, later))
            assert.equal(calendar.sameYear(t, later, host), legacy.sameYear(t, later))
            if (i % 11 === 0) {
                for (const locale of ['en', 'fr', 'ja']) {
                    assert.equal(
                        dateTime.formatDateTime(locale, t, later, host),
                        dateTime.formatDateTime(locale, t, later),
                    )
                    assert.equal(
                        dateTime.formatEntryTime(locale, t, later, host),
                        dateTime.formatEntryTime(locale, t, later),
                    )
                    assert.equal(
                        dateTime.formatWhen(locale, t, later, host),
                        dateTime.formatWhen(locale, t, later),
                    )
                    assert.equal(
                        dateTime.formatClockRange(locale, t, later, host),
                        dateTime.formatClockRange(locale, t, later),
                    )
                }
                assert.equal(dateTime.formatHour('en', t, host), dateTime.formatHour('en', t))
            }
        }
    })

    test(`${zone}: the next boundary is the old tick less its second, and never later than it`, () => {
        const times = [...grid().filter((_, i) => i % 5 === 0), ...dense()]
        for (const t of times) {
            const boundary = calendar.nextBoundary(t, host)
            const old = legacy.tick(t)
            assert.ok(boundary > t, `after ${t}`)
            assert.ok(boundary <= old, `not after the old tick ${t}`)
            // Within an ordinary hour the two are the same instant, a second apart.
            if (offsetOf(t) === offsetOf(old) && offsetOf(t) === offsetOf(boundary))
                assert.equal(boundary, old - 1000, `ordinary hour at ${t}`)
            assert.notEqual(
                calendar.hourKey(boundary, host),
                calendar.hourKey(t, host),
                `hour changes at ${boundary}`,
            )
            assert.equal(calendar.hourKey(boundary - 1, host), calendar.hourKey(t, host))
        }
    })

    test(`${zone}: Yesterday is the previous key, as the old setDate(-1) was`, () => {
        for (const t of grid().filter((_, i) => i % 9 === 0)) {
            const before = new Date(t)
            before.setDate(before.getDate() - 1)
            // Today's previous date and the previous key name the same days.
            assert.equal(
                calendar.dayKey(before.getTime(), host),
                (calendar.dayKey(t, host) - 1) as ReturnType<typeof calendar.dayKey>,
                `yesterday of ${t}`,
            )
        }
    })
}
