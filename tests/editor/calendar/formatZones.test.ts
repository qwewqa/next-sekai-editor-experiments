import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { dayKey, resolveZone } from '../../../src/calendar/calendar'
import { calendarAt } from '../../../src/editor/history/calendarClock'
import { historyFormat } from '../../../src/editor/history/historyFormat'
import { peekText } from '../../../src/editor/history/peekFit'
import { operationTime } from '../../../src/history/operationPresentation/format'
import type { OperationStrings } from '../../../src/history/operationPresentation/types'
import * as dateTime from '../../../src/i18n/dateTime'

// Every text History writes comes from one calendar's zone. The Intl formatters are cached, so
// each is run in one zone, then another, then the first again, with the cache warm. The host runs
// in Kiritimati (UTC+14), so a text in the engine's zone cannot pass for either.
process.env.TZ = 'Pacific/Kiritimati'

const newYork = resolveZone('America/New_York')
const tokyo = resolveZone('Asia/Tokyo')
const kathmandu = resolveZone('Asia/Kathmandu')

// 2026-10-20 18:41:07 UTC: 2:41:07 PM in New York, 03:41:07 on the 21st in Tokyo.
const at = Date.UTC(2026, 9, 20, 18, 41, 7)
const nbsp = (text: string) => text.replace(/[\u202f\u00a0\u2009]/g, ' ')

const strings = JSON.parse(
    readFileSync(new URL('../../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as OperationStrings

type Expected = Record<string, string>
const expectations = (zone: typeof newYork): Expected =>
    zone === newYork
        ? {
              clock: '2:41 PM',
              clockSeconds: '2:41:07 PM',
              hour: '2 PM',
              dateTime: 'Oct 20, 2:41 PM',
              dateTimeSeconds: 'Oct 20, 2:41:07 PM',
              entryTime: '2:41:07 PM',
              day: 'Oct 20',
              clockRange: '2:41 – 2:56 PM',
              compact: '10/20/26, 2:41 PM',
          }
        : {
              clock: '3:41 AM',
              clockSeconds: '3:41:07 AM',
              hour: '3 AM',
              dateTime: 'Oct 21, 3:41 AM',
              dateTimeSeconds: 'Oct 21, 3:41:07 AM',
              entryTime: '3:41:07 AM',
              day: 'Oct 21',
              clockRange: '3:41 – 3:56 AM',
              compact: '10/21/26, 3:41 AM',
          }

const textsOf = (zone: typeof newYork) => {
    // The calendar's clock is the entry's own moment, so an entry time is a clock time.
    const format = historyFormat(calendarAt(at + 5 * 60_000, zone), 'en')
    return {
        clock: format.clock(at),
        clockSeconds: format.clockSeconds(at),
        hour: format.hour(at),
        dateTime: format.dateTime(at),
        dateTimeSeconds: format.dateTimeSeconds(at),
        entryTime: format.entryTime(at),
        day: format.day(dayKey(at, zone)),
        clockRange: format.clockRange(at, at + 15 * 60_000),
        compact: format.compact(at),
    }
}

test('every history format follows the calendar’s zone, with the cache warm, and not the engine’s', () => {
    // New York, Tokyo, New York again, Tokyo again: a formatter cached for one zone must not be
    // reused for the other.
    for (const zone of [newYork, tokyo, newYork, tokyo, newYork]) {
        const texts = textsOf(zone)
        for (const [name, expected] of Object.entries(expectations(zone)))
            assert.equal(nbsp(texts[name as keyof typeof texts]), expected, `${zone} ${name}`)
    }
})

test('an entry from another day carries its date, and another year its year, in the calendar’s zone', () => {
    const newer = calendarAt(Date.UTC(2026, 9, 25, 12), newYork)
    const format = historyFormat(newer, 'en')
    assert.equal(nbsp(format.entryTime(at)), 'Oct 20, 2:41:07 PM')
    assert.equal(nbsp(format.dateTime(Date.UTC(2025, 5, 1, 12))), 'Jun 1, 2025, 8:00 AM')
    // Today is the clock's date in the zone: 03:41 on the 21st is Tokyo's day, New York's evening.
    const tokyoToday = historyFormat(calendarAt(at, tokyo), 'en')
    assert.equal(nbsp(tokyoToday.entryTime(at)), '3:41:07 AM')
    assert.equal(nbsp(tokyoToday.entryTime(at - 4 * 3_600_000)), 'Oct 20, 11:41:07 PM')
    // The same two instants in New York are on one day.
    const nyToday = historyFormat(calendarAt(at, newYork), 'en')
    assert.equal(nbsp(nyToday.entryTime(at - 4 * 3_600_000)), '10:41:07 AM')
})

test('a zone that is not on the hour keeps its half and quarter hours', () => {
    const format = historyFormat(calendarAt(at, kathmandu), 'en')
    // 18:41:07Z is 00:26:07 on the 21st in Nepal (+5:45).
    assert.equal(nbsp(format.clockSeconds(at)), '12:26:07 AM')
    assert.equal(nbsp(format.hour(at)), '12 AM')
    assert.equal(format.day(dayKey(at, kathmandu)), 'Oct 21')
})

test('the peek bar’s text follows the calendar’s zone in each of its three forms', () => {
    // 09:00Z: Oct 20 in New York (5 AM), and in Tokyo (6 PM), Oct 20 23:00 on the Kiritimati host.
    const now = Date.UTC(2026, 9, 20, 9, 0, 0)
    for (const zone of [newYork, tokyo, newYork]) {
        const cal = calendarAt(now, zone)
        const today = nbsp(peekText(cal, 'en', at, true))
        const earlier = nbsp(peekText(cal, 'en', Date.UTC(2026, 2, 3, 21, 5, 7), true))
        const narrow = nbsp(peekText(cal, 'en', Date.UTC(2026, 2, 3, 21, 5, 7), false))
        const year = nbsp(peekText(cal, 'en', Date.UTC(2025, 2, 3, 21, 5, 7), true))
        if (zone === newYork) {
            assert.equal(today, '2:41:07 PM')
            assert.equal(earlier, 'Mar 3, 4:05:07 PM')
            assert.equal(narrow, '3/3/26, 4:05 PM')
            assert.equal(year, '3/3/25, 4:05 PM')
        } else {
            // Tokyo is on the 20th, and the entry is on the 21st.
            assert.equal(today, 'Oct 21, 3:41:07 AM')
            assert.equal(earlier, 'Mar 4, 6:05:07 AM')
            assert.equal(narrow, '3/4/26, 6:05 AM')
            assert.equal(year, '3/4/25, 6:05 AM')
        }
    }
})

test('the peek bar’s year follows the calendar’s zone at New Year', () => {
    // 2026-01-01 03:00Z is still 2025 in New York (10 PM on Dec 31) and 2026 in Tokyo (noon, Jan 1);
    // the Kiritimati host is on Jan 1 2026 (5 PM).
    const entry = Date.UTC(2026, 0, 1, 3, 0, 0)
    const now = Date.UTC(2026, 5, 1, 12)
    assert.equal(nbsp(peekText(calendarAt(now, newYork), 'en', entry, true)), '12/31/25, 10:00 PM')
    assert.equal(nbsp(peekText(calendarAt(now, tokyo), 'en', entry, true)), 'Jan 1, 12:00:00 PM')
})

test('operation times follow the context’s zone, and a time beyond the domain still reads', () => {
    for (const zone of [newYork, tokyo, newYork]) {
        const context = { locale: 'en', strings, now: at, zone }
        assert.equal(
            nbsp(operationTime(at, context)),
            zone === newYork ? 'Oct 20, 2:41:07 PM' : 'Oct 21, 3:41:07 AM',
        )
    }
    const utc = resolveZone('UTC')
    const context = { locale: 'en', strings, now: 0, zone: utc }
    assert.match(operationTime(8.64e15 + 1, context), /Sep 13/)
    assert.match(operationTime(Number.NaN, context), /^Jan 1,/)
})

test('the zone is the last parameter, and leaving it out keeps the engine’s zone', () => {
    // The host is in Kiritimati: 18:41:07Z is 08:41:07 on the 21st there.
    assert.equal(nbsp(dateTime.formatClockSeconds('en', at)), '8:41:07 AM')
    assert.equal(nbsp(dateTime.formatClockSeconds('en', at, newYork)), '2:41:07 PM')
    assert.equal(nbsp(dateTime.formatClockSeconds('en', at)), '8:41:07 AM', 'warm cache, no zone')
    assert.equal(nbsp(dateTime.formatDateTime('en', at, at)), 'Oct 21, 8:41 AM')
    assert.equal(nbsp(dateTime.formatDateTime('en', at, at, newYork)), 'Oct 20, 2:41 PM')
    assert.equal(nbsp(dateTime.formatEntryTime('en', at, at + 3_600_000)), '8:41:07 AM')
    assert.equal(nbsp(dateTime.formatWhen('en', at, at + 86_400_000)), 'Oct 21')
    assert.equal(nbsp(dateTime.formatWhen('en', at, at + 86_400_000, newYork)), 'Oct 20')
})

test('a day names its own date in a zone at +13 or +14, where UTC noon is the next local date', () => {
    // 2026-10-20 18:41Z is Oct 21 in Kiritimati (UTC+14) and Tongatapu (UTC+13), and Oct 20 in UTC.
    for (const name of ['Pacific/Kiritimati', 'Pacific/Tongatapu']) {
        const zone = resolveZone(name)
        const format = historyFormat(calendarAt(at, zone), 'en')
        assert.equal(format.day(dayKey(at, zone)), 'Oct 21', name)
        assert.equal(
            format.day((dayKey(at, zone) - 1) as ReturnType<typeof dayKey>),
            'Oct 20',
            name,
        )
    }
    // And a zone at -11 reads the date the other way.
    const samoa = resolveZone('Pacific/Pago_Pago')
    assert.equal(historyFormat(calendarAt(at, samoa), 'en').day(dayKey(at, samoa)), 'Oct 20')
})

test('a day carries its year when it is not the calendar’s year, including the day before 1970', () => {
    const now = Date.UTC(2026, 5, 1, 12)
    const zone = resolveZone('Pacific/Kiritimati')
    const format = historyFormat(calendarAt(now, zone), 'en')
    // 2025-12-31 12:00Z is Jan 1, 2026 at 02:00 in Kiritimati: this year.
    assert.equal(format.day(dayKey(Date.UTC(2025, 11, 31, 12), zone)), 'Jan 1')
    assert.equal(format.day(dayKey(Date.UTC(2025, 11, 31, 9), zone)), 'Dec 31, 2025')
    // Time 0 west of UTC is Dec 31, 1969: its header is not Jan 1, 1970.
    assert.equal(format.day(dayKey(0, newYork)), 'Dec 31, 1969')
})

test('the year check follows the calendar’s zone for every dated text, not the engine’s', () => {
    // 2026-01-01 03:00Z is still 2025 in New York (10 PM on Dec 31); the Kiritimati host is in 2026.
    const entry = Date.UTC(2026, 0, 1, 3, 0, 0)
    const now = Date.UTC(2026, 5, 1, 12)
    assert.equal(nbsp(dateTime.formatDate('en', entry, now, newYork)), 'Dec 31, 2025')
    assert.equal(nbsp(dateTime.formatDateTime('en', entry, now, newYork)), 'Dec 31, 2025, 10:00 PM')
    assert.equal(
        nbsp(dateTime.formatDateTimeSeconds('en', entry, now, newYork)),
        'Dec 31, 2025, 10:00:00 PM',
    )
    assert.equal(
        nbsp(dateTime.formatEntryTime('en', entry, now, newYork)),
        'Dec 31, 2025, 10:00:00 PM',
    )
    // The other way: a New York year-end that is already 2026 in Tokyo.
    assert.equal(nbsp(dateTime.formatDate('en', entry, now, tokyo)), 'Jan 1')
    assert.equal(nbsp(dateTime.formatDateTime('en', entry, now, tokyo)), 'Jan 1, 12:00 PM')
    // And a "now" in 2025 in New York (2026-01-01 03:00Z) against an entry from the same instant.
    assert.equal(nbsp(dateTime.formatDateTime('en', entry, entry, newYork)), 'Dec 31, 10:00 PM')
})
