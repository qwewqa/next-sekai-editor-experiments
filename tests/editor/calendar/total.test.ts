import assert from 'node:assert/strict'
import test from 'node:test'
import {
    clampToDomain,
    dateText,
    dayKey,
    daysBetween,
    fieldsOf,
    hostZone,
    hourKey,
    minuteKey,
    nextBoundary,
    resolveZone,
    sameDay,
    sameYear,
    spanKey,
    TIME_LIMIT,
    yearOfDay,
} from '../../../src/calendar/calendar'
import * as dateTime from '../../../src/i18n/dateTime'

// I-7: every calendar and date-text function returns a value for any number and any zone. A time
// outside [0, 8.64e15] is taken to the nearest end of it, and a zone the engine rejects is UTC.

const times = [
    -Infinity,
    -1e300,
    -TIME_LIMIT - 1,
    -86_400_000,
    -1,
    -0.5,
    0,
    0.5,
    1,
    999,
    1_700_000_000_000,
    Number.MAX_SAFE_INTEGER,
    TIME_LIMIT - 1,
    TIME_LIMIT,
    TIME_LIMIT + 1,
    1e300,
    Infinity,
    Number.NaN,
]
const zoneNames: unknown[] = [
    'UTC',
    'America/New_York',
    'Asia/Kathmandu',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
    'Africa/Monrovia',
    'Not/A_Zone',
    '',
    ' ',
    'x'.repeat(300),
    undefined,
    null,
    7,
    {},
]

test('a time outside the domain is clamped, and NaN is the start', () => {
    assert.equal(clampToDomain(-1), 0)
    assert.equal(clampToDomain(Number.NaN), 0)
    assert.equal(clampToDomain(-Infinity), 0)
    assert.equal(clampToDomain(Infinity), TIME_LIMIT)
    assert.equal(clampToDomain(TIME_LIMIT + 1), TIME_LIMIT)
    assert.equal(clampToDomain(12.5), 12.5)
    assert.equal(TIME_LIMIT, new Date(TIME_LIMIT).getTime())
    assert.ok(Number.isNaN(new Date(TIME_LIMIT + 1).getTime()))
})

test('a rejected zone is UTC, whatever the caller', () => {
    for (const name of ['Not/A_Zone', '', ' ', 'x'.repeat(300), undefined, null, 7, {}])
        assert.equal(resolveZone(name), 'UTC', String(name))
    assert.equal(resolveZone('America/New_York'), 'America/New_York')
    // The page and the worker both resolve the one name, so they read the same zone.
    assert.equal(resolveZone('Not/A_Zone'), resolveZone(resolveZone('Not/A_Zone')))
    // A rejected zone reads exactly as UTC.
    const t = Date.UTC(2026, 9, 20, 18, 41, 7)
    assert.deepEqual(fieldsOf(t, resolveZone('Not/A_Zone')), fieldsOf(t, resolveZone('UTC')))
})

test('every calendar function returns a number or text for every time and zone', () => {
    for (const name of zoneNames) {
        const zone = resolveZone(name)
        for (const time of times) {
            const where = `${String(name)} @ ${time}`
            const fields = fieldsOf(time, zone)
            for (const value of Object.values(fields))
                assert.ok(Number.isInteger(value), `${where}: a field is ${value}`)
            const day = dayKey(time, zone)
            const hour = hourKey(time, zone)
            assert.ok(Number.isInteger(day), `${where}: day`)
            assert.ok(Number.isFinite(hour), `${where}: hour`)
            assert.ok(hour <= clampToDomain(time), `${where}: hour after the time`)
            assert.ok(Number.isFinite(minuteKey(time, zone)), `${where}: minute`)
            assert.match(spanKey(time, zone), /^-?\d+\|-?\d+$/, where)
            assert.match(dateText(time, zone), /^\d{4,6}-\d\d-\d\d$/, where)
            assert.ok(Number.isInteger(yearOfDay(day)), where)
            assert.equal(daysBetween(day, day), 0)
            assert.equal(sameDay(time, time, zone), true)
            assert.equal(sameYear(time, time, zone), true)
            const boundary = nextBoundary(time, zone)
            assert.ok(Number.isFinite(boundary), `${where}: boundary`)
            assert.ok(boundary >= clampToDomain(time), `${where}: boundary before the time`)
            assert.ok(boundary <= TIME_LIMIT, `${where}: boundary past the domain`)
        }
    }
})

test('the first and the last instants read as dates', () => {
    const utc = resolveZone('UTC')
    assert.equal(dateText(0, utc), '1970-01-01')
    assert.equal(dateText(TIME_LIMIT, utc), '275760-09-13')
    assert.equal(dateText(-5, utc), '1970-01-01')
    assert.equal(dateText(TIME_LIMIT * 2, utc), '275760-09-13')
    // West of UTC the start of the epoch is the day before.
    const west = resolveZone('Pacific/Pago_Pago')
    assert.equal(dateText(0, west), '1969-12-31')
})

test('the end of the domain is its own next boundary, and a time before it is not', () => {
    const utc = resolveZone('UTC')
    assert.equal(nextBoundary(TIME_LIMIT, utc), TIME_LIMIT)
    assert.equal(nextBoundary(Infinity, utc), TIME_LIMIT)
    assert.ok(nextBoundary(TIME_LIMIT - 1, utc) <= TIME_LIMIT)
    assert.equal(nextBoundary(0, utc), 3_600_000)
})

test('every date-text export formats every time and zone without throwing', () => {
    for (const name of zoneNames) {
        const zone = resolveZone(name)
        for (const time of times) {
            for (const now of [0, Date.now(), TIME_LIMIT, Number.NaN]) {
                const where = `${String(name)} @ ${time} (${now})`
                const texts = [
                    dateTime.formatDate('en', time, now, zone),
                    dateTime.formatDateInSentence('en', time, now, zone),
                    dateTime.formatClock('en', time, zone),
                    dateTime.formatClockSeconds('en', time, zone),
                    dateTime.formatDateTimeSeconds('en', time, now, zone),
                    dateTime.formatDateTime('en', time, now, zone),
                    dateTime.formatWhen('en', time, now, zone),
                    dateTime.formatEntryTime('en', time, now, zone),
                    dateTime.formatHour('en', time, zone),
                    dateTime.formatCompactDateTime('en', time, zone),
                    dateTime.formatClockRange('en', time, now, zone),
                ]
                for (const text of texts) assert.equal(typeof text, 'string', where)
                // Not "Invalid Date": a value that cannot be a time never reaches the formatter.
                for (const text of texts) assert.doesNotMatch(text, /Invalid/, where)
            }
            // Without a zone the engine's zone is used, and the result is as total.
            assert.equal(typeof dateTime.formatDateTime('en', time, Date.now()), 'string')
            assert.equal(typeof dateTime.formatEntryTime('en', time, Date.now()), 'string')
        }
    }
})

test('a time beyond the domain reads as the latest date, not as an error', () => {
    const utc = resolveZone('UTC')
    assert.equal(
        dateTime.formatDateTime('en', TIME_LIMIT + 1, TIME_LIMIT, utc),
        dateTime.formatDateTime('en', TIME_LIMIT, TIME_LIMIT, utc),
    )
    assert.match(dateTime.formatDateTime('en', TIME_LIMIT, TIME_LIMIT, utc), /Sep 13/)
})

test('Monrovia before 1972, 44 minutes and 30 seconds behind UTC, is read to the second', () => {
    const zone = resolveZone('Africa/Monrovia')
    // 12:00:00 UTC on 1971-01-01 is 11:15:30 there.
    const noon = Date.UTC(1971, 0, 1, 12, 0, 0)
    const f = fieldsOf(noon, zone)
    assert.deepEqual([f.hour, f.minute, f.second], [11, 15, 30])
    // The same UTC minute, seconds apart, reads through the offset, whatever was asked before.
    for (const [second, expected] of [
        [0, [11, 15, 30]],
        [15, [11, 15, 45]],
        [29, [11, 15, 59]],
        [30, [11, 16, 0]],
        [59, [11, 16, 29]],
    ] as const) {
        const g = fieldsOf(noon + second * 1000, zone)
        assert.deepEqual([g.hour, g.minute, g.second], expected, `+${second} s`)
    }
    // The hour starts where the clock shows 11:00:00, 15 minutes 30 seconds before.
    assert.equal(hourKey(noon, zone), noon - (15 * 60 + 30) * 1000)
    assert.equal(fieldsOf(hourKey(noon, zone), zone).minute, 0)
    assert.equal(fieldsOf(hourKey(noon, zone), zone).second, 0)
    // A minute starts where the seconds read 0.
    assert.equal(minuteKey(noon, zone), Math.floor((noon - 30_000) / 60_000))
    // After 1972 it is GMT, and minutes follow UTC's again.
    const later = Date.UTC(1975, 5, 1, 12, 0, 30)
    assert.equal(fieldsOf(later, zone).second, 30)
    assert.equal(hourKey(later, zone), Date.UTC(1975, 5, 1, 12, 0, 0))
})

test('the host zone is read fresh on every call', () => {
    const before = process.env.TZ
    try {
        process.env.TZ = 'Asia/Tokyo'
        assert.equal(hostZone(), 'Asia/Tokyo')
        process.env.TZ = 'America/New_York'
        assert.equal(hostZone(), 'America/New_York')
        process.env.TZ = 'Pacific/Kiritimati'
        assert.equal(hostZone(), 'Pacific/Kiritimati')
    } finally {
        if (before === undefined) delete process.env.TZ
        else process.env.TZ = before
    }
})

test('outside History a time before 1970 still reads as itself, as it did', () => {
    const before = process.env.TZ
    try {
        process.env.TZ = 'America/New_York'
        // Noon UTC on 1968-11-26: that date in every zone from UTC-11 to UTC+11, so the check holds
        // whichever zone a formatter created earlier in this process captured (CI runs in UTC).
        const old = Date.UTC(1968, 10, 26, 12)
        const now = Date.UTC(2026, 0, 1)
        assert.equal(dateTime.formatDate('en', old, now), 'Nov 26, 1968')
        assert.match(dateTime.formatDateTime('en', old, now), /^Nov 26, 1968/)
        assert.match(dateTime.formatClockSeconds('en', old), /:\d\d:\d\d/)
        // The range is that of a Date, in both directions.
        assert.equal(
            dateTime.formatDate('en', -TIME_LIMIT - 1, now),
            dateTime.formatDate('en', -TIME_LIMIT, now),
        )
    } finally {
        if (before === undefined) delete process.env.TZ
        else process.env.TZ = before
    }
})
