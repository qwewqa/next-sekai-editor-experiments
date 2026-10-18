import { languageTag } from './plural'

// The one Intl helper for times and dates shown to the user (Part 1 §1.4.3, §1.3.4): the
// app locale's own format. A date from another year carries its year.

const formatters = new Map<string, Intl.DateTimeFormat>()

const formatter = (locale: string, key: string, options: Intl.DateTimeFormatOptions) => {
    const id = `${locale}/${key}`
    let found = formatters.get(id)
    if (!found) formatters.set(id, (found = new Intl.DateTimeFormat(languageTag(locale), options)))
    return found
}

const sameYear = (a: number, b: number) => new Date(a).getFullYear() === new Date(b).getFullYear()

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

/** "Oct 15", or "Oct 15, 2025" in another year. */
export const formatDate = (locale: string, at: number, now = Date.now()) =>
    sameYear(at, now)
        ? formatter(locale, 'date', { month: 'short', day: 'numeric' }).format(at)
        : formatter(locale, 'dateYear', { year: 'numeric', month: 'short', day: 'numeric' }).format(
              at,
          )

/** "2:41 PM". */
export const formatClock = (locale: string, at: number) =>
    formatter(locale, 'clock', { hour: 'numeric', minute: '2-digit' }).format(at)

/** "Oct 16, 2:41 PM", with the year in another year. */
export const formatDateTime = (locale: string, at: number, now = Date.now()) =>
    sameYear(at, now)
        ? formatter(locale, 'dateTime', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
          }).format(at)
        : formatter(locale, 'dateTimeYear', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
          }).format(at)

/** The time when it was today ("2:41 PM"), the date otherwise ("Oct 14"): a file event's time. */
export const formatWhen = (locale: string, at: number, now = Date.now()) =>
    sameDay(at, now) ? formatClock(locale, at) : formatDate(locale, at, now)
