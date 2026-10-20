import { i18n } from '../../i18n'
import { languageTag } from '../../i18n/plural'
import { formatClock, formatDate, formatHour } from '../../i18n/when'
import { settings } from '../../settings'
import { interpolateRaw } from '../../utils/interpolate'
import type { Header } from './rows'

// What a header says: "2:40 PM", "1 PM", "Yesterday · 9 PM", "Oct 2".

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

/** "Today", "Yesterday" or "Oct 14" (with the year in another year). */
export const dayLabel = (time: number, now = Date.now()) => {
    if (sameDay(time, now)) return i18n.value.history.today
    const before = new Date(now)
    before.setDate(before.getDate() - 1)
    return sameDay(time, before.getTime()) ? i18n.value.history.yesterday : formatDate(time, now)
}

/** A header's own label: its day, hour or minute. */
const ownLabel = (header: Header, now: number) =>
    header.level === 'day'
        ? dayLabel(header.time, now)
        : header.level === 'hour'
          ? formatHour(header.time)
          : formatClock(header.time)

export const headerText = (header: Header, now = Date.now()) =>
    header.withDay
        ? `${dayLabel(header.time, now)} · ${ownLabel(header, now)}`
        : ownLabel(header, now)

/** The pinned header's text: the header above the list's top, always with its day. */
export const pinnedText = (header: Header, now = Date.now()) =>
    header.level === 'day' || header.withDay
        ? headerText(header, now)
        : `${dayLabel(header.time, now)} · ${ownLabel(header, now)}`

const count = (value: number) => new Intl.NumberFormat(languageTag(settings.locale)).format(value)

/** "58 steps": Go To's counts. */
export const stepsText = (value: number) => interpolateRaw(i18n.value.history.steps, count(value))

/** "1,206 newer steps": the gap row after a jump. */
export const newerStepsText = (value: number) =>
    interpolateRaw(i18n.value.history.newerSteps, count(value))
