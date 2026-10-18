import { settings } from '../settings'
import * as dateTime from './dateTime'

// The date and time helpers in the app locale.

export const formatDate = (at: number) => dateTime.formatDate(settings.locale, at)

export const formatClock = (at: number) => dateTime.formatClock(settings.locale, at)

export const formatDateTime = (at: number) => dateTime.formatDateTime(settings.locale, at)

export const formatWhen = (at: number) => dateTime.formatWhen(settings.locale, at)
