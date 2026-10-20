import { dateText, hostZone } from '../calendar/calendar'
import { readMeta, writeMeta } from './db'
import type { KvTx } from './kv/types'

// Days of use (Part 1 §1.6.8.7): `meta.daysOfUse` goes up by one at most once per calendar day,
// the local date of monotonic `now`, on which the editor is used. Rows stamp `day` with it, and
// "within the past N days" means `daysOfUse - day < N`, so a clock that jumps can't expire
// anything early.

/**
 * A count of days of use: what `meta.daysOfUse` and every row's `day` hold. It is not a calendar
 * day (`DayKey`), so the two can't be mixed up: retention counts `UseDay`s, ages shown to the user
 * count `DayKey`s. Only `countDayOfUse`, `NO_USE_DAY` and the row types make one (I-11; the
 * `local/no-local-time` rule bans `as UseDay` elsewhere).
 */
export type UseDay = number & { readonly __useDay: true }

/** No day of use yet: a new database's `daysOfUse`. */
export const NO_USE_DAY = 0 as UseDay

/**
 * Counts `now`'s day as a day of use once, inside a read-write transaction over `meta`; returns
 * the day rows written now are stamped with. A `now` dated before the last day counted (a clock
 * set back) counts nothing until the clock passes it again.
 */
export const countDayOfUse = async (tx: KvTx, now: number): Promise<UseDay> => {
    const days = (await readMeta(tx, 'daysOfUse')) ?? NO_USE_DAY
    const last = (await readMeta(tx, 'lastUseDate')) ?? ''
    const today = dateText(now, hostZone())
    if (today <= last) return days
    const next = (days + 1) as UseDay
    await writeMeta(tx, 'daysOfUse', next)
    await writeMeta(tx, 'lastUseDate', today)
    return next
}
