import type { DayKey } from '../../calendar/calendar'
import { i18n } from '../../i18n'
import { settings } from '../../settings'
import { interpolateRaw } from '../../utils/interpolate'
import { formatCount } from '../../utils/size'
import type { Calendar } from './calendarClock'
import { historyFormat } from './historyFormat'
import type { Header } from './rows'

// What a header says: "2:40 PM", "1 PM", "Yesterday · 9 PM", "Oct 2".

/** "Today", "Yesterday" or "Oct 14" (with the year in another year), by the calendar's days. */
export const dayLabel = (day: DayKey, cal: Calendar) => {
    if (day === cal.today) return i18n.value.history.today
    if (day === cal.today - 1) return i18n.value.history.yesterday
    return historyFormat(cal, settings.locale).day(day)
}

/** A header's own label: its day, hour or minute. */
const ownLabel = (header: Header, cal: Calendar) => {
    const format = historyFormat(cal, settings.locale)
    return header.level === 'day'
        ? dayLabel(header.day, cal)
        : header.level === 'hour'
          ? format.hour(header.time)
          : format.clock(header.time)
}

export const headerText = (header: Header, cal: Calendar) =>
    header.withDay
        ? `${dayLabel(header.day, cal)} · ${ownLabel(header, cal)}`
        : ownLabel(header, cal)

/** The pinned header's text: the header above the list's top, always with its day. */
export const pinnedText = (header: Header, cal: Calendar) =>
    header.level === 'day' || header.withDay
        ? headerText(header, cal)
        : `${dayLabel(header.day, cal)} · ${ownLabel(header, cal)}`

const count = (value: number) => formatCount(value)

/** "58 steps": Go To's counts. */
export const stepsText = (value: number) => interpolateRaw(i18n.value.history.steps, count(value))

/** "1,206 newer steps": the gap row after a jump. */
export const newerStepsText = (value: number) =>
    interpolateRaw(i18n.value.history.newerSteps, count(value))
