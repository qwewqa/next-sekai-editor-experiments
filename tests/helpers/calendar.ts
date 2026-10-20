import { hostZone, resolveZone } from '../../src/calendar/calendar'
import { calendarAt } from '../../src/editor/history/calendarClock'

// The History calendar for a test: a time, and the host's zone (the one a test sets with TZ) or a
// named one.

export const hostCalendar = (now: number) => calendarAt(now, hostZone())

export const calendarIn = (now: number, zone: string) => calendarAt(now, resolveZone(zone))
