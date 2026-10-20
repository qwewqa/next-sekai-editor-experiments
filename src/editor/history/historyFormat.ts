import { dayNoon, resolveZone, type DayKey } from '../../calendar/calendar'
import {
    formatClock,
    formatClockRange,
    formatClockSeconds,
    formatCompactDateTime,
    formatDate,
    formatDateTime,
    formatDateTimeSeconds,
    formatEntryTime,
    formatHour,
} from '../../i18n/dateTime'
import type { Calendar } from './calendarClock'

// History's only way to write a date or time (I-1): every text comes from one `Calendar`, so a
// label, a bucket and a header always agree on the zone and on today.

export type HistoryFormat = {
    /** "2:41 PM". */
    clock: (at: number) => string
    /** "2:40:31 PM". */
    clockSeconds: (at: number) => string
    /** "1 PM". */
    hour: (at: number) => string
    /** "Oct 16, 2:41 PM", with the year in another year. */
    dateTime: (at: number) => string
    /** "Oct 14, 3:15:02 PM", with the year in another year. */
    dateTimeSeconds: (at: number) => string
    /** The time when it was today, the date and time otherwise. */
    entryTime: (at: number) => string
    /** "Oct 14", with the year in another year. */
    day: (day: DayKey) => string
    /** "2:10 – 2:41 PM". */
    clockRange: (from: number, to: number) => string
    /** The peek bar's narrow form ("10/20/26, 2:41 PM"): peekFit's compactDateTime, zoned. */
    compact: (at: number) => string
}

const UTC = resolveZone('UTC')

export const historyFormat = (cal: Calendar, locale: string): HistoryFormat => {
    const { zone, now } = cal
    return {
        clock: (at) => formatClock(locale, at, zone),
        clockSeconds: (at) => formatClockSeconds(locale, at, zone),
        hour: (at) => formatHour(locale, at, zone),
        dateTime: (at) => formatDateTime(locale, at, now, zone),
        dateTimeSeconds: (at) => formatDateTimeSeconds(locale, at, now, zone),
        entryTime: (at) => formatEntryTime(locale, at, now, zone),
        // A date has no instant: UTC noon of its numbers reads as that date in UTC, and the year is
        // compared with today's in UTC too.
        day: (day) => formatDate(locale, dayNoon(day), dayNoon(cal.today), UTC),
        clockRange: (from, to) => formatClockRange(locale, from, to, zone),
        compact: (at) => formatCompactDateTime(locale, at, zone),
    }
}
