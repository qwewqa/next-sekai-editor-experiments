import {
    TIME_LIMIT,
    sameDay as sameZoneDay,
    sameYear as sameZoneYear,
    type Zone,
} from '../calendar/calendar'
import { languageTag } from './plural'

// The one Intl helper for times and dates shown to the user (Part 1 §1.4.3, §1.3.4): the
// app locale's own format. A date from another year carries its year.
//
// Every export takes an optional last `zone`: a zone's own local time, from the History clock.
// Without one, the engine's zone is used, as it always was. Every export is total: a time outside
// the range a `Date` holds (±8.64e15) is taken to its nearest end, and NaN to 0, never an error.

const clampTime = (time: number) =>
    Number.isNaN(time) ? 0 : Math.min(TIME_LIMIT, Math.max(-TIME_LIMIT, time))

const formatters = new Map<string, Intl.DateTimeFormat>()

const formatter = (
    locale: string,
    key: string,
    options: Intl.DateTimeFormatOptions,
    zone?: Zone,
) => {
    const id = zone === undefined ? `${locale}/${key}` : `${locale}/${zone}/${key}`
    let found = formatters.get(id)
    if (!found)
        formatters.set(
            id,
            (found = new Intl.DateTimeFormat(
                languageTag(locale),
                zone === undefined ? options : { ...options, timeZone: zone },
            )),
        )
    return found
}

const sameYear = (a: number, b: number, zone?: Zone) =>
    zone === undefined
        ? new Date(a).getFullYear() === new Date(b).getFullYear()
        : sameZoneYear(a, b, zone)

const sameDay = (a: number, b: number, zone?: Zone) =>
    zone === undefined
        ? new Date(a).toDateString() === new Date(b).toDateString()
        : sameZoneDay(a, b, zone)

/** "Oct 15", or "Oct 15, 2025" in another year. */
export const formatDate = (locale: string, at: number, now = Date.now(), zone?: Zone) => {
    at = clampTime(at)
    now = clampTime(now)
    return sameYear(at, now, zone)
        ? formatter(locale, 'date', { month: 'short', day: 'numeric' }, zone).format(at)
        : formatter(
              locale,
              'dateYear',
              { year: 'numeric', month: 'short', day: 'numeric' },
              zone,
          ).format(at)
}

/**
 * A date inside a notice's sentence: "Oct 19" with its parts joined by no-break spaces, so a
 * narrow card never wraps between the month and the day. Not for file names.
 */
export const formatDateInSentence = (locale: string, at: number, now = Date.now(), zone?: Zone) =>
    formatDate(locale, at, now, zone).replaceAll(' ', '\u00A0')

/** "2:41 PM". */
export const formatClock = (locale: string, at: number, zone?: Zone) =>
    formatter(locale, 'clock', { hour: 'numeric', minute: '2-digit' }, zone).format(clampTime(at))

/** "2:40:31 PM": a History entry's time in the peek bar and Restore's notice (§1.4.10.3). */
export const formatClockSeconds = (locale: string, at: number, zone?: Zone) =>
    formatter(
        locale,
        'clockSeconds',
        {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
        },
        zone,
    ).format(clampTime(at))

/** "Oct 14, 3:15:02 PM", with the year in another year. */
export const formatDateTimeSeconds = (
    locale: string,
    at: number,
    now = Date.now(),
    zone?: Zone,
) => {
    at = clampTime(at)
    now = clampTime(now)
    const same = sameYear(at, now, zone)
    return formatter(
        locale,
        same ? 'dateTimeSeconds' : 'dateTimeYearSeconds',
        {
            ...(same ? {} : { year: 'numeric' }),
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
        },
        zone,
    ).format(at)
}

/** "Oct 16, 2:41 PM", with the year in another year. */
export const formatDateTime = (locale: string, at: number, now = Date.now(), zone?: Zone) => {
    at = clampTime(at)
    now = clampTime(now)
    return sameYear(at, now, zone)
        ? formatter(
              locale,
              'dateTime',
              {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
              },
              zone,
          ).format(at)
        : formatter(
              locale,
              'dateTimeYear',
              {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
              },
              zone,
          ).format(at)
}

/** The time when it was today ("2:41 PM"), the date otherwise ("Oct 14"): a file event's time. */
export const formatWhen = (locale: string, at: number, now = Date.now(), zone?: Zone) =>
    sameDay(clampTime(at), clampTime(now), zone)
        ? formatClock(locale, at, zone)
        : formatDate(locale, at, now, zone)

/** An entry's time to the second: the time when it was today, the date and time otherwise. */
export const formatEntryTime = (locale: string, at: number, now = Date.now(), zone?: Zone) =>
    sameDay(clampTime(at), clampTime(now), zone)
        ? formatClockSeconds(locale, at, zone)
        : formatDateTimeSeconds(locale, at, now, zone)

/** "1 PM": an hour header's label. */
export const formatHour = (locale: string, at: number, zone?: Zone) =>
    formatter(locale, 'hour', { hour: 'numeric' }, zone).format(clampTime(at))

/**
 * "2:10 – 2:41 PM": a session's stretch of a day in Go To. The two times may come in either order
 * (a system clock change makes the oldest entry later than the newest); the earlier one goes
 * first. A time that cannot be formatted gives an empty text, never an error.
 */
export const formatClockRange = (locale: string, from: number, to: number, zone?: Zone) => {
    if (Number.isNaN(from) || Number.isNaN(to)) return ''
    try {
        return formatter(locale, 'clock', { hour: 'numeric', minute: '2-digit' }, zone).formatRange(
            clampTime(Math.min(from, to)),
            clampTime(Math.max(from, to)),
        )
    } catch {
        return ''
    }
}

/** "10/20/26, 2:41 PM": the peek bar's narrow form, with a two-digit year. */
export const formatCompactDateTime = (locale: string, at: number, zone?: Zone) =>
    formatter(
        locale,
        'compact',
        {
            year: '2-digit',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        },
        zone,
    ).format(clampTime(at))
