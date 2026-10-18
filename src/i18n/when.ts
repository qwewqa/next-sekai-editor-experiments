import { settings } from '../settings'
import * as dateTime from './dateTime'

// The date and time helpers in the app locale.

export const formatDate = (at: number) => dateTime.formatDate(settings.locale, at)

export const formatClock = (at: number) => dateTime.formatClock(settings.locale, at)

export const formatDateTime = (at: number) => dateTime.formatDateTime(settings.locale, at)

export const formatWhen = (at: number) => dateTime.formatWhen(settings.locale, at)

export const formatClockSeconds = (at: number) => dateTime.formatClockSeconds(settings.locale, at)

export const formatDateTimeSeconds = (at: number) =>
    dateTime.formatDateTimeSeconds(settings.locale, at)

/** An entry's time to the second: the time when it was today, the date and time otherwise. */
export const formatEntryTime = (at: number) => dateTime.formatEntryTime(settings.locale, at)
